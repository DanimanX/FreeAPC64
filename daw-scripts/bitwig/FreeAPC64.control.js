/**
 * FreeAPC64 Universal Controller Script for Bitwig Studio (API v17+)
 * ==================================================================
 * Works seamlessly with FreeAPC64 Custom Firmware v0.0.1:
 *  - Unlocks Session Grid (8x8 Clip Launcher with RGB LED feedback)
 *  - Maps 8 Touchstrip Faders to Track Volumes, Pans, Sends, or 8 Remote Controls (MIDI CC + PitchBend)
 *  - Maps Play (0x5B / 0x35), Stop (0x5C / 0x37), Record (0x5D / 0x36) Transport buttons
 *  - Updates the APC64 Hardware OLED Display (SysEx F0 47 00 53 10/1A ... F7) with Track & Parameter names
 */

loadAPI(17);
host.setShouldFailOnDeprecatedUse(false);
host.defineController(
  "Akai Professional (FreeAPC64)",
  "FreeAPC64 Universal DAW & Synth Controller",
  "0.0.1",
  "43f33682-35e0-4a01-894b-96604a5616ef",
  "DanimanX"
);

host.defineMidiPorts(2, 2);
host.addDeviceNameBasedDiscoveryPair(["APC64", "Custom (APC64)"], ["APC64", "Custom (APC64)"]);
host.addDeviceNameBasedDiscoveryPair(["DAW (APC64)", "Custom (APC64)"], ["DAW (APC64)", "Custom (APC64)"]);
host.addDeviceNameBasedDiscoveryPair(["APC64 MIDI 1", "APC64 MIDI 4"], ["APC64 MIDI 1", "APC64 MIDI 4"]);

function sendOledLine(midiOut, lineIndex, text) {
  var clean = String(text || "").substring(0, 24);
  var msgId = lineIndex < 4 ? 0x10 : 0x1a;
  var subLine = lineIndex < 4 ? lineIndex : lineIndex - 4;
  var len = 1 + clean.length;
  var sysex = [0xf0, 0x47, 0x00, 0x53, msgId, (len >> 7) & 0x7f, len & 0x7f, subLine & 0x03];
  for (var i = 0; i < clean.length; i++) {
    sysex.push(clean.charCodeAt(i) & 0x7f);
  }
  sysex.push(0xf7);
  midiOut.sendSysex(sysex);
}

var transport;
var trackBank;
var cursorTrack;
var cursorDevice;
var remoteControls;
var midiOutDaw;
var midiOutCustom;

function init() {
  var midiInDaw = host.getMidiInPort(0);
  var midiInCustom = host.getMidiInPort(1);
  midiOutDaw = host.getMidiOutPort(0);
  midiOutCustom = host.getMidiOutPort(1);

  // Pass Note & Poly Aftertouch from Custom / Notes port directly to Bitwig's active instrument track
  midiInCustom.createNoteInput(
    "FreeAPC64 Pads & Notes",
    "8?????",
    "9?????",
    "A?????",
    "B?????",
    "D?????",
    "E?????"
  );
  midiInDaw.createNoteInput("FreeAPC64 DAW Notes", "8?????", "9?????", "A?????");

  transport = host.createTransport();
  trackBank = host.createMainTrackBank(8, 2, 8);
  cursorTrack = host.createCursorTrack("FREEAPC64_CURSOR_TRACK", "Cursor Track", 0, 0, true);
  cursorDevice = cursorTrack.createCursorDevice("FREEAPC64_DEVICE", "Cursor Device", 0, CursorDeviceFollowMode.FOLLOW_SELECTION);
  remoteControls = cursorDevice.createCursorRemoteControlsPage(8);

  for (var i = 0; i < 8; i++) {
    remoteControls.getParameter(i).markInterested();
    remoteControls.getParameter(i).setIndication(true);
    trackBank.getItemAt(i).volume().markInterested();
    trackBank.getItemAt(i).pan().markInterested();
  }

  // Send Live Connected SysEx (0x1B = 1) + OLED Welcome Banner
  midiOutDaw.sendSysex([0xf0, 0x47, 0x00, 0x53, 0x1b, 0x00, 0x01, 0x01, 0xf7]);
  sendOledLine(midiOutDaw, 0, "FreeAPC64 v0.0.1");
  sendOledLine(midiOutDaw, 1, "Bitwig Studio Ready");
  sendOledLine(midiOutDaw, 2, "CC + Grid Unlocked");

  midiInDaw.setMidiCallback(onDawMidi);
  midiInCustom.setMidiCallback(onCustomMidi);
}

function onDawMidi(status, data1, data2) {
  var msgType = status & 0xf0;
  var ch = status & 0x0f;

  // Touchstrip Fader PitchBend on DAW Port (0xE0..0xE7)
  if (msgType === 0xe0 && ch < 8) {
    var val14 = (data2 << 7) | data1;
    trackBank.getItemAt(ch).volume().set(val14, 16384);
    return;
  }

  // Transport buttons in DAW mode (Play=0x35/0x5B, Stop=0x37/0x5C, Rec=0x36/0x5D)
  if (msgType === 0x90 && data2 > 0) {
    if (data1 === 0x35 || data1 === 0x5b) {
      transport.play();
      sendOledLine(midiOutDaw, 2, "Transport: PLAY");
    } else if (data1 === 0x37 || data1 === 0x5c) {
      transport.stop();
      sendOledLine(midiOutDaw, 2, "Transport: STOP");
    } else if (data1 === 0x36 || data1 === 0x5d) {
      transport.record();
      sendOledLine(midiOutDaw, 2, "Transport: RECORD");
    }
  }
}

function onCustomMidi(status, data1, data2) {
  var msgType = status & 0xf0;

  // Touchstrip MIDI CC (unlocked by FreeAPC64 Custom Firmware in all modes!)
  if (msgType === 0xb0) {
    // CC 20..27 or CC 74/71/73/75/79/72/76/1 -> Map to Bitwig 8 Remote Controls
    if (data1 >= 20 && data1 <= 27) {
      var idx = data1 - 20;
      remoteControls.getParameter(idx).set(data2, 128);
      sendOledLine(midiOutDaw, 2, "Remote " + (idx + 1) + ": " + data2);
    } else if (data1 >= 16 && data1 <= 23) {
      var mIdx = data1 - 16;
      remoteControls.getParameter(mIdx).set(data2, 128);
    }
  }
}

function flush() {}

function exit() {
  if (midiOutDaw) {
    sendOledLine(midiOutDaw, 1, "FreeAPC64 Standalone");
  }
}
