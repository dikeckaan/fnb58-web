# FNB58 web PC tool: design

Date: 2026-10-12

## Goal

A browser-based replacement for FNIRSI's Windows-only `UsbMeter` (v0.0.7) for the
FNB58 USB tester. It runs in any Chromium browser over WebHID, with no driver and
no install, and it does more than the original.

The user's words: the Windows tool is very old and looks bad. Build a new tool from
scratch, at very high quality, with new features added.

## Assumptions (the user was not available to confirm)

- Turkish is the default interface language, English is switchable.
- Reading was verified on a real FNB58 (serial 087B194B05B3) on 2026-10-12: one
  HID interface, no report ID, 106 frames in 4.2 s, every CRC correct, 100
  samples per second. Trigger and release frames were not sent to hardware,
  because a wrong request can raise the voltage on whatever is connected.
- A built-in simulator emits real 64-byte frames through the same decoder.
- Firmware flashing is out of scope. A wrong byte bricks the meter and the
  bootloader protocol could not be verified.
- Importing recordings stored on the meter is out of scope. The request command
  was located (0x84) but the transfer handshake could not be confirmed.

## Protocol

Source: community logger (baryluk/fnirsi-usb-power-data-logger) for reading, and
disassembly of `UsbMeter.exe` for everything else.

- HID, 64-byte frames. `0xAA`, command/type, up to 61 payload bytes, CRC-8.
- CRC-8: polynomial 0x39, init 0x00, computed over bytes 0..62.
- Devices: 0483:0038, 0483:0039, 0483:003A (FNB48), 0483:003B (C1),
  2E3C:0049 (FNB48S), 2E3C:5558 (FNB58).
- Start: send 0x81, 0x82, then 0x82 (FNB58/FNB48S) or 0x83. Keep-alive 0x83 every 1 s.
- Type 0x04 (data): 4 samples of 15 bytes from offset 2, 10 ms apart. Voltage u32
  LE /1e5 V, current u32 LE /1e5 A, D+ u16 /1e3 V, D- u16 /1e3 V, sign byte
  (0 means negative temperature), temperature u16 /10 °C.
- Type 0x03: device info. A real FNB58 sent `02 00 00 00 3a 00 73 00 6a cd 00 00 83 00`.
  0x3a is 58 (the model). 0x73 is 115, read here as firmware 1.15, unconfirmed. Types 0x05/0x06: stored-curve transfer.
- Trigger: command 0x88, payload `[protocol index, millivolts u16 LE]`. Reply type
  0x07 is success, 0x08 is failure. Release: command 0x89.
- Trigger table: 0 QC2.0 (5, 9, 12, 20 V); 1 QC3.0 (3.6 to 20 V, 0.2 V steps);
  2 Huawei FCP (5, 9, 12 V); 3 Huawei SCP (3.3 to 10 V, 20 mV steps);
  4 Samsung AFC (9, 12 V).

## Features

Carried over from the Windows tool: live V/I/P/D+/D-/temperature, capacity and
energy counters, min/max, recording with start-current, stop-current and stop-delay
conditions, sample rate choice, main plus auxiliary record overlay, zoom and drag,
alarms with sound, single trigger, stepped "smart" trigger, CSV export.

New: runs on macOS/Linux/Windows; simulator; measurement cursors with charge and
energy between them; charger protocol guess from D+/D-; session library in
IndexedDB with import/export; charge analysis (taper point, peak, 3.7 V equivalent
capacity); cable resistance wizard; energy cost; low-voltage and temperature
alarms; packet diagnostics; Turkish and English; offline use.

## Architecture

Vite, React, TypeScript, no backend. High-rate data stays out of React.

- `device/protocol.ts`: CRC, frame build, decode, trigger table. Pure.
- `device/webhid.ts`, `device/simulator.ts`: two transports behind one interface.
- `device/detector.ts`: protocol guess. Pure.
- `core/sampleStore.ts`: typed-array sample storage.
- `core/engine.ts`: one instance. Owns the transport, live buffer, counters,
  recorder, alarms. Publishes an 8 Hz snapshot to React.
- `core/sessions.ts`: IndexedDB. `core/exporters.ts`: CSV/JSON. `core/analysis.ts`.
- `plot/scope.ts`: canvas renderer with per-pixel min/max decimation.
- `components/`: views.

## Visual direction

Chosen by the user from three sample directions on a design canvas: the left
vertical menu of the "Şerit" sample, the dark slate palette and rounded panels of
"Kokpit", and the readouts of "Tezgâh", where each channel's number sits on the
same row as its own trace lane. One lane per unit, so there is never a dual axis.
Dark only. Type: Red Hat Display for the interface, B612 Mono (a cockpit display
face) for readouts, with '.', ':' and ',' borrowed from the interface font because
B612 sets them at the left of a full-width cell. Series colours come from a
palette validated for colour-vision deficiency against the panel surface.

## Added during the build, at the user's request

- An Analysis tab for engineering use: full statistics, Hann FFT spectrum with
  noise floor and peaks, histogram, V-I scatter with a least-squares source model,
  load-step response, pulsed-load duty and frequency, and a measurement-chain
  reference. Maths lives in `core/dsp.ts`.
- Deployment to GitHub Pages (`.github/workflows/pages.yml`) and Cloudflare
  Workers static assets (`wrangler.jsonc`, `public/_headers`). Paths are relative.
- A service worker and manifest for offline use.

## Testing

Vitest for protocol, detector, store, stats, signal analysis, sessions, engine, axis scaling, CSV and translations (72 tests). The simulator drives the real
decoder end to end. The running app is checked in a browser.
