#!/usr/bin/env node
/**
 * FreeAPC64 Automated Verification & Integration Test Suite (v0.0.1)
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const protocol = require("./apc64-protocol");
const { startServer } = require("./server");

const ROOT_DIR = path.resolve(__dirname, "..");
const STOCK_RBIN = path.join(ROOT_DIR, "firmware", "akai-apc64-stock-1.2.1.6.rbin");
const CUSTOM_RBIN = path.join(ROOT_DIR, "firmware", "freeapc64-custom-1.2.1.6.rbin");

async function runTests() {
  console.log("============================================================");
  console.log(" Running FreeAPC64 v0.0.1 Automated Test Suite");
  console.log("============================================================");

  // 1. Verify 7-bit MIDI Packing & Unpacking
  const sampleBuf = Buffer.alloc(1010);
  for (let i = 0; i < sampleBuf.length; i++) sampleBuf[i] = (i * 73 + 19) & 0xff;
  const packed = protocol.pack7Bit(sampleBuf);
  assert.strictEqual(packed.length, 1155, "1010 raw bytes must pack to 1155 7-bit MIDI bytes");
  assert.ok(packed.every((b) => (b & 0x80) === 0), "All packed MIDI bytes must have MSB=0");
  const unpacked = protocol.unpack7Bit(packed);
  assert.strictEqual(unpacked.length, 1010, "Unpacked length must be 1010 bytes");
  assert.ok(sampleBuf.equals(unpacked), "pack7Bit -> unpack7Bit must be bit-exact");
  console.log("[PASS] 1/6: 7-bit MIDI SysEx Packing/Unpacking (1010B <-> 1155B)");

  // 2. Verify Stock & Custom Firmware .rbin Containers and Checksums
  const stockRegions = protocol.parseRbin(fs.readFileSync(STOCK_RBIN));
  const customRegions = protocol.parseRbin(fs.readFileSync(CUSTOM_RBIN));
  assert.strictEqual(stockRegions.length, 2);
  assert.strictEqual(customRegions.length, 2);
  assert.ok(stockRegions.every((r) => r.crcValid), "Stock firmware CRC32 must be valid");
  assert.ok(customRegions.every((r) => r.crcValid), "Custom firmware CRC32 must be valid");
  assert.strictEqual(stockRegions[1].crc32, 0x7b044025);
  assert.strictEqual(customRegions[1].crc32, 0x5d2108fc);
  console.log("[PASS] 2/6: Stock (0x7b044025) & Custom (0x5d2108fc) !Rbn Containers Validated");

  // 3. Verify Custom Mode Project (0x3F2 = 1010B) Round-Trip Serialization
  const proj = protocol.createDefaultProject(3, "BitwigCC");
  proj.pads[0].midiChannel = 5;
  proj.pads[0].note = 7;
  proj.pads[0].octave = 4;
  proj.faders[0].ccMode = 2;
  proj.faders[0].cc1 = 74;
  proj.faders[0].cc2 = 20;
  const sysex12 = protocol.buildCustomProjectSysEx(proj);
  assert.strictEqual(sysex12[0], 0xf0);
  assert.strictEqual(sysex12[4], 0x12);
  assert.strictEqual(sysex12[5], 0x09); // MSB of 1156 (0x0484 -> 9*128 + 4)
  assert.strictEqual(sysex12[6], 0x04); // LSB of 1156
  assert.strictEqual(sysex12[7], 3); // Slot 3
  assert.strictEqual(sysex12.length, 1164);

  const rawDecoded = protocol.unpack7Bit(sysex12.subarray(8, sysex12.length - 1));
  const decodedProj = protocol.decodeCustomProjectRaw(rawDecoded, 3);
  assert.strictEqual(decodedProj.name, "BitwigCC");
  assert.strictEqual(decodedProj.pads[0].midiChannel, 5);
  assert.strictEqual(decodedProj.pads[0].note, 7);
  assert.strictEqual(decodedProj.pads[0].octave, 4);
  assert.strictEqual(decodedProj.faders[0].ccMode, 2);
  assert.strictEqual(decodedProj.faders[0].cc1, 74);
  assert.strictEqual(decodedProj.faders[0].cc2, 20);
  console.log("[PASS] 3/6: Custom Mode Project (SysEx 0x12, 1010 raw / 1164 SysEx bytes) Round-Trip");

  // 4. Verify Global Settings (0x38 = 56B) Round-Trip Serialization
  const gs = protocol.createDefaultGlobalSettings();
  gs.deviceMode = 0;
  gs.padSensitivity = 6;
  gs.cvChannels[3] = 9;
  gs.drumNotes[15] = 60;
  const sysex18 = protocol.buildGlobalSettingsSysEx(gs);
  assert.strictEqual(sysex18[4], 0x18);
  assert.strictEqual(sysex18[6], 0x40); // 64 packed bytes
  const gsRaw = protocol.unpack7Bit(sysex18.subarray(7, sysex18.length - 1));
  const gsDecoded = protocol.decodeGlobalSettingsRaw(gsRaw);
  assert.strictEqual(gsDecoded.deviceMode, 0);
  assert.strictEqual(gsDecoded.padSensitivity, 6);
  assert.strictEqual(gsDecoded.cvChannels[3], 9);
  assert.strictEqual(gsDecoded.drumNotes[15], 60);
  console.log("[PASS] 4/6: Global Settings (SysEx 0x18, 56 raw / 64 packed bytes) Round-Trip");

  // 5. Verify OLED & UI Mode SysEx Builders
  const oledPkt = protocol.buildOledTextSysEx(1, "Bitwig Studio OK");
  assert.strictEqual(oledPkt[4], 0x10);
  assert.strictEqual(oledPkt[7], 1);
  const modePkt = protocol.buildUiModeSysEx(8);
  assert.deepStrictEqual(Array.from(modePkt), [0xf0, 0x47, 0x00, 0x53, 0x19, 0x00, 0x01, 0x08, 0xf7]);
  console.log("[PASS] 5/6: OLED (SysEx 0x10/0x1A) & UI Page Switch (SysEx 0x19) Builders");

  // 6. Verify HTTP Server & REST API Endpoints
  const server = await startServer(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const stRes = await fetch(`${baseUrl}/api/status`);
    const stJson = await stRes.json();
    assert.strictEqual(stJson.ok, true);
    assert.strictEqual(stJson.firmware.custom.valid, true);
    assert.strictEqual(stJson.firmware.stock.valid, true);

    const prRes = await fetch(`${baseUrl}/api/presets/bitwig_studio/apply`, { method: "POST" });
    const prJson = await prRes.json();
    assert.strictEqual(prJson.ok, true);
    assert.strictEqual(prJson.project.faders[0].cc1, 20);

    const flRes = await fetch(`${baseUrl}/api/firmware/flash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "custom", dryRun: true }),
    });
    const flJson = await flRes.json();
    assert.strictEqual(flJson.ok, true);
    assert.ok(flJson.output.includes("Firmware update finished successfully!"));
    console.log("[PASS] 6/6: Web Editor HTTP Server, REST API & Simulated RBIN Flashing");
  } finally {
    server.close();
  }

  console.log("============================================================");
  console.log(" ALL 6 TEST SUITES PASSED SUCCESSFULLY!");
  console.log("============================================================");
}

runTests().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
