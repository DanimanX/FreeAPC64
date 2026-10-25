/**
 * FreeAPC64 Core Protocol, Binary Serializer & Firmware RBIN Engine (v0.0.1)
 * ==========================================================================
 * Exact implementation of the Akai Professional APC64 (VID 0x09E8, PID 0x0053)
 * SysEx protocols reverse-engineered from Firmware 1.2.1.6 (0x60095000):
 *  - 7-bit MIDI Packing/Unpacking (0x6000a6a4 / 0x600bc444 & 0x6000a798 / 0x600bc410)
 *  - Rane/inMusic !Rbn Bootloader Protocol (F0 00 00 17 70/71/73/79 F7)
 *  - Akai APC64 Project & Parameter SysEx Protocol (F0 47 00 53 <msg_id> <len_msb> <len_lsb> ... F7)
 */

"use strict";

const zlib = require("zlib");

const PERIPHERAL_ID = 0x09e80053;
const USB_VID = 0x09e8;
const USB_PID = 0x0053;
const RBIN_CHUNK_SIZE = 0xf0; // 240 bytes

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const SCALES = {
  chromatic: { name: "Chromatic (12-Tone)", intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { name: "Major (Ionian)", intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: "Natural Minor (Aeolian)", intervals: [0, 2, 3, 5, 7, 8, 10] },
  harmonic_minor: { name: "Harmonic Minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
  dorian: { name: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { name: "Phrygian", intervals: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { name: "Lydian", intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { name: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10] },
  pentatonic_minor: { name: "Minor Pentatonic", intervals: [0, 3, 5, 7, 10] },
  pentatonic_major: { name: "Major Pentatonic", intervals: [0, 2, 4, 7, 9] },
};

const APC64_PALETTE = [
  { index: 0, name: "Off", r: 0, g: 0, b: 0 },
  { index: 1, name: "Red", r: 255, g: 16, b: 16 },
  { index: 2, name: "Orange", r: 255, g: 110, b: 0 },
  { index: 3, name: "Amber", r: 255, g: 180, b: 0 },
  { index: 4, name: "Yellow", r: 255, g: 240, b: 0 },
  { index: 5, name: "Lime", r: 130, g: 255, b: 0 },
  { index: 6, name: "Green", r: 0, g: 230, b: 40 },
  { index: 7, name: "Mint", r: 0, g: 255, b: 150 },
  { index: 8, name: "Cyan", r: 0, g: 220, b: 255 },
  { index: 9, name: "Sky Blue", r: 0, g: 140, b: 255 },
  { index: 10, name: "Blue", r: 20, g: 60, b: 255 },
  { index: 11, name: "Violet", r: 120, g: 30, b: 255 },
  { index: 12, name: "Purple", r: 190, g: 0, b: 255 },
  { index: 13, name: "Magenta", r: 255, g: 0, b: 180 },
  { index: 14, name: "Pink", r: 255, g: 80, b: 160 },
  { index: 15, name: "White", r: 255, g: 255, b: 255 },
];

/**
 * Standard IEEE 802.3 CRC32 (unsigned 32-bit integer)
 */
function crc32(buf) {
  if (typeof zlib.crc32 === "function") {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 7-bit MIDI Packing (matches firmware 0x6000a6a4 / 0x600bc444)
 */
function pack7Bit(rawBuf) {
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  const out = [];
  for (let i = 0; i < raw.length; i += 7) {
    const chunkLen = Math.min(7, raw.length - i);
    let msb = 0;
    for (let k = 0; k < chunkLen; k++) {
      if (raw[i + k] & 0x80) {
        msb |= 0x40 >> k;
      }
    }
    out.push(msb);
    for (let k = 0; k < chunkLen; k++) {
      out.push(raw[i + k] & 0x7f);
    }
  }
  return Buffer.from(out);
}

/**
 * 7-bit MIDI Unpacking (matches firmware 0x6000a798 / 0x600bc410)
 */
function unpack7Bit(midiBuf) {
  const midi = Buffer.isBuffer(midiBuf) ? midiBuf : Buffer.from(midiBuf);
  const out = [];
  for (let i = 0; i < midi.length; i += 8) {
    const groupLen = Math.min(8, midi.length - i);
    if (groupLen < 2) break;
    const msb = midi[i];
    for (let k = 0; k < groupLen - 1; k++) {
      const top = msb & (0x40 >> k) ? 0x80 : 0x00;
      out.push((midi[i + 1 + k] & 0x7f) | top);
    }
  }
  return Buffer.from(out);
}

/**
 * Parse and validate an inMusic !Rbn firmware image buffer
 */
function parseRbin(fileBuf) {
  const buf = Buffer.isBuffer(fileBuf) ? fileBuf : Buffer.from(fileBuf);
  const regions = [];
  let offset = 0;

  while (offset < buf.length) {
    const magic = buf.subarray(offset, offset + 4).toString("ascii");
    if (magic !== "!Rbn") {
      throw new Error(`Invalid !Rbn magic at offset 0x${offset.toString(16)}: ${magic}`);
    }
    const copyright = buf
      .subarray(offset + 4, offset + 0x24)
      .toString("ascii")
      .replace(/\0+$/, "");
    const peripheralId = buf.readUInt32LE(offset + 0x24);
    const regionIndex = buf.readUInt32LE(offset + 0x28);
    const versionRaw = buf.readUInt32LE(offset + 0x2c);
    const flashBase = buf.readUInt32LE(offset + 0x30);
    const flashSpan = buf.readUInt32LE(offset + 0x34);
    const regionCrc = buf.readUInt32LE(offset + 0x38);
    const containerLen = buf.readUInt32LE(offset + 0x3c);
    const numSegments = buf.readUInt32LE(offset + 0x40);

    const verBytes = [
      (versionRaw >>> 24) & 0xff,
      (versionRaw >>> 16) & 0xff,
      (versionRaw >>> 8) & 0xff,
      versionRaw & 0xff,
    ];
    const version = verBytes.join(".");

    const segments = [];
    for (let i = 0; i < numSegments; i++) {
      const sOff = offset + 0x44 + i * 16;
      const flashAddr = buf.readUInt32LE(sOff);
      const length = buf.readUInt32LE(sOff + 4);
      const segCrc = buf.readUInt32LE(sOff + 8);
      const relOff = buf.readUInt32LE(sOff + 12);
      const absOff = offset + relOff;
      const segData = buf.subarray(absOff, absOff + length);
      const calcSegCrc = crc32(segData);
      segments.push({
        index: i,
        flashAddr,
        length,
        crc32: segCrc,
        calculatedCrc32: calcSegCrc,
        crcValid: segCrc === calcSegCrc,
        fileOffset: absOff,
        data: segData,
      });
    }

    const spanImg = Buffer.alloc(flashSpan, 0xff);
    for (const seg of segments) {
      const rel = seg.flashAddr - flashBase;
      seg.data.copy(spanImg, rel);
    }
    const calcRegionCrc = crc32(spanImg);

    regions.push({
      fileOffset: offset,
      copyright,
      peripheralId,
      regionIndex,
      versionRaw,
      version,
      flashBase,
      flashSpan,
      crc32: regionCrc,
      calculatedCrc32: calcRegionCrc,
      crcValid: regionCrc === calcRegionCrc && segments.every((s) => s.crcValid),
      containerLength: containerLen,
      numSegments,
      segments,
    });

    offset += containerLen;
  }

  return regions;
}

/**
 * Create a default Custom Mode Project structure (matches 0x3F2 = 1010-byte firmware layout)
 */
function createDefaultProject(slot = 1, name = "FreeAPC64 Universal") {
  const tracks = [];
  for (let t = 0; t < 8; t++) {
    tracks.push({
      index: t,
      trackType: t === 0 ? 1 : 0, // 0 = Melodic/Synth, 1 = Drum
      midiChannel: t + 1,
      rootNote: 0, // C
      scale: 0, // Chromatic / Major
      sendToUsb: true,
      sendToMidi: true,
      sendToCv: false,
      timeDivision: 4, // 1/16
      gateLength: 50,
      swing: 50,
      velocity: 100,
      transpose: 0,
      octave: 3,
      sendPolyAftertouch: true,
    });
  }

  // 64 Custom Pads (8x8 grid, bottom-left = Pad 0, top-right = Pad 63)
  const pads = [];
  for (let p = 0; p < 64; p++) {
    const row = Math.floor(p / 8);
    const col = p % 8;
    const midiNote = 36 + p; // C1 (36) .. D#6 (99)
    const noteSemitone = midiNote % 12;
    const octave = Math.floor(midiNote / 12) - 2;
    const isRoot = noteSemitone === 0;
    const offColor = isRoot ? { r: 0, g: 140, b: 255 } : { r: 0, g: 45, b: 95 };
    const onColor = { r: 0, g: 255, b: 150 };

    pads.push({
      index: p,
      row,
      col,
      note: noteSemitone,
      octave: octave + 2,
      midiNote,
      midiChannel: 1,
      offColor,
      onColor,
      colorPreset: isRoot ? 9 : 10,
      sendToUsb: true,
      sendToMidi: true,
      sendToCv: false,
      sendPolyAftertouch: true,
    });
  }

  // 8 Custom Touchstrip Faders (default mapped to Synth/DAW Macro CCs 74, 71, 73, 75, 79, 72, 76, 1)
  const defaultFaderDefs = [
    { label: "Filter Cutoff", cc1: 74, cc2: 16, r: 0, g: 220, b: 255 },
    { label: "Resonance", cc1: 71, cc2: 17, r: 0, g: 140, b: 255 },
    { label: "Env Attack", cc1: 73, cc2: 18, r: 0, g: 255, b: 150 },
    { label: "Env Decay", cc1: 75, cc2: 19, r: 130, g: 255, b: 0 },
    { label: "Env Sustain", cc1: 79, cc2: 20, r: 255, g: 240, b: 0 },
    { label: "Env Release", cc1: 72, cc2: 21, r: 255, g: 110, b: 0 },
    { label: "LFO Rate / Macro 7", cc1: 76, cc2: 22, r: 190, g: 0, b: 255 },
    { label: "ModWheel / Macro 8", cc1: 1, cc2: 23, r: 255, g: 0, b: 180 },
  ];

  const faders = defaultFaderDefs.map((def, f) => ({
    index: f,
    label: def.label,
    ccMode: 1, // 0=Off, 1=Single CC, 2=Dual CC
    cc1: def.cc1,
    cc2: def.cc2,
    faderNote: 12, // 12 = Off, 0..11 = C..B
    faderOctave: 3,
    midiChannel: 1,
    faderColor: { r: def.r, g: def.g, b: def.b },
    tipColor: { r: 255, g: 255, b: 255 },
    style: 0, // 0 = Volume/Fill, 1 = Pan/Bipolar
    sendToUsb: true,
    sendToMidi: true,
    sendToCv: false,
    value: 64,
  }));

  return {
    slot,
    name,
    tempo: 120,
    rootNote: 0,
    scale: 0,
    tracks,
    pads,
    faders,
  };
}

/**
 * Encode a Custom Mode Project into the exact 1010-byte (0x3F2) raw binary struct
 * expected by firmware 0x600b781e (and packed into SysEx msg_id 0x12)
 */
function encodeCustomProjectRaw(project) {
  const raw = Buffer.alloc(0x3f2, 0); // 1010 bytes

  // 0x00..0x07: 8-byte header (param 0x17e..0x185)
  const nameBytes = Buffer.from((project.name || "FreeAPC6").slice(0, 8).padEnd(8, " "), "ascii");
  nameBytes.copy(raw, 0, 0, 8);

  // 0x0c..0x0d: Global project rootNote & scale (param 0x187, 0x186)
  raw[0x0c] = (project.rootNote || 0) & 0x7f;
  raw[0x0d] = (project.scale || 0) & 0x7f;

  // 0x0c + track offsets (0x600b75e0 / 0x600b78a6): 8 tracks * 14 bytes
  for (let t = 0; t < 8; t++) {
    const trk = (project.tracks && project.tracks[t]) || {};
    const base = 0x0c + t * 14;
    raw[base + 6] = (trk.trackType ?? 0) & 0xff;
    raw[base + 7] = (trk.midiChannel ?? t + 1) & 0xff;
    raw[base + 8] = (trk.rootNote ?? 0) & 0xff;
    let routeMask = 0;
    if (trk.sendToUsb !== false) routeMask |= 0x01;
    if (trk.sendToMidi !== false) routeMask |= 0x02;
    if (trk.sendToCv) routeMask |= 0x04;
    raw[base + 9] = routeMask;
    raw[base + 10] = (trk.timeDivision ?? 4) & 0xff;
    raw[base + 11] = (trk.gateLength ?? 50) & 0xff;
    raw[base + 12] = (trk.swing ?? 50) & 0xff;
    raw[base + 13] = (trk.velocity ?? 100) & 0xff;
    raw[base + 14] = (trk.octave ?? 3) & 0xff;
    raw[base + 15] = trk.sendPolyAftertouch !== false ? 1 : 0;
  }

  // 0x82..0x381: 64 Custom Pads * 12 bytes (0x600b7682)
  for (let p = 0; p < 64; p++) {
    const pad = (project.pads && project.pads[p]) || {};
    const off = 0x82 + p * 12;
    raw[off + 0] = (pad.note ?? p % 12) & 0xff;
    raw[off + 1] = (pad.octave ?? Math.floor(p / 12) + 1) & 0xff;
    raw[off + 2] = (pad.midiChannel ?? 1) & 0xff;
    raw[off + 3] = (pad.offColor?.r ?? 0) & 0xff;
    raw[off + 4] = (pad.offColor?.g ?? 45) & 0xff;
    raw[off + 5] = (pad.onColor?.r ?? 0) & 0xff;
    raw[off + 6] = (pad.onColor?.b ?? 150) & 0xff;
    raw[off + 7] = (pad.offColor?.b ?? 95) & 0xff;
    raw[off + 8] = (pad.onColor?.g ?? 255) & 0xff;
    raw[off + 9] = (pad.colorPreset ?? 10) & 0xff;
    let routeMask = 0;
    if (pad.sendToUsb !== false) routeMask |= 0x01;
    if (pad.sendToMidi !== false) routeMask |= 0x02;
    if (pad.sendToCv) routeMask |= 0x04;
    raw[off + 10] = routeMask;
    raw[off + 11] = pad.sendPolyAftertouch !== false ? 1 : 0;
  }

  // 0x382..0x3f1: 8 Custom Faders * 14 bytes (0x600b7744)
  for (let f = 0; f < 8; f++) {
    const fader = (project.faders && project.faders[f]) || {};
    const off = 0x382 + f * 14;
    raw[off + 0] = (fader.ccMode ?? 1) & 0xff;
    raw[off + 1] = (fader.cc1 ?? 74) & 0xff;
    raw[off + 2] = (fader.cc2 ?? 16 + f) & 0xff;
    raw[off + 3] = (fader.faderNote ?? 12) & 0xff;
    raw[off + 4] = (fader.midiChannel ?? 1) & 0xff;
    raw[off + 5] = (fader.faderColor?.r ?? 0) & 0xff;
    raw[off + 6] = (fader.faderColor?.g ?? 220) & 0xff;
    raw[off + 7] = (fader.faderColor?.b ?? 255) & 0xff;
    raw[off + 8] = (fader.tipColor?.r ?? 255) & 0xff;
    raw[off + 9] = (fader.tipColor?.g ?? 255) & 0xff;
    raw[off + 10] = (fader.tipColor?.b ?? 255) & 0xff;
    raw[off + 11] = (fader.style ?? 0) & 0xff;
    let routeMask = 0;
    if (fader.sendToUsb !== false) routeMask |= 0x01;
    if (fader.sendToMidi !== false) routeMask |= 0x02;
    if (fader.sendToCv) routeMask |= 0x04;
    raw[off + 12] = routeMask;
    raw[off + 13] = (fader.faderOctave ?? 3) & 0xff;
  }

  return raw;
}

/**
 * Decode a 1010-byte (0x3F2) raw Custom Mode Project buffer into a structured JS object
 */
function decodeCustomProjectRaw(rawBuf, slot = 1) {
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  if (raw.length < 0x3f2) {
    throw new Error(`Invalid Custom Project raw length: expected 1010 (0x3F2), got ${raw.length}`);
  }

  const name =
    raw
      .subarray(0, 8)
      .toString("ascii")
      .replace(/[^\x20-\x7e]/g, "")
      .trim() || `Project ${slot}`;
  const rootNote = raw[0x0c];
  const scale = raw[0x0d];

  const tracks = [];
  for (let t = 0; t < 8; t++) {
    const base = 0x0c + t * 14;
    const routeMask = raw[base + 9];
    tracks.push({
      index: t,
      trackType: raw[base + 6],
      midiChannel: raw[base + 7] || t + 1,
      rootNote: raw[base + 8],
      sendToUsb: Boolean(routeMask & 0x01),
      sendToMidi: Boolean(routeMask & 0x02),
      sendToCv: Boolean(routeMask & 0x04),
      timeDivision: raw[base + 10],
      gateLength: raw[base + 11],
      swing: raw[base + 12],
      velocity: raw[base + 13],
      octave: raw[base + 14],
      sendPolyAftertouch: Boolean(raw[base + 15] & 0x01),
    });
  }

  const pads = [];
  for (let p = 0; p < 64; p++) {
    const off = 0x82 + p * 12;
    const note = raw[off + 0];
    const octave = raw[off + 1];
    const routeMask = raw[off + 10];
    pads.push({
      index: p,
      row: Math.floor(p / 8),
      col: p % 8,
      note,
      octave,
      midiNote: Math.min(127, Math.max(0, octave * 12 + note)),
      midiChannel: raw[off + 2] || 1,
      offColor: { r: raw[off + 3], g: raw[off + 4], b: raw[off + 7] },
      onColor: { r: raw[off + 5], g: raw[off + 8], b: raw[off + 6] },
      colorPreset: raw[off + 9],
      sendToUsb: Boolean(routeMask & 0x01),
      sendToMidi: Boolean(routeMask & 0x02),
      sendToCv: Boolean(routeMask & 0x04),
      sendPolyAftertouch: Boolean(raw[off + 11] & 0x01),
    });
  }

  const defaultLabels = [
    "Filter Cutoff",
    "Resonance",
    "Env Attack",
    "Env Decay",
    "Env Sustain",
    "Env Release",
    "LFO Rate / Macro 7",
    "ModWheel / Macro 8",
  ];

  const faders = [];
  for (let f = 0; f < 8; f++) {
    const off = 0x382 + f * 14;
    const routeMask = raw[off + 12];
    faders.push({
      index: f,
      label: defaultLabels[f],
      ccMode: raw[off + 0],
      cc1: raw[off + 1],
      cc2: raw[off + 2],
      faderNote: raw[off + 3],
      midiChannel: raw[off + 4] || 1,
      faderColor: { r: raw[off + 5], g: raw[off + 6], b: raw[off + 7] },
      tipColor: { r: raw[off + 8], g: raw[off + 9], b: raw[off + 10] },
      style: raw[off + 11],
      sendToUsb: Boolean(routeMask & 0x01),
      sendToMidi: Boolean(routeMask & 0x02),
      sendToCv: Boolean(routeMask & 0x04),
      faderOctave: raw[off + 13],
      value: 64,
    });
  }

  return {
    slot,
    name,
    rootNote,
    scale,
    tracks,
    pads,
    faders,
  };
}

/**
 * Build SysEx msg_id 0x12 (Send Custom Mode Project to APC64, 1156 payload bytes)
 */
function buildCustomProjectSysEx(project) {
  const slot = project.slot ?? 0;
  const raw = encodeCustomProjectRaw(project);
  const packed = pack7Bit(raw); // 1010 raw bytes -> 1155 packed bytes
  const payloadLen = 1 + packed.length; // 1156 = 0x0484 (in 7-bit MSB/LSB: 0x09, 0x04)
  const lenMsb = (payloadLen >> 7) & 0x7f;
  const lenLsb = payloadLen & 0x7f;
  return Buffer.concat([
    Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x12, lenMsb, lenLsb, slot & 0x7f]),
    packed,
    Buffer.from([0xf7]),
  ]);
}

/**
 * Create default Global Settings object (matches 0x38 = 56-byte struct at 0x600ba05c)
 */
function createDefaultGlobalSettings() {
  return {
    deviceMode: 0, // 0 = Universal DAW (Ableton Live unlocked), 1 = Standalone
    syncSource: 0, // 0 = Internal, 1 = External Clock
    sendSyncToUsb: true,
    sendSyncToMidi: true,
    ledBrightness: 100,
    padSensitivity: 4, // 0..7 (Velocity curve / threshold)
    cvSources: [0, 1, 2, 3, 4, 5, 6, 7], // CV 1..8 Source
    cvChannels: [1, 1, 2, 2, 3, 3, 4, 4], // CV 1..8 MIDI Channel (1..16)
    drumNotes: [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51], // 16 Drum Notes
  };
}

/**
 * Encode Global Settings into 56 raw bytes (0x38) matching 0x600b9d28 / 0x600b9c94
 */
function encodeGlobalSettingsRaw(settings) {
  const raw = Buffer.alloc(0x38, 0);
  raw[0x00] = (settings.ledBrightness ?? 100) & 0xff;
  raw[0x14] = (settings.deviceMode ?? 0) & 0x01; // r4 + 0x20 (offset 0x14 from r4+0x0c)
  raw[0x15] = (settings.syncSource ?? 0) & 0x01; // r4 + 0x21
  let syncMask = 0;
  if (settings.sendSyncToUsb !== false) syncMask |= 0x01;
  if (settings.sendSyncToMidi !== false) syncMask |= 0x02;
  raw[0x16] = syncMask; // r4 + 0x22

  for (let i = 0; i < 8; i++) {
    raw[0x17 + i] = (settings.cvSources?.[i] ?? i) & 0xff;
    raw[0x1f + i] = (settings.cvChannels?.[i] ?? 1) & 0xff;
  }
  for (let i = 0; i < 16; i++) {
    raw[0x27 + i] = (settings.drumNotes?.[i] ?? 36 + i) & 0x7f;
  }
  raw[0x37] = (settings.padSensitivity ?? 4) & 0xff; // r4 + 0x43
  return raw;
}

/**
 * Decode 56 raw bytes (0x38) of Global Settings into a structured JS object
 */
function decodeGlobalSettingsRaw(rawBuf) {
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  if (raw.length < 0x38) {
    throw new Error(`Invalid Global Settings raw length: expected 56 (0x38), got ${raw.length}`);
  }
  const syncMask = raw[0x16];
  const cvSources = [];
  const cvChannels = [];
  for (let i = 0; i < 8; i++) {
    cvSources.push(raw[0x17 + i]);
    cvChannels.push(raw[0x1f + i] || 1);
  }
  const drumNotes = [];
  for (let i = 0; i < 16; i++) {
    drumNotes.push(raw[0x27 + i]);
  }
  return {
    ledBrightness: raw[0x00] || 100,
    deviceMode: raw[0x14] & 0x01,
    syncSource: raw[0x15] & 0x01,
    sendSyncToUsb: Boolean(syncMask & 0x01),
    sendSyncToMidi: Boolean(syncMask & 0x02),
    cvSources,
    cvChannels,
    drumNotes,
    padSensitivity: raw[0x37],
  };
}

/**
 * Build SysEx msg_id 0x18 (Send Global Settings to APC64, 64 packed payload bytes)
 */
function buildGlobalSettingsSysEx(settings) {
  const raw = encodeGlobalSettingsRaw(settings);
  const packed = pack7Bit(raw); // 56 raw bytes -> 64 (0x40) packed bytes
  const lenMsb = (packed.length >> 7) & 0x7f;
  const lenLsb = packed.length & 0x7f;
  return Buffer.concat([
    Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x18, lenMsb, lenLsb]),
    packed,
    Buffer.from([0xf7]),
  ]);
}

/**
 * Build OLED Display Line Text SysEx (msg_id 0x10 for lines 0..3, msg_id 0x1A for lines 4..7)
 */
function buildOledTextSysEx(lineIndex, text) {
  const clean = String(text || "").slice(0, 24);
  const ascii = Buffer.from(clean, "ascii");
  const msgId = lineIndex < 4 ? 0x10 : 0x1a;
  const subLine = lineIndex < 4 ? lineIndex : lineIndex - 4;
  const payloadLen = 1 + ascii.length;
  return Buffer.concat([
    Buffer.from([0xf0, 0x47, 0x00, 0x53, msgId, (payloadLen >> 7) & 0x7f, payloadLen & 0x7f, subLine & 0x03]),
    ascii,
    Buffer.from([0xf7]),
  ]);
}

/**
 * Build UI Mode Switch SysEx (msg_id 0x19, unlocked by FreeAPC64 Custom Firmware Patch 7)
 * Modes: 0=Device, 1=Mixer, 2=Session, 3=Note, 4=Scale, 6=Chord, 8=Custom, 9=StepSeq, 10=Project
 */
function buildUiModeSysEx(modeIndex) {
  if (modeIndex === undefined || modeIndex === null) {
    return Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x19, 0x00, 0x00, 0xf7]);
  }
  return Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x19, 0x00, 0x01, modeIndex & 0x7f, 0xf7]);
}

/**
 * Build Request SysEx messages (0x11 Custom Project, 0x13 Standalone, 0x15 StepSeq, 0x17 Global)
 */
function buildRequestSysEx(type, slot = 0, track = 0) {
  switch (type) {
    case "custom_project":
      return Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x11, 0x00, 0x01, slot & 0x7f, 0xf7]);
    case "standalone_project":
      return Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x13, 0x00, 0x01, slot & 0x7f, 0xf7]);
    case "stepseq_track":
      return Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x15, 0x00, 0x02, slot & 0x7f, track & 0x07, 0xf7]);
    case "global_settings":
      return Buffer.from([0xf0, 0x47, 0x00, 0x53, 0x17, 0x00, 0x00, 0xf7]);
    case "device_inquiry":
      return Buffer.from([0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7]);
    case "bootloader_inquiry":
      return Buffer.from([0xf0, 0x00, 0x00, 0x17, 0x70, 0xf7]);
    default:
      throw new Error(`Unknown request type: ${type}`);
  }
}

module.exports = {
  PERIPHERAL_ID,
  USB_VID,
  USB_PID,
  RBIN_CHUNK_SIZE,
  NOTE_NAMES,
  SCALES,
  APC64_PALETTE,
  crc32,
  pack7Bit,
  unpack7Bit,
  parseRbin,
  createDefaultProject,
  encodeCustomProjectRaw,
  decodeCustomProjectRaw,
  buildCustomProjectSysEx,
  createDefaultGlobalSettings,
  encodeGlobalSettingsRaw,
  decodeGlobalSettingsRaw,
  buildGlobalSettingsSysEx,
  buildOledTextSysEx,
  buildUiModeSysEx,
  buildRequestSysEx,
};
