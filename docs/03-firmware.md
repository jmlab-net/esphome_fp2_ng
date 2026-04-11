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

**Key limitation**: The HomeKit protocol only exposes binary `Occupancy Detected`
(uint8, 0 or 1) per zone. Person count data is sent only to the Aqara cloud.
This is the fundamental reason this ESPHome replacement exists.

### ESPHome Replacement Firmware

The `esphome_fp2` component replaces the stock ESP32 firmware while keeping the
radar firmware intact. It:

- Speaks the Aqara custom UART protocol to the radar chip
- Configures zones, sensitivity, and detection parameters on startup
- Receives and processes all radar reports (presence, motion, tracking, temperature)
- Exposes data to Home Assistant via the ESPHome native API
- Provides per-zone person counting by cross-referencing target positions with
  zone grid bitmaps

### Flash Layout

The ESP32 has a 16Mbit (2MB) SPI flash with the following partition layout:

| Offset | Partition | Description |
|--------|-----------|-------------|
| 0x1000 | bootloader | ESP32 second-stage bootloader |
| 0x8000 | partitions | Partition table |
| 0x11000 | otadata | OTA state tracking |
| 0x13000 | phy_init | WiFi PHY calibration |
| 0x20000 | ota_0 | Application firmware (slot 0) |
| 0x220000 | ota_1 | Application firmware (slot 1) |

### Firmware Extraction

```bash
# Connect USB-UART adapter to TP8 (TX), TP9 (RX), GND
# Hold TP28 (GPIO0) LOW during power-on for download mode

# Read entire flash (recommended backup before any modification)
esptool.py --baud 230400 --port /dev/ttyUSB0 read_flash 0x0 0x1000000 fw-backup.bin

# Note: Record which physical unit this came from in the filename.
# Flash may contain unit-specific calibration data.
```

### Firmware Analysis Tools

For reverse engineering the stock firmware:

1. **esp32_image_parser** — extract partitions and generate ELF files:
   ```bash
   python3 esp32_image_parser.py show_partitions fw-backup.bin
   python3 esp32_image_parser.py create_elf fw-backup.bin -partition ota_0 -output ota_0.elf
   python3 esp32_image_parser.py dump_nvs fw-backup.bin -partition nvs -nvs_output_type json
   ```

2. **Ghidra** (11.0+ has native Xtensa support):
   - Architecture: `Xtensa:LE:32:default`
   - Use SVD-Loader for ESP32 peripheral memory maps
   - Create FIDB from matching ESP-IDF version for automatic SDK function
     identification

3. **esp32knife** — firmware dissection and partition extraction

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

### Updating Radar Firmware

**Important**: Update the radar firmware via the Aqara app **before** flashing
ESPHome onto the ESP32. Once ESPHome is installed, there is currently no
mechanism to update the radar firmware.

The radar firmware can theoretically be programmed via:
- **UART bootloader**: Set SOP pins to flashing mode (SOP0=0, SOP1=0)
- **Direct QSPI flash**: Program the WinBond 25Q64JVIQ via the P2 test header

However, Aqara's radar firmware is specifically calibrated for the FP2's antenna
geometry. Replacing it with TI stock demos (e.g., "Overhead 3D People Counting")
would require recalibration and ESP32 firmware changes to speak TI's TLV
protocol instead of Aqara's custom protocol.

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
                                    └──► Temperature ─────► sensor
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
- Light level sensor
- No target tracking or position data

### fp2-proxy

[fp2-proxy](https://github.com/ebaauw/fp2-proxy) mirrors HAP data to a deCONZ
gateway. Exposes the same binary occupancy data as HomeKit — no person counts.
