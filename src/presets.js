/**
 * FreeAPC64 Synthesizer & Universal DAW Presets Library (v0.0.1)
 * ==============================================================
 * Ready-to-use templates for Bitwig Studio, Reaper, Hardware/VST Synthesizers
 * (Vital, Serum, Diva, Arturia, Roland/Moog/Korg CCs), Isomorphic 4th Layouts,
 * and Split Drum/Synth Performance Grids.
 */

"use strict";

const { createDefaultProject, SCALES } = require("./apc64-protocol");

function applyScaleToPads(pads, rootNote = 0, scaleKey = "minor", baseOctave = 2, rowInterval = 5, colors = {}) {
  const scale = SCALES[scaleKey] || SCALES.chromatic;
  const intervals = scale.intervals;
  const rootColor = colors.root || { r: 255, g: 40, b: 140 };
  const fifthColor = colors.fifth || { r: 0, g: 220, b: 255 };
  const inScaleColor = colors.inScale || { r: 15, g: 60, b: 130 };
  const onColor = colors.on || { r: 0, g: 255, b: 150 };

  for (let p = 0; p < 64; p++) {
    const row = Math.floor(p / 8);
    const col = p % 8;
    const scaleStep = row * rowInterval + col;
    const octOffset = Math.floor(scaleStep / intervals.length);
    const deg = ((scaleStep % intervals.length) + intervals.length) % intervals.length;
    const semitoneOffset = intervals[deg];
    const midiNote = Math.min(127, Math.max(0, (baseOctave + octOffset) * 12 + rootNote + semitoneOffset));
    const note = midiNote % 12;
    const octave = Math.floor(midiNote / 12);
    const isRoot = deg === 0;
    const isFifth = intervals[deg] === 7;

    pads[p] = {
      ...pads[p],
      index: p,
      row,
      col,
      note,
      octave,
      midiNote,
      offColor: isRoot ? { ...rootColor } : isFifth ? { ...fifthColor } : { ...inScaleColor },
      onColor: { ...onColor },
      colorPreset: isRoot ? 13 : isFifth ? 8 : 10,
    };
  }
}

function buildPresets() {
  // 1. Bitwig Studio 8-Remote Controls + Isomorphic Grid
  const bitwig = createDefaultProject(1, "Bitwig Studio Pro");
  bitwig.rootNote = 0; // C
  bitwig.scale = 2; // Natural Minor
  applyScaleToPads(bitwig.pads, 0, "minor", 2, 5, {
    root: { r: 255, g: 100, b: 0 },
    fifth: { r: 255, g: 200, b: 0 },
    inScale: { r: 50, g: 25, b: 5 },
    on: { r: 0, g: 255, b: 140 },
  });
  const bitwigFaders = [
    { label: "BW Remote 1 (Cutoff)", cc1: 20, cc2: 28, r: 255, g: 90, b: 0 },
    { label: "BW Remote 2 (Reso)", cc1: 21, cc2: 29, r: 255, g: 140, b: 0 },
    { label: "BW Remote 3 (Env Mod)", cc1: 22, cc2: 30, r: 255, g: 210, b: 0 },
    { label: "BW Remote 4 (Decay)", cc1: 23, cc2: 31, r: 130, g: 255, b: 0 },
    { label: "BW Remote 5 (Drive)", cc1: 24, cc2: 32, r: 0, g: 240, b: 140 },
    { label: "BW Remote 6 (Chorus)", cc1: 25, cc2: 33, r: 0, g: 180, b: 255 },
    { label: "BW Remote 7 (Delay)", cc1: 26, cc2: 34, r: 130, g: 60, b: 255 },
    { label: "BW Remote 8 (Reverb)", cc1: 27, cc2: 35, r: 255, g: 0, b: 180 },
  ];
  bitwig.faders.forEach((f, i) => {
    f.label = bitwigFaders[i].label;
    f.ccMode = 2; // Dual CC
    f.cc1 = bitwigFaders[i].cc1;
    f.cc2 = bitwigFaders[i].cc2;
    f.faderColor = { r: bitwigFaders[i].r, g: bitwigFaders[i].g, b: bitwigFaders[i].b };
  });

  // 2. Reaper DAW Mixer + ReaSynth / FX Parameter Control
  const reaper = createDefaultProject(2, "Reaper DAW Studio");
  applyScaleToPads(reaper.pads, 0, "chromatic", 2, 5, {
    root: { r: 0, g: 230, b: 110 },
    fifth: { r: 0, g: 160, b: 255 },
    inScale: { r: 10, g: 45, b: 40 },
    on: { r: 255, g: 230, b: 0 },
  });
  const reaperFaders = [
    { label: "Track 1 Vol / FX 1", cc1: 7, cc2: 16, ch: 1, r: 0, g: 230, b: 110 },
    { label: "Track 2 Vol / FX 2", cc1: 7, cc2: 17, ch: 2, r: 0, g: 230, b: 110 },
    { label: "Track 3 Vol / FX 3", cc1: 7, cc2: 18, ch: 3, r: 0, g: 190, b: 255 },
    { label: "Track 4 Vol / FX 4", cc1: 7, cc2: 19, ch: 4, r: 0, g: 190, b: 255 },
    { label: "Track 5 Vol / FX 5", cc1: 7, cc2: 20, ch: 5, r: 160, g: 80, b: 255 },
    { label: "Track 6 Vol / FX 6", cc1: 7, cc2: 21, ch: 6, r: 160, g: 80, b: 255 },
    { label: "Track 7 Vol / FX 7", cc1: 7, cc2: 22, ch: 7, r: 255, g: 90, b: 150 },
    { label: "Master / ReaFX 8", cc1: 7, cc2: 23, ch: 8, r: 255, g: 220, b: 0 },
  ];
  reaper.faders.forEach((f, i) => {
    f.label = reaperFaders[i].label;
    f.ccMode = 2;
    f.cc1 = reaperFaders[i].cc1;
    f.cc2 = reaperFaders[i].cc2;
    f.midiChannel = reaperFaders[i].ch;
    f.faderColor = { r: reaperFaders[i].r, g: reaperFaders[i].g, b: reaperFaders[i].b };
  });

  // 3. Hardware & VST Synthesizer Master Controller (Standard MIDI CCs + Poly AT)
  const synthMaster = createDefaultProject(3, "Synth Master CC");
  applyScaleToPads(synthMaster.pads, 0, "dorian", 2, 5, {
    root: { r: 255, g: 0, b: 180 },
    fifth: { r: 0, g: 220, b: 255 },
    inScale: { r: 30, g: 15, b: 70 },
    on: { r: 0, g: 255, b: 200 },
  });
  const synthFaders = [
    { label: "VCF Cutoff (CC74)", cc1: 74, cc2: 1, style: 0, r: 0, g: 220, b: 255 },
    { label: "VCF Resonance (CC71)", cc1: 71, cc2: 11, style: 0, r: 0, g: 140, b: 255 },
    { label: "Env Attack (CC73)", cc1: 73, cc2: 75, style: 0, r: 0, g: 255, b: 140 },
    { label: "Env Decay (CC75)", cc1: 75, cc2: 79, style: 0, r: 130, g: 255, b: 0 },
    { label: "Env Sustain (CC79)", cc1: 79, cc2: 72, style: 0, r: 255, g: 230, b: 0 },
    { label: "Env Release (CC72)", cc1: 72, cc2: 5, style: 0, r: 255, g: 120, b: 0 },
    { label: "LFO Rate / Detune (CC76)", cc1: 76, cc2: 94, style: 1, r: 190, g: 40, b: 255 },
    { label: "FX Reverb / Delay (CC91)", cc1: 91, cc2: 93, style: 0, r: 255, g: 0, b: 160 },
  ];
  synthMaster.faders.forEach((f, i) => {
    f.label = synthFaders[i].label;
    f.ccMode = 2;
    f.cc1 = synthFaders[i].cc1;
    f.cc2 = synthFaders[i].cc2;
    f.style = synthFaders[i].style;
    f.sendToCv = true;
    f.faderColor = { r: synthFaders[i].r, g: synthFaders[i].g, b: synthFaders[i].b };
  });

  // 4. Hybrid 16-Drum Rack (Left 4x4, Ch 10) + Lead Synth Scale (Right 4x8, Ch 1)
  const hybridSplit = createDefaultProject(4, "Drum + Synth Split");
  for (let p = 0; p < 64; p++) {
    const row = Math.floor(p / 8);
    const col = p % 8;
    if (col < 4 && row < 4) {
      // Bottom-left 4x4 Drum Rack on MIDI Channel 10
      const drumIdx = row * 4 + col;
      const midiNote = 36 + drumIdx;
      hybridSplit.pads[p] = {
        ...hybridSplit.pads[p],
        note: midiNote % 12,
        octave: Math.floor(midiNote / 12),
        midiNote,
        midiChannel: 10,
        offColor: { r: 255, g: 140, b: 0 },
        onColor: { r: 255, g: 255, b: 255 },
        colorPreset: 2,
      };
    } else if (col < 4 && row >= 4) {
      // Top-left 4x4 Bass Synth on MIDI Channel 2
      const bassStep = (row - 4) * 4 + col;
      const midiNote = 24 + bassStep;
      hybridSplit.pads[p] = {
        ...hybridSplit.pads[p],
        note: midiNote % 12,
        octave: Math.floor(midiNote / 12),
        midiNote,
        midiChannel: 2,
        offColor: { r: 180, g: 0, b: 255 },
        onColor: { r: 0, g: 255, b: 255 },
        colorPreset: 12,
      };
    } else {
      // Right 4x8 Lead Synth on MIDI Channel 1
      const leadStep = row * 4 + (col - 4);
      const midiNote = 48 + leadStep;
      hybridSplit.pads[p] = {
        ...hybridSplit.pads[p],
        note: midiNote % 12,
        octave: Math.floor(midiNote / 12),
        midiNote,
        midiChannel: 1,
        offColor: { r: 0, g: 160, b: 255 },
        onColor: { r: 0, g: 255, b: 120 },
        colorPreset: 9,
      };
    }
  }

  return {
    bitwig_studio: {
      id: "bitwig_studio",
      title: "Bitwig Studio — 8 Remote Controls + Isomorphic Grid",
      daw: "Bitwig Studio",
      description:
        "Configura los 8 Touchstrips para enviar CC 20–27 (y CC 28–35 en modo Dual) hacia las 8 páginas de Remote Controls de Bitwig, con grilla isométrica en 4tas con Poly Aftertouch.",
      project: bitwig,
    },
    reaper_daw: {
      id: "reaper_daw",
      title: "Reaper DAW — Multi-Channel Mixer + ReaFX Macros",
      daw: "Reaper",
      description:
        "Configura los 8 Touchstrips en canales MIDI 1–8 (Volumen CC7 + Macro FX CC16–23) y grilla de 64 pads cromáticos listos para MIDI Learn / ReaLearn en Reaper.",
      project: reaper,
    },
    synth_master: {
      id: "synth_master",
      title: "Hardware & VST Synthesizer — Filter / ADSR / LFO / CV",
      daw: "Universal Synth (USB / DIN MIDI / CV)",
      description:
        "Transforma el APC64 en una superficie de control de sintetizador completa: Cutoff (CC74), Resonance (CC71), ADSR (CC73/75/79/72), LFO Rate (CC76), Reverb/Delay (CC91/93) y salidas CV/Gate activas.",
      project: synthMaster,
    },
    hybrid_split: {
      id: "hybrid_split",
      title: "Live Performance Split — 4x4 Drums (Ch10) + Bass (Ch2) + Lead (Ch1)",
      daw: "All DAWs / Hardware Setup",
      description:
        "Divide la matriz de 64 pads en 3 zonas simultáneas: 16 Drum Pads abajo a la izquierda (Canal 10), 16 Pads de Bajo arriba a la izquierda (Canal 2), y 32 Pads de Sintetizador Lead a la derecha (Canal 1).",
      project: hybridSplit,
    },
  };
}

module.exports = {
  applyScaleToPads,
  buildPresets,
};
