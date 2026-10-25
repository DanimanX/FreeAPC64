/**
 * FreeAPC64 Web Project Editor, Synth CC Workstation & WebMIDI Firmware Updater (v0.0.1)
 */

(function () {
  "use strict";

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const state = {
    project: null,
    globalSettings: null,
    firmware: null,
    palette: [],
    oledLines: [
      "FreeAPC64 v0.0.1",
      "Universal DAW Ready",
      "Synth CC: Unlocked",
      "BPM: 120.0 | Ch: 1",
    ],
    selectedPadIndex: 0,
    selectedFaderIndex: 0,
    midiAccess: null,
    midiIn: null,
    midiOut: null,
    synthParams: {
      waveform: "sawtooth",
      cutoff: 92, // CC 74
      resonance: 28, // CC 71
      attack: 12, // CC 73
      decay: 48, // CC 75
      sustain: 90, // CC 79
      release: 42, // CC 72
      lfoRate: 30, // CC 76
      modWheel: 20, // CC 1
      portamento: 0, // CC 5
      expression: 110, // CC 11
      chorus: 35, // CC 93
      reverb: 45, // CC 91
      bwRemote1: 64, // CC 20
      bwRemote2: 64, // CC 21
      reaperMacro1: 64, // CC 16
      reaperMacro2: 64, // CC 17
    },
  };

  // =========================================================================
  // Built-in WebAudio Polyphonic Synth Engine (Responds to Pads & MIDI CCs!)
  // =========================================================================
  let audioCtx = null;
  const activeVoices = new Map();

  function ensureAudio() {
    const chk = document.getElementById("chk-webaudio");
    if (!chk || !chk.checked) return null;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function midiNoteToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  function triggerSynthNoteOn(midiNote, velocity = 100) {
    const ctx = ensureAudio();
    if (!ctx) return;
    triggerSynthNoteOff(midiNote);

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const subOsc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const vca = ctx.createGain();

    osc.type = state.synthParams.waveform || "sawtooth";
    osc.frequency.setValueAtTime(midiNoteToFreq(midiNote), now);

    subOsc.type = "triangle";
    subOsc.frequency.setValueAtTime(midiNoteToFreq(Math.max(0, midiNote - 12)), now);

    const cutoffNorm = (state.synthParams.cutoff ?? 90) / 127;
    const cutoffHz = 80 * Math.pow(180, cutoffNorm);
    const qVal = 0.7 + ((state.synthParams.resonance ?? 25) / 127) * 14;

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoffHz, now);
    filter.Q.setValueAtTime(qVal, now);

    const atk = 0.005 + ((state.synthParams.attack ?? 12) / 127) * 0.8;
    const dec = 0.04 + ((state.synthParams.decay ?? 48) / 127) * 1.0;
    const sus = Math.max(0.05, (state.synthParams.sustain ?? 90) / 127);
    const peakGain = (velocity / 127) * 0.22;

    vca.gain.setValueAtTime(0.0001, now);
    vca.gain.linearRampToValueAtTime(peakGain, now + atk);
    vca.gain.linearRampToValueAtTime(peakGain * sus, now + atk + dec);

    osc.connect(filter);
    subOsc.connect(filter);
    filter.connect(vca);
    vca.connect(ctx.destination);

    osc.start(now);
    subOsc.start(now);
    activeVoices.set(midiNote, { osc, subOsc, filter, vca });
  }

  function triggerSynthNoteOff(midiNote) {
    const voice = activeVoices.get(midiNote);
    if (!voice || !audioCtx) return;
    const now = audioCtx.currentTime;
    const rel = 0.03 + ((state.synthParams.release ?? 40) / 127) * 1.2;
    voice.vca.gain.cancelScheduledValues(now);
    voice.vca.gain.setValueAtTime(Math.max(0.0001, voice.vca.gain.value), now);
    voice.vca.gain.exponentialRampToValueAtTime(0.0001, now + rel);
    voice.osc.stop(now + rel + 0.02);
    voice.subOsc.stop(now + rel + 0.02);
    activeVoices.delete(midiNote);
  }

  function updateActiveVoicesFilter() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const cutoffNorm = (state.synthParams.cutoff ?? 90) / 127;
    const cutoffHz = 80 * Math.pow(180, cutoffNorm);
    const qVal = 0.7 + ((state.synthParams.resonance ?? 25) / 127) * 14;
    for (const voice of activeVoices.values()) {
      voice.filter.frequency.setTargetAtTime(cutoffHz, now, 0.015);
      voice.filter.Q.setTargetAtTime(qVal, now, 0.015);
    }
  }

  // =========================================================================
  // Helpers: Colors, MIDI Monitoring & OLED Screen Canvas
  // =========================================================================
  function rgbToHex({ r = 0, g = 0, b = 0 }) {
    const toH = (n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, "0");
    return `#${toH(r)}${toH(g)}${toH(b)}`;
  }

  function hexToRgb(hex) {
    const clean = String(hex || "#000000").replace("#", "");
    return {
      r: parseInt(clean.substring(0, 2), 16) || 0,
      g: parseInt(clean.substring(2, 4), 16) || 0,
      b: parseInt(clean.substring(4, 6), 16) || 0,
    };
  }

  function setMidiMonitor(text) {
    const el = document.getElementById("last-midi-monitor");
    if (el) el.textContent = text;
  }

  function sendMidiBytes(bytes) {
    if (state.midiOut) {
      try {
        state.midiOut.send(bytes);
      } catch (err) {
        console.warn("WebMIDI send error:", err);
      }
    }
  }

  function renderOledCanvas() {
    const canvas = document.getElementById("oled-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Top status bar
    ctx.fillStyle = "#00dcff";
    ctx.fillRect(0, 0, canvas.width, 20);
    ctx.fillStyle = "#000000";
    ctx.font = "bold 12px monospace";
    ctx.fillText(state.oledLines[0] || "FreeAPC64 v0.0.1", 6, 14);

    // Lines 1..3
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 14px monospace";
    ctx.fillText(state.oledLines[1] || "Universal DAW Ready", 6, 44);

    ctx.fillStyle = "#00ff96";
    ctx.font = "13px monospace";
    ctx.fillText(state.oledLines[2] || "Synth CC: Unlocked", 6, 68);

    ctx.fillStyle = "#ffb400";
    ctx.font = "12px monospace";
    ctx.fillText(state.oledLines[3] || "USB + MIDI + CV OK", 6, 92);

    // Bottom fader mini bargraph on OLED
    if (state.project && state.project.faders) {
      for (let i = 0; i < 8; i++) {
        const val = state.project.faders[i]?.value ?? 64;
        const barH = Math.round((val / 127) * 22);
        const x = 8 + i * 30;
        ctx.strokeStyle = "#334466";
        ctx.strokeRect(x, 100, 22, 22);
        ctx.fillStyle = "#00dcff";
        ctx.fillRect(x + 1, 100 + (22 - barH), 20, barH);
      }
    }
  }

  // =========================================================================
  // Render 8x8 RGB Pad Grid
  // =========================================================================
  function renderPadGrid() {
    const container = document.getElementById("pad-grid");
    if (!container || !state.project) return;
    container.innerHTML = "";

    // Render rows 7 down to 0 so Pad 0 is bottom-left and Pad 63 is top-right
    for (let row = 7; row >= 0; row--) {
      for (let col = 0; col < 8; col++) {
        const idx = row * 8 + col;
        const pad = state.project.pads[idx];
        const padEl = document.createElement("div");
        padEl.className = "apc-pad" + (idx === state.selectedPadIndex ? " selected" : "");
        padEl.dataset.index = idx;

        const offHex = rgbToHex(pad.offColor);
        const onHex = rgbToHex(pad.onColor);
        padEl.style.background = `radial-gradient(circle at 50% 35%, ${offHex}ee, ${offHex}66 85%, #0c1018)`;
        padEl.style.boxShadow = `0 0 10px ${offHex}55, inset 0 0 8px ${offHex}44`;

        const noteName = `${NOTE_NAMES[pad.note % 12]}${pad.octave}`;
        padEl.innerHTML = `
          <div class="pad-top">
            <span>P${idx + 1}</span>
            <span>Ch${pad.midiChannel}</span>
          </div>
          <div class="pad-note-label">${noteName} (${pad.midiNote})</div>
          <div class="pad-bottom">${pad.sendPolyAftertouch ? "PolyAT" : "Note"} &bull; ${
          pad.sendToUsb ? "USB" : ""
        }${pad.sendToMidi ? "+DIN" : ""}${pad.sendToCv ? "+CV" : ""}</div>
        `;

        const handleDown = (e) => {
          e.preventDefault();
          state.selectedPadIndex = idx;
          updatePadInspector();
          document.querySelectorAll(".apc-pad.selected").forEach((el) => el.classList.remove("selected"));
          padEl.classList.add("selected", "playing");
          padEl.style.background = `radial-gradient(circle, ${onHex}, ${offHex})`;
          padEl.style.boxShadow = `0 0 18px ${onHex}`;

          const ch = ((pad.midiChannel || 1) - 1) & 0x0f;
          const note = pad.midiNote & 0x7f;
          sendMidiBytes([0x90 | ch, note, 110]);
          if (pad.sendPolyAftertouch) {
            sendMidiBytes([0xa0 | ch, note, 96]);
          }
          triggerSynthNoteOn(note, 110);

          state.oledLines[1] = `Pad #${idx + 1}: ${noteName} (${note})`;
          state.oledLines[2] = `Note On Ch ${pad.midiChannel} Vel 110`;
          renderOledCanvas();
          setMidiMonitor(`TX NoteOn: ${noteName} (${note}) | Ch ${pad.midiChannel} | PolyAT=${pad.sendPolyAftertouch ? "On" : "Off"}`);
        };

        const handleUp = () => {
          if (!padEl.classList.contains("playing")) return;
          padEl.classList.remove("playing");
          padEl.style.background = `radial-gradient(circle at 50% 35%, ${offHex}ee, ${offHex}66 85%, #0c1018)`;
          padEl.style.boxShadow = `0 0 10px ${offHex}55, inset 0 0 8px ${offHex}44`;
          const ch = ((pad.midiChannel || 1) - 1) & 0x0f;
          const note = pad.midiNote & 0x7f;
          sendMidiBytes([0x80 | ch, note, 0]);
          triggerSynthNoteOff(note);
        };

        padEl.addEventListener("pointerdown", handleDown);
        padEl.addEventListener("pointerup", handleUp);
        padEl.addEventListener("pointerleave", handleUp);
        container.appendChild(padEl);
      }
    }
  }

  // =========================================================================
  // Render 8 RGB Touchstrip Faders
  // =========================================================================
  function renderFaders() {
    const container = document.getElementById("fader-strip-container");
    if (!container || !state.project) return;
    container.innerHTML = "";

    state.project.faders.forEach((fader, fIdx) => {
      const col = document.createElement("div");
      col.className = "touchstrip-col" + (fIdx === state.selectedFaderIndex ? " selected" : "");
      const barHex = rgbToHex(fader.faderColor);
      const tipHex = rgbToHex(fader.tipColor);
      const ccText =
        fader.ccMode === 0
          ? "CC Off"
          : fader.ccMode === 2
          ? `CC ${fader.cc1} + ${fader.cc2}`
          : `CC ${fader.cc1}`;

      col.innerHTML = `
        <div class="ts-title" title="${fader.label || `Fader ${fIdx + 1}`}">${fader.label || `Fader ${fIdx + 1}`}</div>
        <div class="ts-cc-badge">${ccText} &bull; Ch${fader.midiChannel}</div>
        <div class="ts-track" data-fader="${fIdx}"></div>
        <div class="ts-val-label" id="ts-val-${fIdx}">Val: ${fader.value ?? 64}</div>
      `;

      const track = col.querySelector(".ts-track");
      const dots = [];
      for (let d = 15; d >= 0; d--) {
        const dot = document.createElement("div");
        dot.className = "ts-led-dot";
        track.appendChild(dot);
        dots.push(dot);
      }

      function paintDots(val) {
        const activeIdx = Math.round((val / 127) * 15);
        dots.forEach((dot, dPos) => {
          const ledNum = 15 - dPos; // 0 at bottom, 15 at top
          let lit = false;
          let isTip = ledNum === activeIdx;
          if (fader.style === 1) {
            // Pan / Bipolar from center (7..8)
            const minB = Math.min(7, activeIdx);
            const maxB = Math.max(8, activeIdx);
            lit = ledNum >= minB && ledNum <= maxB;
          } else {
            lit = ledNum <= activeIdx;
          }
          if (isTip) {
            dot.style.background = tipHex;
            dot.style.boxShadow = `0 0 6px ${tipHex}`;
          } else if (lit) {
            dot.style.background = barHex;
            dot.style.boxShadow = `0 0 5px ${barHex}`;
          } else {
            dot.style.background = "#1b2334";
            dot.style.boxShadow = "none";
          }
        });
      }

      paintDots(fader.value ?? 64);

      function updateFromPointer(e) {
        const rect = track.getBoundingClientRect();
        const relY = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
        const val = Math.round(relY * 127);
        fader.value = val;
        paintDots(val);
        const lbl = document.getElementById(`ts-val-${fIdx}`);
        if (lbl) lbl.textContent = `Val: ${val}`;

        // Send MIDI CC1 (+ CC2 if Dual CC) & PitchBend (mirroring patched firmware 0x600b1ac0!)
        const ch = ((fader.midiChannel || 1) - 1) & 0x0f;
        if (fader.ccMode >= 1) {
          sendMidiBytes([0xb0 | ch, fader.cc1 & 0x7f, val & 0x7f]);
          applyCcToInternalSynth(fader.cc1, val);
        }
        if (fader.ccMode === 2) {
          const val2 = 127 - val;
          sendMidiBytes([0xb0 | ch, fader.cc2 & 0x7f, val2 & 0x7f]);
        }
        // Also update OLED & MIDI Monitor
        state.oledLines[1] = `Fader ${fIdx + 1}: ${fader.label}`;
        state.oledLines[2] = `CC ${fader.cc1} = ${val} (Ch ${fader.midiChannel})`;
        renderOledCanvas();
        setMidiMonitor(
          `TX Touchstrip #${fIdx + 1} (${fader.label}): CC ${fader.cc1}=${val}${
            fader.ccMode === 2 ? ` & CC ${fader.cc2}=${127 - val}` : ""
          } | Ch ${fader.midiChannel}`
        );
      }

      let dragging = false;
      track.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        dragging = true;
        track.setPointerCapture(e.pointerId);
        state.selectedFaderIndex = fIdx;
        updateFaderInspector();
        document.querySelectorAll(".touchstrip-col.selected").forEach((el) => el.classList.remove("selected"));
        col.classList.add("selected");
        updateFromPointer(e);
      });
      track.addEventListener("pointermove", (e) => {
        if (dragging) updateFromPointer(e);
      });
      track.addEventListener("pointerup", () => {
        dragging = false;
      });

      col.addEventListener("click", () => {
        state.selectedFaderIndex = fIdx;
        updateFaderInspector();
        document.querySelectorAll(".touchstrip-col.selected").forEach((el) => el.classList.remove("selected"));
        col.classList.add("selected");
      });

      container.appendChild(col);
    });
  }

  function applyCcToInternalSynth(cc, val) {
    if (cc === 74 || cc === 20) state.synthParams.cutoff = val;
    else if (cc === 71 || cc === 21) state.synthParams.resonance = val;
    else if (cc === 73 || cc === 22) state.synthParams.attack = val;
    else if (cc === 75 || cc === 23) state.synthParams.decay = val;
    else if (cc === 79 || cc === 24) state.synthParams.sustain = val;
    else if (cc === 72 || cc === 25) state.synthParams.release = val;
    else if (cc === 76 || cc === 26) state.synthParams.lfoRate = val;
    else if (cc === 1 || cc === 27) state.synthParams.modWheel = val;
    updateActiveVoicesFilter();
    const rackSlider = document.querySelector(`.synth-param-slider[data-cc="${cc}"]`);
    if (rackSlider) {
      rackSlider.value = val;
      const valSpan = document.getElementById(`synth-val-${cc}`);
      if (valSpan) valSpan.textContent = val;
    }
  }

  // =========================================================================
  // Inspectors: Selected Pad & Selected Touchstrip Fader
  // =========================================================================
  function updatePadInspector() {
    if (!state.project) return;
    const idx = state.selectedPadIndex;
    const pad = state.project.pads[idx];
    if (!pad) return;

    const row = Math.floor(idx / 8) + 1;
    const col = (idx % 8) + 1;
    document.getElementById("pad-inspector-title").textContent = `Inspector: Pad #${idx + 1} (Fila ${row}, Col ${col})`;
    document.getElementById("pad-note").value = pad.note;
    document.getElementById("pad-octave").value = pad.octave;
    document.getElementById("pad-channel").value = pad.midiChannel;
    document.getElementById("pad-poly-at").value = pad.sendPolyAftertouch ? "1" : "0";
    document.getElementById("pad-color-off").value = rgbToHex(pad.offColor);
    document.getElementById("pad-color-on").value = rgbToHex(pad.onColor);
    document.getElementById("pad-usb").checked = Boolean(pad.sendToUsb);
    document.getElementById("pad-midi").checked = Boolean(pad.sendToMidi);
    document.getElementById("pad-cv").checked = Boolean(pad.sendToCv);
  }

  function bindPadInspectorEvents() {
    const applyChanges = () => {
      const pad = state.project.pads[state.selectedPadIndex];
      if (!pad) return;
      pad.note = Number(document.getElementById("pad-note").value);
      pad.octave = Number(document.getElementById("pad-octave").value);
      pad.midiNote = Math.min(127, Math.max(0, pad.octave * 12 + pad.note));
      pad.midiChannel = Number(document.getElementById("pad-channel").value);
      pad.sendPolyAftertouch = document.getElementById("pad-poly-at").value === "1";
      pad.offColor = hexToRgb(document.getElementById("pad-color-off").value);
      pad.onColor = hexToRgb(document.getElementById("pad-color-on").value);
      pad.sendToUsb = document.getElementById("pad-usb").checked;
      pad.sendToMidi = document.getElementById("pad-midi").checked;
      pad.sendToCv = document.getElementById("pad-cv").checked;
      renderPadGrid();
    };

    [
      "pad-note",
      "pad-octave",
      "pad-channel",
      "pad-poly-at",
      "pad-color-off",
      "pad-color-on",
      "pad-usb",
      "pad-midi",
      "pad-cv",
    ].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", applyChanges);
      document.getElementById(id)?.addEventListener("change", applyChanges);
    });

    document.getElementById("btn-copy-pad-all")?.addEventListener("click", () => {
      const src = state.project.pads[state.selectedPadIndex];
      state.project.pads.forEach((p) => {
        p.midiChannel = src.midiChannel;
        p.sendPolyAftertouch = src.sendPolyAftertouch;
        p.sendToUsb = src.sendToUsb;
        p.sendToMidi = src.sendToMidi;
        p.sendToCv = src.sendToCv;
      });
      renderPadGrid();
      setMidiMonitor(`Copiado Canal ${src.midiChannel} y ruteo USB/DIN/CV a los 64 Pads.`);
    });
  }

  function renderPaletteSwatches() {
    const wrap = document.getElementById("palette-swatches");
    if (!wrap) return;
    wrap.innerHTML = "";
    state.palette.forEach((sw) => {
      const btn = document.createElement("button");
      btn.className = "swatch-btn";
      btn.title = `${sw.name} (#${sw.index})`;
      btn.style.background = rgbToHex(sw);
      btn.addEventListener("click", () => {
        const pad = state.project.pads[state.selectedPadIndex];
        pad.offColor = { r: sw.r, g: sw.g, b: sw.b };
        pad.colorPreset = sw.index;
        updatePadInspector();
        renderPadGrid();
      });
      wrap.appendChild(btn);
    });
  }

  function updateFaderInspector() {
    if (!state.project) return;
    const fIdx = state.selectedFaderIndex;
    const fader = state.project.faders[fIdx];
    if (!fader) return;

    document.getElementById("fader-inspector-title").textContent = `Inspector: Touchstrip Fader #${fIdx + 1}`;
    document.getElementById("fader-label").value = fader.label || `Fader ${fIdx + 1}`;
    document.getElementById("fader-cc-mode").value = fader.ccMode;
    document.getElementById("fader-style").value = fader.style;
    document.getElementById("fader-cc1").value = fader.cc1;
    document.getElementById("fader-cc2").value = fader.cc2;
    document.getElementById("fader-channel").value = fader.midiChannel;
    document.getElementById("fader-note").value = fader.faderNote;
    document.getElementById("fader-color-bar").value = rgbToHex(fader.faderColor);
    document.getElementById("fader-color-tip").value = rgbToHex(fader.tipColor);
    document.getElementById("fader-usb").checked = Boolean(fader.sendToUsb);
    document.getElementById("fader-midi").checked = Boolean(fader.sendToMidi);
    document.getElementById("fader-cv").checked = Boolean(fader.sendToCv);
  }

  function bindFaderInspectorEvents() {
    const applyFader = () => {
      const fader = state.project.faders[state.selectedFaderIndex];
      if (!fader) return;
      fader.label = document.getElementById("fader-label").value;
      fader.ccMode = Number(document.getElementById("fader-cc-mode").value);
      fader.style = Number(document.getElementById("fader-style").value);
      fader.cc1 = Number(document.getElementById("fader-cc1").value);
      fader.cc2 = Number(document.getElementById("fader-cc2").value);
      fader.midiChannel = Number(document.getElementById("fader-channel").value);
      fader.faderNote = Number(document.getElementById("fader-note").value);
      fader.faderColor = hexToRgb(document.getElementById("fader-color-bar").value);
      fader.tipColor = hexToRgb(document.getElementById("fader-color-tip").value);
      fader.sendToUsb = document.getElementById("fader-usb").checked;
      fader.sendToMidi = document.getElementById("fader-midi").checked;
      fader.sendToCv = document.getElementById("fader-cv").checked;
      renderFaders();
    };

    [
      "fader-label",
      "fader-cc-mode",
      "fader-style",
      "fader-cc1",
      "fader-cc2",
      "fader-channel",
      "fader-note",
      "fader-color-bar",
      "fader-color-tip",
      "fader-usb",
      "fader-midi",
      "fader-cv",
    ].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", applyFader);
      document.getElementById(id)?.addEventListener("change", applyFader);
    });
  }

  // =========================================================================
  // Tab 2: Synthesizer & Universal MIDI CC Rack
  // =========================================================================
  const SYNTH_CC_DEFINITIONS = [
    { key: "cutoff", name: "VCF Filter Cutoff", cc: 74, ch: 1 },
    { key: "resonance", name: "VCF Filter Resonance", cc: 71, ch: 1 },
    { key: "attack", name: "Envelope Attack", cc: 73, ch: 1 },
    { key: "decay", name: "Envelope Decay", cc: 75, ch: 1 },
    { key: "sustain", name: "Envelope Sustain", cc: 79, ch: 1 },
    { key: "release", name: "Envelope Release", cc: 72, ch: 1 },
    { key: "lfoRate", name: "LFO Rate / Modulation", cc: 76, ch: 1 },
    { key: "modWheel", name: "Modulation Wheel", cc: 1, ch: 1 },
    { key: "portamento", name: "Glide / Portamento Time", cc: 5, ch: 1 },
    { key: "expression", name: "Expression / Drive", cc: 11, ch: 1 },
    { key: "chorus", name: "Chorus / Stereo Detune", cc: 93, ch: 1 },
    { key: "reverb", name: "Reverb Send / Space", cc: 91, ch: 1 },
    { key: "bwRemote1", name: "Bitwig Remote Control 1", cc: 20, ch: 1 },
    { key: "bwRemote2", name: "Bitwig Remote Control 2", cc: 21, ch: 1 },
    { key: "reaperMacro1", name: "Reaper ReaLearn Macro 1", cc: 16, ch: 1 },
    { key: "reaperMacro2", name: "Reaper ReaLearn Macro 2", cc: 17, ch: 1 },
  ];

  function renderSynthRack() {
    const container = document.getElementById("synth-cc-rack");
    if (!container) return;
    container.innerHTML = "";

    SYNTH_CC_DEFINITIONS.forEach((def) => {
      const val = state.synthParams[def.key] ?? 64;
      const card = document.createElement("div");
      card.className = "synth-param-card";
      card.innerHTML = `
        <div class="synth-param-top">
          <span>${def.name}</span>
          <span class="synth-param-cc">CC ${def.cc} = <strong id="synth-val-${def.cc}">${val}</strong></span>
        </div>
        <input type="range" class="synth-param-slider" data-cc="${def.cc}" data-key="${def.key}" min="0" max="127" value="${val}" />
      `;
      const slider = card.querySelector("input");
      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        state.synthParams[def.key] = v;
        document.getElementById(`synth-val-${def.cc}`).textContent = v;
        updateActiveVoicesFilter();
        sendMidiBytes([0xb0 | ((def.ch - 1) & 0x0f), def.cc & 0x7f, v & 0x7f]);
        setMidiMonitor(`TX Synth Rack: ${def.name} (CC ${def.cc}) = ${v}`);
      });
      container.appendChild(card);
    });
  }

  // =========================================================================
  // Tab 3: Standalone Step Sequencer & 8 Tracks
  // =========================================================================
  function renderTracksTab() {
    const container = document.getElementById("tracks-container");
    if (!container || !state.project) return;
    container.innerHTML = "";

    const timeDivisions = ["1/4", "1/4T", "1/8", "1/8T", "1/16", "1/16T", "1/32", "1/32T"];

    state.project.tracks.forEach((trk, idx) => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-header">
          <h3>Pista #${idx + 1} (Secuenciador / Standalone)</h3>
        </div>
        <div class="form-grid-2">
          <div>
            <label>Tipo de Pista:</label>
            <select data-trk="${idx}" data-field="trackType">
              <option value="0" ${trk.trackType === 0 ? "selected" : ""}>Melódica / Synth</option>
              <option value="1" ${trk.trackType === 1 ? "selected" : ""}>Drum / Percusión</option>
            </select>
          </div>
          <div>
            <label>Canal MIDI (1–16):</label>
            <input type="number" min="1" max="16" value="${trk.midiChannel}" data-trk="${idx}" data-field="midiChannel" />
          </div>
          <div>
            <label>División de Tiempo:</label>
            <select data-trk="${idx}" data-field="timeDivision">
              ${timeDivisions
                .map((td, i) => `<option value="${i}" ${trk.timeDivision === i ? "selected" : ""}>${td}</option>`)
                .join("")}
            </select>
          </div>
          <div>
            <label>Gate Length (1–100%):</label>
            <input type="number" min="1" max="100" value="${trk.gateLength}" data-trk="${idx}" data-field="gateLength" />
          </div>
          <div>
            <label>Swing (50–75%):</label>
            <input type="number" min="50" max="75" value="${trk.swing}" data-trk="${idx}" data-field="swing" />
          </div>
          <div>
            <label>Velocidad Base (1–127):</label>
            <input type="number" min="1" max="127" value="${trk.velocity}" data-trk="${idx}" data-field="velocity" />
          </div>
        </div>
        <div class="routing-row">
          <label><input type="checkbox" data-trk="${idx}" data-field="sendToUsb" ${trk.sendToUsb ? "checked" : ""} /> USB</label>
          <label><input type="checkbox" data-trk="${idx}" data-field="sendToMidi" ${trk.sendToMidi ? "checked" : ""} /> MIDI DIN</label>
          <label><input type="checkbox" data-trk="${idx}" data-field="sendToCv" ${trk.sendToCv ? "checked" : ""} /> CV/Gate</label>
        </div>
      `;

      card.querySelectorAll("input, select").forEach((el) => {
        el.addEventListener("change", () => {
          const field = el.dataset.field;
          if (el.type === "checkbox") {
            trk[field] = el.checked;
          } else {
            trk[field] = Number(el.value);
          }
        });
      });

      container.appendChild(card);
    });
  }

  // =========================================================================
  // Tab 4: Global Settings (SysEx 0x18 — 56 Bytes)
  // =========================================================================
  function renderGlobalTab() {
    if (!state.globalSettings) return;
    const gs = state.globalSettings;
    document.getElementById("global-device-mode").value = gs.deviceMode;
    document.getElementById("global-sync-source").value = gs.syncSource;
    document.getElementById("global-led-brightness").value = gs.ledBrightness;
    document.getElementById("global-pad-sensitivity").value = gs.padSensitivity;
    document.getElementById("global-sync-usb").checked = Boolean(gs.sendSyncToUsb);
    document.getElementById("global-sync-midi").checked = Boolean(gs.sendSyncToMidi);

    const cvGrid = document.getElementById("global-cv-grid");
    if (cvGrid) {
      cvGrid.innerHTML = "";
      for (let i = 0; i < 8; i++) {
        const div = document.createElement("div");
        div.innerHTML = `
          <label style="font-size:0.73rem;color:#93a1bd">Salida CV ${i + 1} (Fuente / Canal MIDI):</label>
          <div class="inline-pair">
            <select data-cv-src="${i}">
              <option value="0" ${gs.cvSources[i] === 0 ? "selected" : ""}>Pitch V/Oct</option>
              <option value="1" ${gs.cvSources[i] === 1 ? "selected" : ""}>Gate / Trig</option>
              <option value="2" ${gs.cvSources[i] === 2 ? "selected" : ""}>Velocity</option>
              <option value="3" ${gs.cvSources[i] === 3 ? "selected" : ""}>Mod / Aftertouch</option>
              <option value="4" ${gs.cvSources[i] >= 4 ? "selected" : ""}>Touchstrip CC</option>
            </select>
            <input type="number" min="1" max="16" value="${gs.cvChannels[i] || 1}" data-cv-ch="${i}" />
          </div>
        `;
        cvGrid.appendChild(div);
      }
    }

    const drumGrid = document.getElementById("global-drum-notes-grid");
    if (drumGrid) {
      drumGrid.innerHTML = "";
      for (let i = 0; i < 16; i++) {
        const note = gs.drumNotes[i] ?? 36 + i;
        const div = document.createElement("div");
        div.innerHTML = `
          <label style="font-size:0.7rem;color:#93a1bd">Drum Pad ${i + 1}:</label>
          <input type="number" min="0" max="127" value="${note}" data-drum-idx="${i}" />
        `;
        drumGrid.appendChild(div);
      }
    }
  }

  function collectGlobalSettingsFromForm() {
    const gs = state.globalSettings;
    gs.deviceMode = Number(document.getElementById("global-device-mode").value);
    gs.syncSource = Number(document.getElementById("global-sync-source").value);
    gs.ledBrightness = Number(document.getElementById("global-led-brightness").value);
    gs.padSensitivity = Number(document.getElementById("global-pad-sensitivity").value);
    gs.sendSyncToUsb = document.getElementById("global-sync-usb").checked;
    gs.sendSyncToMidi = document.getElementById("global-sync-midi").checked;

    document.querySelectorAll("[data-cv-src]").forEach((el) => {
      gs.cvSources[Number(el.dataset.cvSrc)] = Number(el.value);
    });
    document.querySelectorAll("[data-cv-ch]").forEach((el) => {
      gs.cvChannels[Number(el.dataset.cvCh)] = Number(el.value);
    });
    document.querySelectorAll("[data-drum-idx]").forEach((el) => {
      gs.drumNotes[Number(el.dataset.drumIdx)] = Number(el.value);
    });
    return gs;
  }

  // =========================================================================
  // Tab 5: Firmware Patch Table & Multi-Platform WebMIDI / Backend Flashing
  // =========================================================================
  function renderPatchTable() {
    const tbody = document.getElementById("patch-table-body");
    if (!tbody || !state.firmware?.manifest?.patches) return;
    tbody.innerHTML = "";
    state.firmware.manifest.patches.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code>${p.flash_addr}</code></td>
        <td><strong>${p.id}</strong></td>
        <td><code>${p.orig_hex}</code></td>
        <td><code>${p.patch_hex}</code></td>
        <td>${p.description}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function runFirmwareFlash(targetType) {
    const labelEl = document.getElementById("fw-progress-label");
    const pctEl = document.getElementById("fw-progress-pct");
    const barEl = document.getElementById("fw-progress-bar-fill");
    const logEl = document.getElementById("fw-console-log");

    const setProgress = (pct, msg) => {
      pctEl.textContent = `${pct}%`;
      barEl.style.width = `${pct}%`;
      if (msg) labelEl.textContent = msg;
    };

    setProgress(15, `Validando imagen ${targetType === "custom" ? "FreeAPC64 Custom" : "Akai Stock"} 1.2.1.6...`);
    logEl.textContent = `[1/4] Solicitando verificación y protocolo RBIN (${targetType})...\n`;

    const res = await fetch("/api/firmware/flash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: targetType,
        dryRun: !state.midiOut,
      }),
    });
    const data = await res.json();
    setProgress(100, data.ok ? "¡Proceso de Firmware completado con éxito!" : "Aviso en proceso de Firmware");
    logEl.textContent += data.output || JSON.stringify(data, null, 2);
  }

  // =========================================================================
  // WebMIDI Setup (F0 47 00 53 ... F7 & Live MIDI Note/CC)
  // =========================================================================
  async function connectWebMidi() {
    const pill = document.getElementById("midi-status-pill");
    if (!navigator.requestMIDIAccess) {
      pill.textContent = "WebMIDI no soportado en este navegador (Usando Simulador)";
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      state.midiAccess = access;
      populateMidiSelects();
      access.onstatechange = populateMidiSelects;
    } catch (err) {
      pill.textContent = "Permiso SysEx denegado — Modo Simulador Activo";
    }
  }

  function populateMidiSelects() {
    if (!state.midiAccess) return;
    const inSel = document.getElementById("midi-in-select");
    const outSel = document.getElementById("midi-out-select");
    const pill = document.getElementById("midi-status-pill");

    inSel.innerHTML = `<option value="">(Simulador / Sin puerto USB)</option>`;
    outSel.innerHTML = `<option value="">(Simulador / Sin puerto USB)</option>`;

    let autoIn = null;
    let autoOut = null;

    for (const input of state.midiAccess.inputs.values()) {
      const opt = document.createElement("option");
      opt.value = input.id;
      opt.textContent = input.name;
      inSel.appendChild(opt);
      if (input.name.toLowerCase().includes("apc64")) autoIn = input;
    }
    for (const output of state.midiAccess.outputs.values()) {
      const opt = document.createElement("option");
      opt.value = output.id;
      opt.textContent = output.name;
      outSel.appendChild(opt);
      if (output.name.toLowerCase().includes("apc64")) autoOut = output;
    }

    if (autoIn) {
      inSel.value = autoIn.id;
      state.midiIn = autoIn;
      bindMidiInListener(autoIn);
    }
    if (autoOut) {
      outSel.value = autoOut.id;
      state.midiOut = autoOut;
    }

    if (state.midiOut) {
      pill.className = "status-pill status-connected";
      pill.textContent = `Conectado: ${state.midiOut.name}`;
    }
  }

  function bindMidiInListener(inputPort) {
    if (!inputPort) return;
    inputPort.onmidimessage = async (ev) => {
      const data = Array.from(ev.data);
      // Check if Custom Project SysEx reply (F0 47 00 53 12 ... F7)
      if (data[0] === 0xf0 && data[1] === 0x47 && data[3] === 0x53 && data[4] === 0x12) {
        const res = await fetch("/api/project/decode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sysex: data }),
        });
        const json = await res.json();
        if (json.ok) {
          state.project = json.project;
          renderAll();
          setMidiMonitor(`RX SysEx 0x12: Proyecto cargado desde APC64 (${data.length} bytes)`);
        }
      }
    };
  }

  // =========================================================================
  // Initialization & Event Wiring
  // =========================================================================
  function renderAll() {
    renderOledCanvas();
    renderPadGrid();
    renderFaders();
    updatePadInspector();
    updateFaderInspector();
    renderSynthRack();
    renderTracksTab();
    renderGlobalTab();
    renderPatchTable();

    document.querySelectorAll(".oled-line-input").forEach((inp) => {
      const idx = Number(inp.dataset.line);
      inp.value = state.oledLines[idx] || "";
    });
  }

  async function initApp() {
    const res = await fetch("/api/status");
    const data = await res.json();
    state.project = data.project;
    state.globalSettings = data.globalSettings;
    state.firmware = data.firmware;
    state.palette = data.palette || [];
    state.oledLines = data.oledLines || state.oledLines;

    renderPaletteSwatches();
    bindPadInspectorEvents();
    bindFaderInspectorEvents();
    renderAll();

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab)?.classList.add("active");
      });
    });

    // Preset loader
    document.getElementById("preset-select")?.addEventListener("change", async (e) => {
      const presetId = e.target.value;
      const r = await fetch(`/api/presets/${presetId}/apply`, { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        state.project = j.project;
        state.oledLines[1] = j.project.name;
        renderAll();
        setMidiMonitor(`Plantilla cargada: ${j.project.name} (${j.sysex.length} bytes SysEx listos)`);
      }
    });

    // Apply Scale to 64 Pads
    document.getElementById("btn-apply-scale")?.addEventListener("click", async () => {
      const rootNote = Number(document.getElementById("scale-root").value);
      const scaleKey = document.getElementById("scale-type").value;
      const baseOctave = Number(document.getElementById("scale-octave").value);
      const rowInterval = Number(document.getElementById("scale-interval").value);
      const r = await fetch("/api/project/scale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: state.project,
          rootNote,
          scaleKey,
          baseOctave,
          rowInterval,
        }),
      });
      const j = await r.json();
      if (j.ok) {
        state.project = j.project;
        renderPadGrid();
        updatePadInspector();
        setMidiMonitor(`Escala aplicada a 64 Pads: ${NOTE_NAMES[rootNote]} ${scaleKey}`);
      }
    });

    // Hardware UI Mode buttons (SysEx 0x19)
    document.querySelectorAll(".hw-mode-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        document.querySelectorAll(".hw-mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const modeIndex = Number(btn.dataset.uimode);
        const r = await fetch("/api/ui-mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modeIndex }),
        });
        const j = await r.json();
        if (j.ok) {
          sendMidiBytes(j.sysex);
          state.oledLines[1] = `UI Mode: ${btn.textContent}`;
          renderOledCanvas();
          setMidiMonitor(`TX SysEx 0x19 (UI Page Switch): [${j.sysex.map((b) => b.toString(16).padStart(2, "0")).join(" ")}]`);
        }
      });
    });

    // Transport Play / Stop / Rec buttons
    [
      { id: "btn-transport-play", note: 0x5b, dawNote: 0x35, label: "PLAY" },
      { id: "btn-transport-stop", note: 0x5c, dawNote: 0x37, label: "STOP" },
      { id: "btn-transport-rec", note: 0x5d, dawNote: 0x36, label: "RECORD" },
    ].forEach((t) => {
      document.getElementById(t.id)?.addEventListener("click", () => {
        sendMidiBytes([0x90, t.note, 0x7f]);
        sendMidiBytes([0x90, t.dawNote, 0x7f]);
        state.oledLines[2] = `Transport: ${t.label}`;
        renderOledCanvas();
        setMidiMonitor(`TX Transport ${t.label}: Note 0x${t.note.toString(16).toUpperCase()} & 0x${t.dawNote.toString(16).toUpperCase()}`);
      });
    });

    // Send Custom Project (SysEx 0x12)
    document.getElementById("btn-send-project")?.addEventListener("click", async () => {
      state.project.slot = Number(document.getElementById("slot-select").value);
      const r = await fetch("/api/project/encode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project }),
      });
      const j = await r.json();
      if (j.ok) {
        sendMidiBytes(j.sysex);
        state.oledLines[1] = `Sync Slot ${state.project.slot} OK`;
        renderOledCanvas();
        setMidiMonitor(`TX SysEx 0x12 (Custom Project Slot ${state.project.slot}): ${j.sysexLength} bytes enviados`);
      }
    });

    // Request Custom Project (SysEx 0x11)
    document.getElementById("btn-request-project")?.addEventListener("click", () => {
      const slot = Number(document.getElementById("slot-select").value) & 0x7f;
      const req = [0xf0, 0x47, 0x00, 0x53, 0x11, 0x00, 0x01, slot, 0xf7];
      sendMidiBytes(req);
      setMidiMonitor(`TX SysEx 0x11: Solicitando Proyecto del Slot ${slot} al APC64...`);
    });

    // Export .apc64.json project
    document.getElementById("btn-export-project")?.addEventListener("click", async () => {
      const r = await fetch("/api/project/encode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project }),
      });
      const j = await r.json();
      const blob = new Blob([JSON.stringify({ project: state.project, rawBase64: j.rawBase64, sysex: j.sysex }, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(state.project.name || "freeapc64").toLowerCase().replace(/\s+/g, "-")}.apc64.json`;
      a.click();
    });

    // Import .apc64.json project
    document.getElementById("file-import-project")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = JSON.parse(text);
      const r = await fetch("/api/project/decode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const j = await r.json();
      if (j.ok) {
        state.project = j.project;
        renderAll();
        setMidiMonitor(`Proyecto importado: ${state.project.name}`);
      }
    });

    // Send OLED Lines (SysEx 0x10)
    document.getElementById("btn-send-oled")?.addEventListener("click", async () => {
      const lines = [];
      document.querySelectorAll(".oled-line-input").forEach((inp) => {
        lines[Number(inp.dataset.line)] = inp.value;
      });
      const r = await fetch("/api/oled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      const j = await r.json();
      if (j.ok) {
        state.oledLines = j.oledLines;
        j.packets.forEach((pkt) => sendMidiBytes(pkt));
        renderOledCanvas();
        setMidiMonitor(`TX SysEx 0x10: 4 líneas de texto enviadas a la pantalla OLED del APC64`);
      }
    });

    // Send Global Settings (SysEx 0x18)
    document.getElementById("btn-send-global")?.addEventListener("click", async () => {
      const gs = collectGlobalSettingsFromForm();
      const r = await fetch("/api/global/encode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ globalSettings: gs }),
      });
      const j = await r.json();
      if (j.ok) {
        sendMidiBytes(j.sysex);
        setMidiMonitor(`TX SysEx 0x18 (Global Settings): ${j.sysexLength} bytes enviados al APC64`);
      }
    });

    // Synth Waveform & Chord Test
    document.getElementById("synth-waveform")?.addEventListener("change", (e) => {
      state.synthParams.waveform = e.target.value;
    });
    document.getElementById("btn-test-chord")?.addEventListener("click", () => {
      const chord = [48, 55, 63, 67, 74]; // C minor 9
      chord.forEach((n) => {
        triggerSynthNoteOn(n, 100);
        sendMidiBytes([0x90, n, 100]);
      });
      setTimeout(() => {
        chord.forEach((n) => {
          triggerSynthNoteOff(n);
          sendMidiBytes([0x80, n, 0]);
        });
      }, 900);
    });

    // Firmware Flashing Buttons
    document.getElementById("btn-flash-custom-webmidi")?.addEventListener("click", () => runFirmwareFlash("custom"));
    document.getElementById("btn-flash-stock-webmidi")?.addEventListener("click", () => runFirmwareFlash("stock"));

    // WebMIDI Connect button
    document.getElementById("btn-connect-midi")?.addEventListener("click", connectWebMidi);
  }

  window.addEventListener("DOMContentLoaded", initApp);
})();
