# Firmware Architecture

## Overview

The FP2 contains two independently running firmware images:

1. **ESP32 firmware** — runs on the ESP32-SOLO1, handles WiFi, HomeKit/ESPHome,
   and communicates with the radar over UART
2. **Radar firmware** — runs on the TI IWR6843AOP, handles all mmWave signal
   processing, target tracking, and zone detection

This project replaces only the ESP32 firmware with ESPHome. The radar firmware
remains Aqara's stock version, which is well-calibrated for the FP2's specific
antenna geometry.

## ESP32 Firmware

### Stock Aqara Firmware

The stock firmware implements:
- HomeKit Accessory Protocol (HAP) — exposes binary occupancy per zone and a
  light level sensor
- Aqara cloud protocol — sends richer data (person counts, per-zone statistics)
  to `rpc-ger.aqara.com` / `aiot-rpc-usa.aqara.com`
- WiFi management and mDNS (`_hap._tcp`, `_aqara-setup._tcp`)
- Radar firmware OTA via XMODEM protocol
- OPT3001 light sensor driver with NVS-stored calibration coefficients

**Key limitation**: The HomeKit protocol only exposes binary `Occupancy Detected`
(uint8, 0 or 1) per zone. Person count data is sent only to the Aqara cloud.
This is the fundamental reason this ESPHome replacement exists.

**Source structure** (from firmware strings):
- `apps/user/hal/acceleration_ambinent_light.c` — accelerometer + OPT3001 driver
- `apps/user/ota/radar_ota.c` — radar firmware update orchestration
- `apps/user/ota/xmodem.c` — XMODEM transfer protocol

### ESPHome Replacement Firmware

The `esphome_fp2` component replaces the stock ESP32 firmware while keeping the
radar firmware intact. It:

- Speaks the Aqara custom UART protocol to the radar chip
- Configures zones, sensitivity, and detection parameters on startup
- Receives and processes all radar reports (presence, motion, tracking, temperature)
- Exposes data to Home Assistant via the ESPHome native API
- Provides per-zone person counting by cross-referencing target positions with
  zone grid bitmaps
- Reads the OPT3001 ambient light sensor (lux)
- Supports auto-calibration of edge boundaries and interference sources

### Flash Partition Table

From the actual firmware dump (unit homekit-52322103):

| Label | Offset | Size | Type | Sub-type | Description |
|-------|--------|------|------|----------|-------------|
| nvs | 0x9000 | 32KB | DATA | WIFI | Non-volatile storage |
| otadata | 0x11000 | 8KB | DATA | OTA | OTA state tracking |
| phy_init | 0x13000 | 4KB | DATA | RF | WiFi PHY calibration |
| aqara_fw1 | 0x20000 | 2MB | APP | ota_0 | Main application (slot 0) |
| aqara_fw2 | 0x220000 | 2MB | APP | ota_1 | Application (slot 1) |
| test | 0x420000 | 76KB | APP | TEST | Test/diagnostic partition |
| mcu_ota | 0x433000 | 4MB | DATA | 0xFE | Radar firmware for XMODEM |
| fctry | 0x833000 | 24KB | DATA | WIFI | Factory calibration |

### Firmware Extraction

```bash
# Connect USB-UART adapter to TP8 (TX), TP9 (RX), GND
# Hold TP28 (GPIO0) LOW during power-on for download mode

# Read entire flash (recommended backup before any modification)
esptool.py --baud 230400 --port /dev/ttyUSB0 read_flash 0x0 0x1000000 fw-backup.bin

# Note: Record which physical unit this came from in the filename.
# Flash may contain unit-specific calibration data (lux coefficients in NVS).
```

### Firmware Analysis Tools

For reverse engineering the stock firmware:

1. **Ghidra 12.0.3+** with the
   [dynacylabs/ghidra-esp32-flash-loader](https://github.com/dynacylabs/ghidra-esp32-flash-loader)
   extension — loads full flash dumps with correct segment mapping, SVD
   peripherals, and ROM symbols. **Do not use the raw binary loader** — it
   produces no cross-references and makes analysis very difficult.

2. **esp32_image_parser** — partition extraction and ELF conversion:
   ```bash
   python3 esp32_image_parser.py show_partitions fw-backup.bin
   ```

3. **bethington/ghidra-mcp** — 193-tool MCP server for Claude-assisted Ghidra
   analysis. Requires Ghidra GUI (use Xvfb for headless servers). See
   [07-firmware-analysis.md](07-firmware-analysis.md).

## Radar Firmware

### Stock Aqara Radar Firmware

Aqara wrote custom firmware for the IWR6843AOP. It does **not** use TI's
standard out-of-box demo or TLV output format. Key characteristics:

- Custom UART protocol (documented in [02-uart-protocol.md](02-uart-protocol.md))
- Multi-person tracking with individual target IDs
- Zone-based presence classification
- Person/object classification
- Posture detection
- Temperature sensing
- Configurable sensitivity per zone

### Radar Firmware Update (XMODEM)

The stock ESP32 firmware can update the radar firmware using XMODEM over the
existing UART connection. This was confirmed by reverse engineering the stock
firmware (source: `radar_ota.c`, `xmodem.c`).

**Update flow:**
1. ESP32 writes SubID `0x0127` (OTA_SET_FLAG) to put radar into bootloader mode
2. ESP32 reads radar firmware from the `mcu_ota` partition (4MB at 0x433000)
3. XMODEM transfer: `xmodem_new` → `xmodem_transfer` → `xmodem_end`
4. XMODEM includes retry logic, CAN (cancel) support, and timeouts
5. Radar reboots with new firmware

**Key functions** (addresses in Ghidra project):
- `radar_ota_start` — entry point (string at `3f40b30c`)
- `radar_ota_set_flag` — triggers bootloader (string at `3f40b2d8`)
- `xmodem_new`, `xmodem_transfer`, `xmodem_end`, `xmodem_recv`

**Status**: Not yet implemented in ESPHome. This is the highest-priority
remaining RE task. The `mcu_ota` partition has been extracted from the flash
dump as `fp2_mcu_ota.bin` (4MB).

**Important**: Update the radar firmware via the Aqara app **before** flashing
ESPHome. Once ESPHome is installed, radar firmware updates are not yet possible
(pending XMODEM implementation).

## Data Flow

```
  IWR6843AOP                    ESP32                    Home Assistant
  ──────────                    ─────                    ──────────────
  mmWave TX/RX
       │
  Signal Processing
  (FFT, CFAR, Tracking)
       │
  Target List ──── UART ────► Frame Decoder
  (x, y, z, vel,   0x0117     (CRC check, parse)
   SNR, class)                      │
                                    ├──► Global presence ──► binary_sensor
  Zone Presence ─── UART ────►     │
  (zone_id, state)  0x0142         ├──► Zone presence ────► binary_sensor
                                    │
  Zone Motion ───── UART ────►     ├──► Zone motion ──────► binary_sensor
  (zone_id, state)  0x0115         │
                                    ├──► People count ────► sensor (global)
  People Count ──── UART ────►     │
  (total count)     0x0165         ├──► Zone people count ► sensor (per-zone)
                                    │    (derived from target positions
  Temperature ───── UART ────►     │     cross-referenced with zone grids)
  (degrees)         0x0128         │
                                    ├──► Target tracking ─► text_sensor
  Heartbeat ─────── UART ────►     │    (base64 encoded)
  (version)         0x0102         │
                                    ├──► Temperature ─────► sensor
                                    │
  OPT3001 ─── I2C (0x44) ────────► ├──► Ambient Light ───► sensor (lux)
  (light sensor)                    │
                                    └──► Accelerometer ───► orientation data
  da218B ──── I2C (0x27) ──────────      (reported to radar on request)
```

## Alternative Data Paths

### Aqara Cloud API (ha-aqara-devices)

If modifying hardware is not desired, the
[ha-aqara-devices](https://github.com/Darkdragon14/ha-aqara-devices) custom
integration can access person count data via Aqara's cloud API:

- Requires FP2 bound to Aqara app/cloud
- Polls every 2-30 seconds
- Exposes: `all_zone_statistics`, `zone1_statistics` through `zone30_statistics`,
  `people_counting`, per-zone rates

### HomeKit (Native)

Via the stock firmware's HomeKit interface:

- Binary occupancy per zone only (no counts)
- Light level sensor (OPT3001 lux with calibration)
- No target tracking or position data

### fp2-proxy

[fp2-proxy](https://github.com/ebaauw/fp2-proxy) mirrors HAP data to a deCONZ
gateway. Exposes the same binary occupancy data as HomeKit — no person counts.
