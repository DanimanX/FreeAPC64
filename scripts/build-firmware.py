#!/usr/bin/env python3
"""
FreeAPC64 Custom Firmware Builder & RBIN Validator (v0.0.1)
===========================================================
Unlocks the Akai Professional APC64 (NXP i.MX RT10xx ARM Cortex-M7 Thumb-2)
for universal use with any DAW (Bitwig Studio, Reaper, Ardour, FL Studio,
Logic Pro, Studio One, hardware synthesizers, etc.) over USB MIDI, DIN MIDI,
and CV/Gate.

Applies verified binary patches to Application Firmware Image 1 (v1.2.1.6,
flash base 0x60095000) and recomputes all segment and region IEEE 802.3
CRC32 checksums in the inMusic !Rbn firmware container.
"""

import json
import os
import struct
import sys
import zlib
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STOCK_RBIN = BASE_DIR / "firmware" / "akai-apc64-stock-1.2.1.6.rbin"
CUSTOM_RBIN = BASE_DIR / "firmware" / "freeapc64-custom-1.2.1.6.rbin"
MANIFEST_JSON = BASE_DIR / "firmware" / "patch-manifest.json"

APP_BASE_ADDR = 0x60095000
SEG1_BASE_ADDR = 0x6009E4A0


def parse_rbin_container(buf: bytes, offset: int = 0) -> dict:
    magic = buf[offset : offset + 4]
    if magic != b"!Rbn":
        raise ValueError(f"Invalid !Rbn magic at 0x{offset:x}: {magic!r}")
    copyright_str = buf[offset + 4 : offset + 0x24].rstrip(b"\x00").decode("ascii", errors="replace")
    periph_id, region_idx, version, flash_base, flash_span, region_crc, container_len, num_segments = struct.unpack(
        "<8I", buf[offset + 0x24 : offset + 0x44]
    )
    segments = []
    for i in range(num_segments):
        s_off = offset + 0x44 + i * 16
        seg_addr, seg_len, seg_crc, data_rel_off = struct.unpack("<4I", buf[s_off : s_off + 16])
        abs_off = offset + data_rel_off
        seg_data = buf[abs_off : abs_off + seg_len]
        calc_seg_crc = zlib.crc32(seg_data) & 0xFFFFFFFF
        segments.append(
            {
                "index": i,
                "flash_addr": seg_addr,
                "length": seg_len,
                "header_crc32": seg_crc,
                "calculated_crc32": calc_seg_crc,
                "crc_valid": seg_crc == calc_seg_crc,
                "container_rel_offset": data_rel_off,
                "file_offset": abs_off,
            }
        )

    # Reconstruct full flash span (gaps filled with 0xFF erased NOR flash state)
    span_image = bytearray(b"\xff" * flash_span)
    for seg in segments:
        rel_flash = seg["flash_addr"] - flash_base
        s_len = seg["length"]
        span_image[rel_flash : rel_flash + s_len] = buf[seg["file_offset"] : seg["file_offset"] + s_len]

    calc_region_crc = zlib.crc32(span_image) & 0xFFFFFFFF

    ver_bytes = struct.pack(">I", version)
    ver_str = f"{ver_bytes[0]}.{ver_bytes[1]}.{ver_bytes[2]}.{ver_bytes[3]}"

    return {
        "file_offset": offset,
        "copyright": copyright_str,
        "peripheral_id": periph_id,
        "region_index": region_idx,
        "version_raw": version,
        "version": ver_str,
        "flash_base": flash_base,
        "flash_span": flash_span,
        "header_crc32": region_crc,
        "calculated_crc32": calc_region_crc,
        "crc_valid": region_crc == calc_region_crc,
        "container_length": container_len,
        "num_segments": num_segments,
        "segments": segments,
    }


def parse_firmware_file(buf: bytes) -> list:
    regions = []
    offset = 0
    while offset < len(buf):
        reg = parse_rbin_container(buf, offset)
        regions.append(reg)
        offset += reg["container_length"]
    return regions


PATCHES = [
    {
        "id": "unlock_session_view_popup",
        "name": "Bypass 'Please connect to Ableton Live' Popup Lockout in UI::switchPage",
        "flash_addr": 0x600B0BBE,
        "orig_bytes": bytes.fromhex("04f5df454c35"),
        "patch_bytes": bytes.fromhex("00bf00bf00bf"),
        "description": (
            "Prevents UI::switchPage (0x600b0b86) from redirecting CPageSession (r4+0x468) "
            "to CPageLivePopUp (r4+0x6fcc) when Ableton Live's proprietary SysEx 0x1B handshake "
            "has not been received. Unlocks Session grid pads, scene launch, and track buttons in any DAW."
        ),
    },
    {
        "id": "disable_live_disconnect_redirect",
        "name": "Disable Param 0xC8 (isLiveDisconnected) Forced Redirect to CPageLivePopUp",
        "flash_addr": 0x600B1206,
        "orig_bytes": bytes.fromhex("fff7befc"),
        "patch_bytes": bytes.fromhex("00bf00bf"),
        "description": (
            "Prevents parameter 0xC8 handler (0x600b11de) from forcing a page switch to "
            "CPageLivePopUp when operating in Bitwig, Reaper, or other DAWs."
        ),
    },
    {
        "id": "redirect_page_index_5_to_session",
        "name": "Redirect Mode Index 5 (LivePopUp) to CPageSession in UI::switchPageByIndex",
        "flash_addr": 0x600B10C0,
        "orig_bytes": bytes.fromhex("00f5df4100224c31"),
        "patch_bytes": bytes.fromhex("002200f58d6100bf"),
        "description": (
            "Rewrites case 5 in UI::switchPageByIndex (0x600b107e) to target CPageSession (r0+0x468) "
            "instead of CPageLivePopUp (r0+0x6fcc)."
        ),
    },
    {
        "id": "unlock_device_page_standalone",
        "name": "Unlock Device Control Page (CPageDevice) in Standalone/Custom Mode",
        "flash_addr": 0x600B0B94,
        "orig_bytes": bytes.fromhex("6bd0"),
        "patch_bytes": bytes.fromhex("00bf"),
        "description": "Allows entering Device Control page (r0+0x200) regardless of Standalone/DAW mode.",
    },
    {
        "id": "unlock_mixer_page_standalone",
        "name": "Unlock Mixer Page (CPageMixer) in Standalone/Custom Mode",
        "flash_addr": 0x600B0B9C,
        "orig_bytes": bytes.fromhex("67d0"),
        "patch_bytes": bytes.fromhex("00bf"),
        "description": "Allows entering Mixer page (r0+0x334) regardless of Standalone/DAW mode.",
    },
    {
        "id": "unlock_fader_midi_cc_all_modes",
        "name": "Enable Touchstrip Faders to Transmit MIDI CC1/CC2 & Notes in All Modes",
        "flash_addr": 0x600B1AC0,
        "orig_bytes": bytes.fromhex(
            "70b9f26f0d4b9a420ad02946204601f0c7f92946e0b202b0bde8704003f0a4bb2a4621460548fbf78bfff2e7"
        ),
        "patch_bytes": bytes.fromhex(
            "38b9f26f0d4b9a4203d02946204601f0c7f92a4621460948fbf792ff2946e0b202b0bde8704003f09fbb00bf"
        ),
        "description": (
            "Restructures the Touchstrip Fader handler (0x600b1a80) so that in DAW/Session/Mixer/Device "
            "modes it calls BOTH 0x600b2e60 (DAW fader port 0) AND 0x600ada00 (Custom MIDI CC1/CC2 + "
            "Fader Note on USB Custom port 3, DIN MIDI, and CV). Allows instant MIDI CC learn in Bitwig, "
            "Reaper, or any VST synth in every mode."
        ),
    },
    {
        "id": "unlock_sysex_mode_switch",
        "name": "Allow SysEx 0x19 (Set Active UI Page) in Both DAW and Standalone Modes",
        "flash_addr": 0x600BCFA6,
        "orig_bytes": bytes.fromhex("3ff4ddad"),
        "patch_bytes": bytes.fromhex("00bf00bf"),
        "description": (
            "Removes the Device Mode == Standalone guard on SysEx message 0x19 (0x600bcfa0) so the "
            "Web Project Editor and external DAW scripts can switch hardware pages at any time."
        ),
    },
    {
        "id": "oled_label_universal_daw",
        "name": "Update Global Settings Device Mode OLED Label to 'Universal DAW'",
        "flash_addr": 0x600E90BC,
        "orig_bytes": b"Ableton Live\x00\x00\x00\x00",
        "patch_bytes": b"Universal DAW\x00\x00\x00",
        "description": "Replaces 'Ableton Live' with 'Universal DAW' in the hardware OLED Global Settings menu.",
    },
    {
        "id": "oled_banner_freeapc64",
        "name": "Update OLED Banner Strings to FreeAPC64 Universal DAW",
        "flash_addr": 0x600D8ABE,
        "orig_bytes": b"Please connect\x00to Ableton Live\x00",
        "patch_bytes": b"FreeAPC64 v0.1\x00Universal DAW\x00\x00\x00",
        "description": "Updates the OLED status strings to identify FreeAPC64 v0.1 Universal DAW firmware.",
    },
]


def build_custom_firmware():
    if not STOCK_RBIN.exists():
        raise FileNotFoundError(f"Stock firmware not found at {STOCK_RBIN}")

    stock_bytes = STOCK_RBIN.read_bytes()
    regions = parse_firmware_file(stock_bytes)
    assert len(regions) == 2, f"Expected 2 regions, found {len(regions)}"
    for r in regions:
        assert r["crc_valid"], f"Stock Region {r['region_index']} CRC invalid!"
        for s in r["segments"]:
            assert s["crc_valid"], f"Stock Region {r['region_index']} Segment {s['index']} CRC invalid!"

    print(f"[+] Verified Stock Firmware ({len(stock_bytes)} bytes):")
    for r in regions:
        print(
            f"    Region {r['region_index']}: v{r['version']} @ 0x{r['flash_base']:08x} "
            f"(span 0x{r['flash_span']:x}, CRC32 0x{r['header_crc32']:08x} OK)"
        )

    custom_buf = bytearray(stock_bytes)
    reg1 = regions[1]
    seg1 = reg1["segments"][1]
    assert seg1["flash_addr"] == SEG1_BASE_ADDR

    applied_patches = []
    for p in PATCHES:
        flash_addr = p["flash_addr"]
        orig = p["orig_bytes"]
        repl = p["patch_bytes"]
        assert len(orig) == len(repl), f"Patch {p['id']} length mismatch!"
        file_off = seg1["file_offset"] + (flash_addr - SEG1_BASE_ADDR)
        actual = bytes(custom_buf[file_off : file_off + len(orig)])
        if actual != orig:
            raise ValueError(
                f"Patch {p['id']} @ 0x{flash_addr:08x} (file 0x{file_off:x}): "
                f"expected {orig.hex()}, found {actual.hex()}"
            )
        custom_buf[file_off : file_off + len(repl)] = repl
        applied_patches.append(
            {
                "id": p["id"],
                "name": p["name"],
                "flash_addr": f"0x{flash_addr:08x}",
                "file_offset": f"0x{file_off:06x}",
                "length": len(orig),
                "orig_hex": orig.hex(),
                "patch_hex": repl.hex(),
                "description": p["description"],
            }
        )
        print(f"[+] Applied patch '{p['id']}' @ 0x{flash_addr:08x} ({len(orig)} bytes)")

    # Recompute Segment 1 CRC32
    r1_off = reg1["file_offset"]
    seg1_data = bytes(custom_buf[seg1["file_offset"] : seg1["file_offset"] + seg1["length"]])
    new_seg1_crc = zlib.crc32(seg1_data) & 0xFFFFFFFF
    # Segment 1 descriptor is at r1_off + 0x44 + 1*16; CRC32 is at +8
    struct.pack_into("<I", custom_buf, r1_off + 0x44 + 16 + 8, new_seg1_crc)

    # Recompute Region 1 full flash span CRC32 (with 12-byte 0xFF gap between Segment 0 and Segment 1)
    seg0 = reg1["segments"][0]
    seg0_data = bytes(custom_buf[seg0["file_offset"] : seg0["file_offset"] + seg0["length"]])
    gap_len = seg1["flash_addr"] - (seg0["flash_addr"] + seg0["length"])
    assert gap_len == 12
    full_span = seg0_data + (b"\xff" * gap_len) + seg1_data
    assert len(full_span) == reg1["flash_span"]
    new_reg1_crc = zlib.crc32(full_span) & 0xFFFFFFFF
    struct.pack_into("<I", custom_buf, r1_off + 0x38, new_reg1_crc)

    # Validate the resulting custom firmware container
    custom_regions = parse_firmware_file(bytes(custom_buf))
    for r in custom_regions:
        assert r["crc_valid"], f"Custom Region {r['region_index']} CRC validation failed!"
        for s in r["segments"]:
            assert s["crc_valid"], f"Custom Region {r['region_index']} Segment {s['index']} CRC validation failed!"

    CUSTOM_RBIN.write_bytes(bytes(custom_buf))
    print(f"[+] Wrote Custom Firmware: {CUSTOM_RBIN} ({len(custom_buf)} bytes)")
    print(f"    Old Segment 1 CRC32: 0x{seg1['header_crc32']:08x} -> New: 0x{new_seg1_crc:08x}")
    print(f"    Old Region 1  CRC32: 0x{reg1['header_crc32']:08x} -> New: 0x{new_reg1_crc:08x}")

    manifest = {
        "project": "FreeAPC64",
        "version": "0.0.1",
        "base_firmware_version": "1.2.1.6",
        "bootloader_version": "1.2.0.7",
        "peripheral_id": "0x09e80053",
        "usb_vid": "0x09e8",
        "usb_pid": "0x0053",
        "stock_firmware": {
            "filename": STOCK_RBIN.name,
            "size": len(stock_bytes),
            "sha256": __import__("hashlib").sha256(stock_bytes).hexdigest(),
            "region0_crc32": f"0x{regions[0]['header_crc32']:08x}",
            "region1_crc32": f"0x{regions[1]['header_crc32']:08x}",
            "region1_seg0_crc32": f"0x{seg0['header_crc32']:08x}",
            "region1_seg1_crc32": f"0x{seg1['header_crc32']:08x}",
        },
        "custom_firmware": {
            "filename": CUSTOM_RBIN.name,
            "size": len(custom_buf),
            "sha256": __import__("hashlib").sha256(custom_buf).hexdigest(),
            "region0_crc32": f"0x{custom_regions[0]['header_crc32']:08x}",
            "region1_crc32": f"0x{new_reg1_crc:08x}",
            "region1_seg0_crc32": f"0x{seg0['header_crc32']:08x}",
            "region1_seg1_crc32": f"0x{new_seg1_crc:08x}",
        },
        "patches": applied_patches,
    }
    MANIFEST_JSON.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[+] Wrote Patch Manifest: {MANIFEST_JSON}")


if __name__ == "__main__":
    build_custom_firmware()
