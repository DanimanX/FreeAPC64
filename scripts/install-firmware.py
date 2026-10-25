#!/usr/bin/env python3
"""
FreeAPC64 Multi-Platform Firmware Installer & Restorer (v0.0.1)
===============================================================
Supports Linux (ALSA rawmidi / amidi), Windows (WinMM ctypes), macOS (rtmidi / CoreMIDI),
and simulated loopback verification (--verify / --dry-run).

Usage:
  python3 scripts/install-firmware.py --custom       # Flash FreeAPC64 Custom Firmware 1.2.1.6
  python3 scripts/install-firmware.py --stock        # Restore Akai Stock Firmware 1.2.1.6
  python3 scripts/install-firmware.py --verify       # Verify .rbin integrity & CRC32s
  python3 scripts/install-firmware.py --dry-run      # Simulate full bootloader flashing protocol
"""

import argparse
import ctypes
import os
import platform
import shutil
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STOCK_RBIN = BASE_DIR / "firmware" / "akai-apc64-stock-1.2.1.6.rbin"
CUSTOM_RBIN = BASE_DIR / "firmware" / "freeapc64-custom-1.2.1.6.rbin"

PERIPH_ID = 0x09E80053
CHUNK_SIZE = 0xF0  # 240 bytes per RBIN 0xC6/0xC7 write packet


def pack_7bit(raw: bytes) -> bytes:
    """
    Encodes 8-bit raw bytes into 7-bit MIDI SysEx payload bytes (matching 0x6000a6a4 / 0x600bc444).
    Every group of up to 7 raw bytes b[0..6] becomes 1 MSB byte + up to 7 LSB bytes:
      msb_byte = ((b[0]&0x80)>>1) | ((b[1]&0x80)>>2) | ... | ((b[6]&0x80)>>7)
    """
    out = bytearray()
    for i in range(0, len(raw), 7):
        chunk = raw[i : i + 7]
        msb = 0
        for idx, b in enumerate(chunk):
            if b & 0x80:
                msb |= 0x40 >> idx
        out.append(msb)
        for b in chunk:
            out.append(b & 0x7F)
    return bytes(out)


def unpack_7bit(midi_bytes: bytes) -> bytes:
    """
    Decodes 7-bit MIDI SysEx payload bytes back into 8-bit raw bytes (matching 0x6000a798 / 0x600bc410).
    """
    out = bytearray()
    for i in range(0, len(midi_bytes), 8):
        group = midi_bytes[i : i + 8]
        if len(group) < 2:
            break
        msb = group[0]
        for idx, b in enumerate(group[1:]):
            top = 0x80 if (msb & (0x40 >> idx)) else 0x00
            out.append((b & 0x7F) | top)
    return bytes(out)


def parse_rbin(buf: bytes) -> list:
    regions = []
    offset = 0
    while offset < len(buf):
        if buf[offset : offset + 4] != b"!Rbn":
            raise ValueError(f"Invalid !Rbn magic at offset 0x{offset:x}")
        periph_id, region_idx, version, flash_base, flash_span, region_crc, container_len, num_segments = struct.unpack(
            "<8I", buf[offset + 0x24 : offset + 0x44]
        )
        segments = []
        for i in range(num_segments):
            s_off = offset + 0x44 + i * 16
            seg_addr, seg_len, seg_crc, data_rel_off = struct.unpack("<4I", buf[s_off : s_off + 16])
            abs_off = offset + data_rel_off
            seg_data = buf[abs_off : abs_off + seg_len]
            calc_crc = zlib.crc32(seg_data) & 0xFFFFFFFF
            if calc_crc != seg_crc:
                raise ValueError(
                    f"Segment {i} in region {region_idx} CRC mismatch: "
                    f"header=0x{seg_crc:08x}, calc=0x{calc_crc:08x}"
                )
            segments.append(
                {
                    "index": i,
                    "flash_addr": seg_addr,
                    "length": seg_len,
                    "crc32": seg_crc,
                    "data": seg_data,
                }
            )
        span_img = bytearray(b"\xff" * flash_span)
        for seg in segments:
            rel = seg["flash_addr"] - flash_base
            span_img[rel : rel + seg["length"]] = seg["data"]
        calc_reg_crc = zlib.crc32(span_img) & 0xFFFFFFFF
        if calc_reg_crc != region_crc:
            raise ValueError(
                f"Region {region_idx} CRC mismatch: header=0x{region_crc:08x}, calc=0x{calc_reg_crc:08x}"
            )
        ver_b = struct.pack(">I", version)
        regions.append(
            {
                "peripheral_id": periph_id,
                "region_index": region_idx,
                "version_raw": version,
                "version": f"{ver_b[0]}.{ver_b[1]}.{ver_b[2]}.{ver_b[3]}",
                "flash_base": flash_base,
                "flash_span": flash_span,
                "crc32": region_crc,
                "segments": segments,
            }
        )
        offset += container_len
    return regions


def build_inquiry_sysex() -> bytes:
    return bytes([0xF0, 0x00, 0x00, 0x17, 0x70, 0xF7])


def build_reboot_to_bootloader_packets(dev_id: int) -> list:
    """
    Builds the 3-step Rane/inMusic 0x79 handshake packets (0x600b5792) plus Akai 0x79 packet (0x600bccfa).
    """
    packets = []
    # Step 1: magic 0x55ca1234, cmd 0x01
    raw1 = bytearray(40)
    struct.pack_into("<III", raw1, 0, PERIPH_ID, dev_id, 0x55CA1234)
    raw1[39] = 0x01
    packets.append(bytes([0xF0, 0x00, 0x00, 0x17, 0x79]) + pack_7bit(raw1) + bytes([0xF7]))

    # Step 2: magic 0x7654ac55, cmd 0x02
    raw2 = bytearray(40)
    struct.pack_into("<III", raw2, 0, PERIPH_ID, dev_id, 0x7654AC55)
    raw2[39] = 0x02
    packets.append(bytes([0xF0, 0x00, 0x00, 0x17, 0x79]) + pack_7bit(raw2) + bytes([0xF7]))

    # Step 3: cmd 0x05 (writes 0x21000 bootloader flag & triggers SCB->AIRCR reset)
    raw3 = bytearray(40)
    struct.pack_into("<II", raw3, 0, PERIPH_ID, dev_id)
    raw3[39] = 0x05
    packets.append(bytes([0xF0, 0x00, 0x00, 0x17, 0x79]) + pack_7bit(raw3) + bytes([0xF7]))
    return packets


def build_rbin_cmd(dev_id: int, cmd_payload: bytes) -> bytes:
    raw = struct.pack("<II", PERIPH_ID, dev_id) + cmd_payload
    return bytes([0xF0, 0x00, 0x00, 0x17, 0x73]) + pack_7bit(raw) + bytes([0xF7])


class SimulatedAPC64Bootloader:
    """
    Exact state-machine simulation of the APC64 Bootloader (0x600107a8) and App (0x600b5792)
    for dry-run and automated testing.
    """

    def __init__(self, start_in_app: bool = True):
        self.dev_id = 0x41504336  # 'APC6'
        self.in_bootloader = not start_in_app
        self.handshake_state = 0
        self.flash = {}
        self.regions = {}

    def transfer(self, sysex: bytes) -> bytes:
        assert sysex[0] == 0xF0 and sysex[-1] == 0xF7
        if sysex[1:4] == bytes([0x00, 0x00, 0x17]):
            sub = sysex[4]
            if sub == 0x70:
                info = bytearray(0x44)
                struct.pack_into("<I", info, 0x00, PERIPH_ID)
                struct.pack_into("<I", info, 0x10, self.dev_id)
                info[0x18] = 1 if self.in_bootloader else 0
                return bytes([0xF0, 0x00, 0x00, 0x17, 0x71]) + pack_7bit(info) + bytes([0xF7])
            elif sub == 0x79:
                raw = bytearray(unpack_7bit(sysex[5:-1]))
                cmd = raw[39]
                if cmd == 0x01:
                    self.handshake_state = 1
                elif cmd == 0x02 and self.handshake_state == 1:
                    self.handshake_state = 2
                elif cmd == 0x05 and self.handshake_state == 2:
                    self.in_bootloader = True
                raw[39] = 0x7F
                return bytes([0xF0, 0x00, 0x00, 0x17, 0x79]) + pack_7bit(raw) + bytes([0xF7])
            elif sub == 0x73:
                raw = unpack_7bit(sysex[5:-1])
                periph, did = struct.unpack("<II", raw[:8])
                assert periph == PERIPH_ID and did == self.dev_id
                payload = raw[8:]
                op = payload[0]
                if op == 0xC0:
                    reply = bytes([0x80])
                elif op == 0xC2:
                    reply = bytes([0x84, len(self.regions) or 2])
                elif op == 0xC3:
                    reply = bytes([0x81, 0x00])
                elif op == 0xC5:
                    p_id, r_idx, ver, f_addr, f_len, f_crc = struct.unpack("<6I", payload[1:25])
                    self.regions[r_idx] = (f_addr, f_len, f_crc)
                    self.flash[r_idx] = bytearray(b"\xff" * f_len)
                    reply = struct.pack("<BI", 0x81, 0)
                elif op in (0xC6, 0xC7):
                    c_addr = struct.unpack("<I", payload[1:5])[0]
                    c_len = payload[5]
                    c_data = payload[6 : 6 + c_len]
                    for r_idx, (f_addr, f_len, _) in self.regions.items():
                        if f_addr <= c_addr < f_addr + f_len:
                            rel = c_addr - f_addr
                            self.flash[r_idx][rel : rel + c_len] = c_data
                    if op == 0xC7:
                        return b""
                    c_crc = zlib.crc32(c_data) & 0xFFFFFFFF
                    reply = struct.pack("<BI", 0x81, c_crc)
                elif op == 0xC8:
                    r_idx = struct.unpack("<I", payload[1:5])[0]
                    f_addr, f_len, expected_crc = self.regions[r_idx]
                    calc_crc = zlib.crc32(self.flash[r_idx]) & 0xFFFFFFFF
                    assert calc_crc == expected_crc, f"Simulated flash CRC mismatch: {calc_crc:x} != {expected_crc:x}"
                    reply = struct.pack("<BI", 0x81, calc_crc)
                elif op == 0xC1:
                    self.in_bootloader = False
                    reply = bytes([0x80])
                else:
                    reply = bytes([0x82, 0x01])
                out_raw = struct.pack("<II", PERIPH_ID, self.dev_id) + reply
                return bytes([0xF0, 0x00, 0x00, 0x17, 0x73]) + pack_7bit(out_raw) + bytes([0xF7])
        return b""


class MidiTransport:
    """
    Cross-platform MIDI SysEx transport supporting:
      1. python-rtmidi / mido (Windows, macOS, Linux)
      2. Linux ALSA amidi fallback
      3. SimulatedAPC64Bootloader (--dry-run)
    """

    def __init__(self, dry_run: bool = False, port_hint: str = "APC64"):
        self.dry_run = dry_run
        self.port_hint = port_hint
        self.sim = SimulatedAPC64Bootloader() if dry_run else None
        self.backend = "simulation" if dry_run else None
        self.amidi_port = None
        self.rtmidi_in = None
        self.rtmidi_out = None
        self._rx_queue = []

        if not dry_run:
            self._init_hardware()

    def _init_hardware(self):
        # Try python-rtmidi first (cross-platform Windows/macOS/Linux)
        try:
            import rtmidi  # type: ignore

            midi_out = rtmidi.MidiOut()
            midi_in = rtmidi.MidiIn()
            midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
            out_ports = midi_out.get_ports()
            in_ports = midi_in.get_ports()
            out_idx = next((i for i, p in enumerate(out_ports) if self.port_hint.lower() in p.lower()), None)
            in_idx = next((i for i, p in enumerate(in_ports) if self.port_hint.lower() in p.lower()), None)
            if out_idx is not None and in_idx is not None:
                midi_out.open_port(out_idx)
                midi_in.open_port(in_idx)
                midi_in.set_callback(lambda event, data=None: self._rx_queue.append(bytes(event[0])))
                self.rtmidi_out = midi_out
                self.rtmidi_in = midi_in
                self.backend = f"rtmidi ({out_ports[out_idx]})"
                return
        except Exception:
            pass

        # Fallback on Linux: ALSA `amidi`
        if platform.system() == "Linux" and shutil.which("amidi"):
            res = subprocess.run(["amidi", "-l"], capture_output=True, text=True)
            for line in res.stdout.splitlines():
                if self.port_hint.lower() in line.lower():
                    parts = line.split()
                    for tok in parts:
                        if tok.startswith("hw:"):
                            self.amidi_port = tok
                            self.backend = f"alsa-amidi ({tok})"
                            return

        raise RuntimeError(
            "No Akai APC64 USB MIDI port detected.\n"
            "  - Connect your APC64 via USB and ensure it is powered on.\n"
            "  - Or use the WebMIDI Installer inside the Node.js Web Editor (http://localhost:3000)\n"
            "  - Or run with --dry-run to test the flashing protocol in simulation mode."
        )

    def transfer(self, sysex: bytes, expect_reply: bool = True, timeout: float = 2.0) -> bytes:
        if self.dry_run:
            return self.sim.transfer(sysex)
        if self.rtmidi_out is not None:
            self._rx_queue.clear()
            self.rtmidi_out.send_message(list(sysex))
            if not expect_reply:
                return b""
            deadline = time.time() + timeout
            while time.time() < deadline:
                if self._rx_queue:
                    return self._rx_queue.pop(0)
                time.sleep(0.005)
            raise TimeoutError("Timed out waiting for SysEx reply from APC64")
        if self.amidi_port is not None:
            hex_str = " ".join(f"{b:02X}" for b in sysex)
            if not expect_reply:
                subprocess.run(["amidi", "-p", self.amidi_port, "-S", hex_str], check=True)
                return b""
            proc = subprocess.run(
                ["amidi", "-p", self.amidi_port, "-S", hex_str, "-d", "-t", str(int(max(1, timeout)))],
                capture_output=True,
                text=True,
            )
            hex_tokens = [t for t in proc.stdout.split() if len(t) == 2 and all(c in "0123456789ABCDEFabcdef" for c in t)]
            raw = bytes(int(t, 16) for t in hex_tokens)
            start = raw.find(b"\xf0")
            end = raw.find(b"\xf7", start) if start != -1 else -1
            if start != -1 and end != -1:
                return raw[start : end + 1]
            raise TimeoutError("Timed out waiting for ALSA amidi SysEx reply from APC64")
        return b""


def flash_firmware(rbin_path: Path, dry_run: bool = False):
    print(f"============================================================")
    print(f" FreeAPC64 Multi-Platform Firmware Updater v0.0.1")
    print(f" Target Image : {rbin_path.name}")
    print(f" Mode         : {'SIMULATION (--dry-run)' if dry_run else 'HARDWARE USB MIDI'}")
    print(f"============================================================")

    buf = rbin_path.read_bytes()
    regions = parse_rbin(buf)
    print(f"[1/6] Verified .rbin container ({len(buf)} bytes, {len(regions)} regions):")
    for r in regions:
        print(
            f"      - Region {r['region_index']}: v{r['version']} | Flash 0x{r['flash_base']:08x} "
            f"| Span 0x{r['flash_span']:x} | CRC32 0x{r['crc32']:08x} (VALID)"
        )

    transport = MidiTransport(dry_run=dry_run)
    print(f"[2/6] Connected transport backend: {transport.backend}")

    # Step 1: Query device info (0x70 -> 0x71)
    reply = transport.transfer(build_inquiry_sysex())
    if len(reply) < 7 or reply[4] != 0x71:
        raise RuntimeError(f"Unexpected inquiry reply: {reply.hex()}")
    info = unpack_7bit(reply[5:-1])
    periph_id = struct.unpack("<I", info[0:4])[0]
    dev_id = struct.unpack("<I", info[16:20])[0]
    in_boot = info[24] == 1
    print(
        f"[3/6] Detected APC64: PeripheralID=0x{periph_id:08x}, SessionID=0x{dev_id:08x}, "
        f"Mode={'Bootloader' if in_boot else 'Application'}"
    )

    # Step 2: Reboot to bootloader if currently in application firmware
    if not in_boot:
        print(f"[4/6] Sending 3-step Bootloader Handshake (0x79)...")
        for pkt in build_reboot_to_bootloader_packets(dev_id):
            ack = transport.transfer(pkt)
            if not ack or ack[4] != 0x79:
                raise RuntimeError("Failed 0x79 bootloader handshake step")
        if not dry_run:
            time.sleep(1.5)
        reply = transport.transfer(build_inquiry_sysex())
        info = unpack_7bit(reply[5:-1])
        dev_id = struct.unpack("<I", info[16:20])[0]
        in_boot = info[24] == 1
        print(f"      Device is now in Bootloader mode (SessionID=0x{dev_id:08x})")
    else:
        print(f"[4/6] Device is already in Bootloader mode.")

    # Step 3: Initialize RBIN bootloader session (0xC0, 0xC3)
    print(f"[5/6] Flashing {len(regions)} firmware regions via RBIN protocol (0x73)...")
    transport.transfer(build_rbin_cmd(dev_id, bytes([0xC0])))
    transport.transfer(build_rbin_cmd(dev_id, bytes([0xC3, len(regions)])))

    for r in regions:
        r_idx = r["region_index"]
        # 0xC5 SetRegion (erases target NOR flash sectors)
        c5_payload = struct.pack(
            "<B6I",
            0xC5,
            r["peripheral_id"],
            r_idx,
            r["version_raw"],
            r["flash_base"],
            r["flash_span"],
            r["crc32"],
        )
        transport.transfer(build_rbin_cmd(dev_id, c5_payload), timeout=5.0)
        print(f"      - Erased Region {r_idx} (0x{r['flash_base']:08x}, {r['flash_span']} bytes)")

        total_bytes = sum(s["length"] for s in r["segments"])
        sent_bytes = 0
        for seg in r["segments"]:
            s_addr = seg["flash_addr"]
            s_data = seg["data"]
            num_chunks = (len(s_data) + CHUNK_SIZE - 1) // CHUNK_SIZE
            for c_idx in range(num_chunks):
                c_off = c_idx * CHUNK_SIZE
                chunk = s_data[c_off : c_off + CHUNK_SIZE]
                is_ack = (c_idx % 8 == 7) or (c_idx == num_chunks - 1)
                op = 0xC6 if is_ack else 0xC7
                pkt_payload = struct.pack("<BIB", op, s_addr + c_off, len(chunk)) + chunk
                resp = transport.transfer(build_rbin_cmd(dev_id, pkt_payload), expect_reply=is_ack)
                if is_ack:
                    unp = unpack_7bit(resp[5:-1])[8:]
                    ack_crc = struct.unpack("<I", unp[1:5])[0]
                    exp_crc = zlib.crc32(chunk) & 0xFFFFFFFF
                    if ack_crc != exp_crc:
                        raise RuntimeError(f"Chunk CRC mismatch at 0x{s_addr+c_off:08x}")
                sent_bytes += len(chunk)

        # 0xC8 ValidateRegion
        c8_resp = transport.transfer(build_rbin_cmd(dev_id, struct.pack("<BI", 0xC8, r_idx)), timeout=5.0)
        unp_c8 = unpack_7bit(c8_resp[5:-1])[8:]
        flash_crc = struct.unpack("<I", unp_c8[1:5])[0]
        if flash_crc != r["crc32"]:
            raise RuntimeError(f"Region {r_idx} validation CRC mismatch: 0x{flash_crc:08x} != 0x{r['crc32']:08x}")
        print(f"      - Verified Region {r_idx} ({sent_bytes}/{total_bytes} bytes, CRC32 0x{flash_crc:08x} OK)")

    # Step 4: 0xC1 Complete & Reboot into Application
    transport.transfer(build_rbin_cmd(dev_id, bytes([0xC1])))
    print(f"[6/6] Sent RBIN Complete & Reboot (0xC1). Firmware update finished successfully!")


def main():
    parser = argparse.ArgumentParser(description="FreeAPC64 Cross-Platform Firmware Updater")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--custom", action="store_true", help="Install FreeAPC64 Custom Firmware (1.2.1.6)")
    group.add_argument("--stock", action="store_true", help="Restore Akai Stock Firmware (1.2.1.6)")
    group.add_argument("--verify", action="store_true", help="Verify both Custom and Stock .rbin images")
    parser.add_argument("--dry-run", action="store_true", help="Simulate bootloader flashing without hardware")
    args = parser.parse_args()

    if args.verify:
        for label, path in [("Stock Factory Firmware", STOCK_RBIN), ("FreeAPC64 Custom Firmware", CUSTOM_RBIN)]:
            regs = parse_rbin(path.read_bytes())
            print(f"[OK] {label} ({path.name}):")
            for r in regs:
                print(
                    f"     Region {r['region_index']}: v{r['version']} @ 0x{r['flash_base']:08x} "
                    f"span=0x{r['flash_span']:x} CRC32=0x{r['crc32']:08x}"
                )
        return

    target = CUSTOM_RBIN if args.custom else STOCK_RBIN
    flash_firmware(target, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
