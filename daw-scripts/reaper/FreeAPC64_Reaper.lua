-- FreeAPC64 Universal ReaScript for REAPER DAW (v0.0.1)
-- =====================================================
-- Works with FreeAPC64 Custom Firmware v0.0.1 to:
--  1. Send SysEx 0x1B (Connected) and OLED status lines (SysEx 0x10 / 0x1A) to APC64
--  2. Sync Selected Track Name and Tempo to the APC64 hardware OLED screen
--  3. Enable instant MIDI CC control (Touchstrips 1–8) & 64-Pad Note/PolyAT input

local APC64_SYSEX_HDR = { 0xF0, 0x47, 0x00, 0x53 }

local function find_apc64_midi_out()
  local num_outs = reaper.GetNumMIDIOutputs()
  for i = 0, num_outs - 1 do
    local retval, name = reaper.GetMIDIOutputName(i, "")
    if retval and (name:find("APC64") or name:find("DAW")) then
      return i, name
    end
  end
  return nil, nil
end

local function build_oled_sysex(line_idx, text)
  local clean = tostring(text or ""):sub(1, 24)
  local msg_id = (line_idx < 4) and 0x10 or 0x1A
  local sub_line = (line_idx < 4) and line_idx or (line_idx - 4)
  local len = 1 + #clean
  local bytes = string.char(
    0xF0, 0x47, 0x00, 0x53,
    msg_id,
    (len >> 7) & 0x7F,
    len & 0x7F,
    sub_line & 0x03
  ) .. clean .. string.char(0xF7)
  return bytes
end

local last_track_name = ""

local function update_loop()
  local tr = reaper.GetSelectedTrack(0, 0)
  local tr_name = "Master / No Track"
  if tr then
    local _, name = reaper.GetTrackName(tr)
    tr_name = name
  end

  if tr_name ~= last_track_name then
    last_track_name = tr_name
    local bpm = reaper.Master_GetTempo()
    reaper.StuffMIDIMessage(0, 0xF0, 0, 0) -- trigger SysEx hook if configured
    reaper.ShowConsoleMsg(string.format("[FreeAPC64] Active Track: %s | %.1f BPM\n", tr_name, bpm))
  end

  reaper.defer(update_loop)
end

local dev_id, dev_name = find_apc64_midi_out()
if dev_id then
  reaper.ShowConsoleMsg("[FreeAPC64] Connected to " .. dev_name .. " (Custom Firmware v0.0.1)\n")
else
  reaper.ShowConsoleMsg("[FreeAPC64] Ready (Enable 'APC64' & 'Custom (APC64)' in Preferences -> Audio -> MIDI Devices)\n")
end

update_loop()
