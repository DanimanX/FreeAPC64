#!/usr/bin/env node
/**
 * FreeAPC64 Web Project Editor, Synth Parameter Controller & Firmware Server (v0.0.1)
 * ===================================================================================
 * Zero-external-dependency Node.js HTTP + REST + WebMIDI/SysEx Bridge server.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const protocol = require("./apc64-protocol");
const { applyScaleToPads, buildPresets } = require("./presets");

const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const FIRMWARE_DIR = path.join(ROOT_DIR, "firmware");
const PRESETS_DIR = path.join(ROOT_DIR, "presets");
const SCRIPTS_DIR = path.join(ROOT_DIR, "scripts");

const STOCK_RBIN_PATH = path.join(FIRMWARE_DIR, "akai-apc64-stock-1.2.1.6.rbin");
const CUSTOM_RBIN_PATH = path.join(FIRMWARE_DIR, "freeapc64-custom-1.2.1.6.rbin");
const MANIFEST_PATH = path.join(FIRMWARE_DIR, "patch-manifest.json");

// Ensure preset files exist on disk
const builtInPresets = buildPresets();
if (!fs.existsSync(PRESETS_DIR)) {
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
}
for (const [key, preset] of Object.entries(builtInPresets)) {
  const pFile = path.join(PRESETS_DIR, `${key}.apc64.json`);
  if (!fs.existsSync(pFile)) {
    fs.writeFileSync(pFile, JSON.stringify(preset, null, 2) + "\n", "utf8");
  }
}

let currentProject = JSON.parse(JSON.stringify(builtInPresets.synth_master.project));
let currentGlobalSettings = protocol.createDefaultGlobalSettings();
let oledLines = [
  "FreeAPC64 v0.0.1",
  "Universal DAW Ready",
  "Synth CC: Unlocked",
  "BPM: 120.0 | Ch: 1",
  "Bitwig / Reaper OK",
  "USB+MIDI+CV Active",
  "Pad Grid: 64 RGB",
  "Touchstrips: CC1+2",
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttc": "font/collection",
  ".ttf": "font/ttf",
  ".rbin": "application/octet-stream",
};

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function getFirmwareSummary() {
  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
    : null;

  const inspectFile = (fPath) => {
    if (!fs.existsSync(fPath)) return null;
    const buf = fs.readFileSync(fPath);
    const regions = protocol.parseRbin(buf).map((r) => ({
      regionIndex: r.regionIndex,
      version: r.version,
      flashBase: `0x${r.flashBase.toString(16).padStart(8, "0")}`,
      flashSpan: r.flashSpan,
      crc32: `0x${r.crc32.toString(16).padStart(8, "0")}`,
      crcValid: r.crcValid,
      segments: r.segments.map((s) => ({
        index: s.index,
        flashAddr: `0x${s.flashAddr.toString(16).padStart(8, "0")}`,
        length: s.length,
        crc32: `0x${s.crc32.toString(16).padStart(8, "0")}`,
        crcValid: s.crcValid,
      })),
    }));
    return {
      filename: path.basename(fPath),
      size: buf.length,
      valid: regions.every((r) => r.crcValid),
      regions,
    };
  };

  return {
    manifest,
    custom: inspectFile(CUSTOM_RBIN_PATH),
    stock: inspectFile(STOCK_RBIN_PATH),
  };
}

function createRequestHandler() {
  return async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = urlObj.pathname;

      // API routes
      if (pathname === "/api/status" && req.method === "GET") {
        const sysexProject = protocol.buildCustomProjectSysEx(currentProject);
        const sysexGlobal = protocol.buildGlobalSettingsSysEx(currentGlobalSettings);
        return sendJson(res, 200, {
          ok: true,
          version: "0.0.1",
          firmware: getFirmwareSummary(),
          project: currentProject,
          projectSysExSize: sysexProject.length,
          globalSettings: currentGlobalSettings,
          globalSysExSize: sysexGlobal.length,
          oledLines,
          scales: protocol.SCALES,
          palette: protocol.APC64_PALETTE,
          noteNames: protocol.NOTE_NAMES,
        });
      }

      if (pathname === "/api/presets" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          presets: builtInPresets,
        });
      }

      if (pathname.startsWith("/api/presets/") && pathname.endsWith("/apply") && req.method === "POST") {
        const presetId = pathname.split("/")[3];
        const preset = builtInPresets[presetId];
        if (!preset) {
          return sendJson(res, 404, { ok: false, error: `Preset not found: ${presetId}` });
        }
        currentProject = JSON.parse(JSON.stringify(preset.project));
        const sysex = protocol.buildCustomProjectSysEx(currentProject);
        return sendJson(res, 200, {
          ok: true,
          presetId,
          project: currentProject,
          sysex: Array.from(sysex),
        });
      }

      if (pathname === "/api/project/scale" && req.method === "POST") {
        const body = await readBodyJson(req);
        if (body.project) {
          currentProject = body.project;
        }
        applyScaleToPads(
          currentProject.pads,
          Number(body.rootNote ?? currentProject.rootNote ?? 0),
          body.scaleKey || "minor",
          Number(body.baseOctave ?? 2),
          Number(body.rowInterval ?? 5),
          body.colors || {}
        );
        currentProject.rootNote = Number(body.rootNote ?? 0);
        const sysex = protocol.buildCustomProjectSysEx(currentProject);
        return sendJson(res, 200, {
          ok: true,
          project: currentProject,
          sysex: Array.from(sysex),
        });
      }

      if (pathname === "/api/project/encode" && req.method === "POST") {
        const body = await readBodyJson(req);
        if (body.project) {
          currentProject = body.project;
        }
        const raw = protocol.encodeCustomProjectRaw(currentProject);
        const sysex = protocol.buildCustomProjectSysEx(currentProject);
        return sendJson(res, 200, {
          ok: true,
          project: currentProject,
          rawBase64: raw.toString("base64"),
          rawLength: raw.length,
          sysex: Array.from(sysex),
          sysexLength: sysex.length,
        });
      }

      if (pathname === "/api/project/decode" && req.method === "POST") {
        const body = await readBodyJson(req);
        let decoded;
        if (Array.isArray(body.sysex)) {
          const buf = Buffer.from(body.sysex);
          // F0 47 00 53 12 <msb> <lsb> <slot> <1155 packed bytes> F7
          if (buf[0] === 0xf0 && buf[4] === 0x12) {
            const slot = buf[7];
            const packed = buf.subarray(8, buf.length - 1);
            const raw = protocol.unpack7Bit(packed).subarray(0, 0x3f2);
            decoded = protocol.decodeCustomProjectRaw(raw, slot);
          } else {
            throw new Error("Invalid Custom Project SysEx 0x12 header");
          }
        } else if (body.rawBase64) {
          const raw = Buffer.from(body.rawBase64, "base64");
          decoded = protocol.decodeCustomProjectRaw(raw, body.slot || 1);
        } else if (body.project) {
          decoded = body.project;
        } else {
          throw new Error("Provide sysex, rawBase64, or project");
        }
        currentProject = decoded;
        const sysex = protocol.buildCustomProjectSysEx(currentProject);
        return sendJson(res, 200, {
          ok: true,
          project: currentProject,
          sysex: Array.from(sysex),
        });
      }

      if (pathname === "/api/global/encode" && req.method === "POST") {
        const body = await readBodyJson(req);
        if (body.globalSettings) {
          currentGlobalSettings = { ...currentGlobalSettings, ...body.globalSettings };
        }
        const raw = protocol.encodeGlobalSettingsRaw(currentGlobalSettings);
        const sysex = protocol.buildGlobalSettingsSysEx(currentGlobalSettings);
        return sendJson(res, 200, {
          ok: true,
          globalSettings: currentGlobalSettings,
          rawLength: raw.length,
          sysex: Array.from(sysex),
          sysexLength: sysex.length,
        });
      }

      if (pathname === "/api/global/decode" && req.method === "POST") {
        const body = await readBodyJson(req);
        if (Array.isArray(body.sysex)) {
          const buf = Buffer.from(body.sysex);
          if (buf[0] === 0xf0 && buf[4] === 0x18) {
            const packed = buf.subarray(7, buf.length - 1);
            const raw = protocol.unpack7Bit(packed).subarray(0, 0x38);
            currentGlobalSettings = protocol.decodeGlobalSettingsRaw(raw);
          }
        }
        return sendJson(res, 200, {
          ok: true,
          globalSettings: currentGlobalSettings,
        });
      }

      if (pathname === "/api/oled" && req.method === "POST") {
        const body = await readBodyJson(req);
        if (Array.isArray(body.lines)) {
          oledLines = body.lines.slice(0, 8).map((l) => String(l || "").slice(0, 24));
        } else if (typeof body.lineIndex === "number") {
          oledLines[body.lineIndex & 7] = String(body.text || "").slice(0, 24);
        }
        const packets = oledLines.map((line, idx) => Array.from(protocol.buildOledTextSysEx(idx, line)));
        return sendJson(res, 200, {
          ok: true,
          oledLines,
          packets,
        });
      }

      if (pathname === "/api/ui-mode" && req.method === "POST") {
        const body = await readBodyJson(req);
        const modeIndex = Number(body.modeIndex ?? 2);
        const sysex = protocol.buildUiModeSysEx(modeIndex);
        return sendJson(res, 200, {
          ok: true,
          modeIndex,
          sysex: Array.from(sysex),
        });
      }

      if ((pathname === "/api/firmware/custom" || pathname === "/api/firmware/stock") && req.method === "GET") {
        const isCustom = pathname.endsWith("/custom");
        const fPath = isCustom ? CUSTOM_RBIN_PATH : STOCK_RBIN_PATH;
        const buf = fs.readFileSync(fPath);
        if (urlObj.searchParams.get("download") === "1") {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${path.basename(fPath)}"`,
            "Content-Length": buf.length,
          });
          return res.end(buf);
        }
        const regions = protocol.parseRbin(buf);
        return sendJson(res, 200, {
          ok: true,
          type: isCustom ? "custom" : "stock",
          filename: path.basename(fPath),
          size: buf.length,
          base64: buf.toString("base64"),
          regions: regions.map((r) => ({
            regionIndex: r.regionIndex,
            peripheralId: r.peripheralId,
            versionRaw: r.versionRaw,
            version: r.version,
            flashBase: r.flashBase,
            flashSpan: r.flashSpan,
            crc32: r.crc32,
            crcValid: r.crcValid,
            segments: r.segments.map((s) => ({
              index: s.index,
              flashAddr: s.flashAddr,
              length: s.length,
              crc32: s.crc32,
              dataBase64: s.data.toString("base64"),
            })),
          })),
        });
      }

      if (pathname === "/api/firmware/flash" && req.method === "POST") {
        const body = await readBodyJson(req);
        const modeFlag = body.target === "stock" ? "--stock" : "--custom";
        const args = [path.join(SCRIPTS_DIR, "install-firmware.py"), modeFlag];
        if (body.dryRun !== false) {
          args.push("--dry-run");
        }
        const pyCmd = process.platform === "win32" ? "python" : "python3";
        const proc = spawnSync(pyCmd, args, { encoding: "utf8" });
        return sendJson(res, 200, {
          ok: proc.status === 0,
          target: body.target === "stock" ? "stock" : "custom",
          dryRun: body.dryRun !== false,
          exitCode: proc.status,
          output: (proc.stdout || "") + (proc.stderr || ""),
        });
      }

      // Serve static files from PUBLIC_DIR
      let relPath = pathname === "/" ? "/index.html" : pathname;
      const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
      const fullPath = path.join(PUBLIC_DIR, safePath);
      if (fullPath.startsWith(PUBLIC_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        });
        return fs.createReadStream(fullPath).pipe(res);
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  };
}

function startServer(port = Number(process.env.PORT || 3000)) {
  const server = http.createServer(createRequestHandler());
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      console.log(`============================================================`);
      console.log(` FreeAPC64 Web Project & Synth Editor + Firmware Updater`);
      console.log(` URL           : http://localhost:${port}`);
      console.log(` Custom FW     : firmware/freeapc64-custom-1.2.1.6.rbin`);
      console.log(` Stock Backup  : firmware/akai-apc64-stock-1.2.1.6.rbin`);
      console.log(`============================================================`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createRequestHandler,
  startServer,
};
