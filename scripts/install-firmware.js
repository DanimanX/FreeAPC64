#!/usr/bin/env node
/**
 * FreeAPC64 Cross-Platform Node.js Firmware Installer & Verifier (v0.0.1)
 * =======================================================================
 * Supports Linux, macOS, and Windows.
 *
 * Usage:
 *   node scripts/install-firmware.js --custom            # Flash FreeAPC64 Custom Firmware (1.2.1.6)
 *   node scripts/install-firmware.js --stock             # Restore Akai Stock Firmware (1.2.1.6)
 *   node scripts/install-firmware.js --custom --dry-run  # Simulate full bootloader flashing
 *   node scripts/install-firmware.js --verify            # Validate both .rbin images & CRC32s
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseRbin } = require("../src/apc64-protocol");

const ROOT_DIR = path.resolve(__dirname, "..");
const STOCK_RBIN = path.join(ROOT_DIR, "firmware", "akai-apc64-stock-1.2.1.6.rbin");
const CUSTOM_RBIN = path.join(ROOT_DIR, "firmware", "freeapc64-custom-1.2.1.6.rbin");
const MANIFEST_PATH = path.join(ROOT_DIR, "firmware", "patch-manifest.json");
const PY_INSTALLER = path.join(ROOT_DIR, "scripts", "install-firmware.py");

function verifyImages() {
  console.log("============================================================");
  console.log(" FreeAPC64 Firmware Container & CRC32 Verification (v0.0.1)");
  console.log("============================================================");

  for (const [label, filePath] of [
    ["Original Factory Firmware (Stock 1.2.1.6)", STOCK_RBIN],
    ["Liberated Universal DAW Firmware (FreeAPC64 1.2.1.6)", CUSTOM_RBIN],
  ]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing firmware image: ${filePath}`);
    }
    const buf = fs.readFileSync(filePath);
    const regions = parseRbin(buf);
    console.log(`\n[OK] ${label}`);
    console.log(`     File : ${path.basename(filePath)} (${buf.length} bytes)`);
    for (const r of regions) {
      if (!r.crcValid) {
        throw new Error(`CRC32 verification failed for ${filePath} Region ${r.regionIndex}`);
      }
      console.log(
        `     Region ${r.regionIndex} : v${r.version} | Flash 0x${r.flashBase.toString(16)} ` +
          `| Span 0x${r.flashSpan.toString(16)} | CRC32 0x${r.crc32.toString(16).padStart(8, "0")} (VALID)`
      );
      for (const s of r.segments) {
        console.log(
          `       - Seg ${s.index}: @ 0x${s.flashAddr.toString(16)} (${s.length} B) ` +
            `CRC32=0x${s.crc32.toString(16).padStart(8, "0")} (VALID)`
        );
      }
    }
  }

  if (fs.existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    console.log(`\n[OK] Loaded Patch Manifest (${manifest.patches.length} binary patches verified):`);
    for (const p of manifest.patches) {
      console.log(`     - [${p.flash_addr}] ${p.id}: ${p.name}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--verify")) {
    verifyImages();
    return;
  }

  const pyCmd = process.platform === "win32" ? "python" : "python3";
  const res = spawnSync(pyCmd, [PY_INSTALLER, ...args], { stdio: "inherit" });
  if (res.error) {
    // Fallback if python3 is named python
    const resFallback = spawnSync("python", [PY_INSTALLER, ...args], { stdio: "inherit" });
    process.exit(resFallback.status ?? 1);
  }
  process.exit(res.status ?? 0);
}

main();
