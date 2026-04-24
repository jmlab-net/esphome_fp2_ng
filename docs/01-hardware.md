# Aqara FP2 Hardware Reference

## Overview

The Aqara Presence Sensor FP2 (model `lumi.motion.agl001`) is a WiFi-based mmWave
presence detector with multi-zone and multi-person tracking capabilities. It is
USB-C powered and communicates via HomeKit natively.

Aqara internal project path: `Embedded_esp32_hsfp2`

## System Architecture

```
                    ┌──────────────────────────────────────┐
                    │          Aqara FP2 Sensor            │
                    │                                      │
  USB-C ──── 5V ───►│  ┌─────────────────┐                │
                    │  │  ESP32-SOLO1     │    UART        │
           WiFi ◄──►│  │  (WROOM-32U)    │◄──────────────►│
                    │  │                  │  GPIO18/19     │
                    │  │  - HomeKit HAP   │  890000 baud   │
                    │  │  - Aqara Cloud   │                │
                    │  │  - WiFi stack    │  ┌───────────┐ │
                    │  │                  │  │TI IWR6843 │ │
                    │  │  GPIO13 ────────►│  │   AOP     │ │
                    │  │  (NRESET)        │  │           │ │
                    │  │                  │  │ 60GHz     │ │
                    │  │  I2C (IO32/33)   │  │ mmWave    │ │
                    │  │  ┌───────────┐   │  │ Radar     │ │
                    │  │  │MiraMEMS   │   │  │           │ │
                    │  │  │da218B     │   │  └───────────┘ │
                    │  │  │Accel 0x27 │   │                │
                    │  │  └───────────┘   │  ┌───────────┐ │
                    │  │  ┌───────────┐   │  │WinBond    │ │
                    │  │  │TI OPT3001 │   │  │25Q64JVIQ  │ │
                    │  │  │Light 0x44 │   │  │Radar Flash│ │
                    │  │  └───────────┘   │  │64Mbit     │ │
                    │  │  IO35 = INT pin  │  └───────────┘ │
                    │  └─────────────────┘                │
                    └──────────────────────────────────────┘
```

## Components

### ESP32-WROOM-32U (Main Processor)

- **Variant**: ESP32-SOLO1 (single-core), chip revision v1.1
- **Flash**: 16Mbit SPI (external), part number unknown
- **PSRAM**: AP Memory 1604M-3SQR present on GPIO16 (CS). Not used by
  application firmware (no SPIRAM API calls found in RE). May be reserved
  for future use or factory testing.
- **WiFi**: 802.11 b/g/n via U.FL external antenna
- **Role**: Runs application firmware (HomeKit, WiFi, cloud comms). Receives
  processed target data from the radar chip over UART and decides what to expose
  to external interfaces.

**Critical**: Single-core. ESPHome configs must include:
```yaml
esp32:
  board: esp32-solo1
  framework:
    type: esp-idf
    sdkconfig_options:
      CONFIG_FREERTOS_UNICORE: "y"
      CONFIG_ESP_SYSTEM_SINGLE_CORE_MODE: "y"
```

### TI IWR6843AOP (Radar Chip)

- **Type**: 60GHz mmWave FMCW radar with integrated antenna-on-package
- **Role**: All signal processing — point cloud generation, multi-person tracking,
  zone classification, posture detection
- **Flash**: WinBond 25Q64JVIQ (64Mbit) for radar firmware storage
- **Output**: Processed target data sent to ESP32 over UART using Aqara's custom
  protocol (not TI's standard TLV format)
- **Firmware update**: Via XMODEM protocol over the same UART connection. The ESP32
  stores radar firmware in the `mcu_ota` partition (4MB) and transfers it using
  SubID `0x0127` to trigger bootloader mode. No SOP pin toggling required.
- **Person count**: The radar internally tracks individual targets with position,
  velocity, and classification data. This is where the person counting happens.

### MiraMEMS da218B (Accelerometer)

- **Interface**: I2C at address `0x27` on GPIO32 (SCL) / GPIO33 (SDA), 400kHz
- **Role**: Detects sensor orientation and vibration. Used to determine mounting
  position (up, down, side, tilted) and report to the radar for calibration.
- **Init registers**: `0x0E` to reg `0x11`, `0x40` to reg `0x0F` (confirmed by RE)
- **Interrupt**: GPIO34
- **Source file**: `apps/user/hal/acceleration_ambinent_light.c`

### TI OPT3001 (Ambient Light Sensor)

- **Interface**: I2C at address `0x44`, sharing the bus with the accelerometer
  (GPIO32=SCL, GPIO33=SDA)
- **Interrupt**: GPIO35 (input-only pin, used as OPT3001 INT line)
- **Range**: 0.01 to 83,000 lux, automatic full-scale
- **Resolution**: 23-bit effective
- **Output**: Direct lux value from 16-bit result register (reg 0x00).
  Exponent (bits 15-12) and mantissa (bits 11-0):
  `lux = 0.01 * 2^exponent * mantissa`
- **Config**: Register 0x01. Stock firmware uses `0xC610` (single-shot mode,
  800ms conversion, auto-range). ESPHome driver uses `0xCE10` (continuous mode).
  Single-shot saves power; continuous is simpler to implement.
- **Calibration**: Stock firmware applies NVS-stored linear coefficients per range:
  `lux_low_k`, `lux_low_b` (slope/intercept for low range),
  `lux_high_k`, `lux_high_b` (slope/intercept for high range),
  with `lux_low_min`, `lux_low_max`, `lux_high_min`, `lux_high_max` bounds
- **Manufacturer/Device ID**: Register `0x7E` = `0x5449` (TI),
  register `0x7F` = `0x3001` (OPT3001)
- **Source file**: `apps/user/hal/acceleration_ambinent_light.c`
- **Status**: Fully implemented in ESPHome component
- **Optical cross-talk with status LED**: The OPT3001 and the on-board
  indicator LED share the same front optical window. When the LED is on,
  the sensor sees extra lux from the LED's own emission (most pronounced
  in dark rooms, where the LED contribution can dominate the reading).
  To measure true ambient light, either turn the LED off via the HA
  entity or ignore samples taken while the LED is on. Stock firmware
  sidesteps this via `lux_acc_led_onoff` which modulates LED brightness
  based on ambient lux — the ESPHome component does not replicate this.

### RGB LED

- **Pins**: GPIO14 (Blue), GPIO26 (Red), GPIO27 (Green), active-low
- **Driver**: ESP32 LEDC peripheral (PWM) for brightness control
- **Functions**: `led_rgb`, `led_scene`, `led_scene_deal`, `led_onoff_callback`
- **Light-linked**: The LED brightness is tied to the ambient light sensor via
  `lux_acc_led_onoff` — stock firmware adjusts LED based on room brightness
- **ESPHome**: Only GPIO27 is used as a status LED. GPIO14 and GPIO26 are
  available for custom use.

## GPIO Pin Map

| GPIO | Function | Direction | Notes |
|------|----------|-----------|-------|
| 0 | Boot mode | Input | TP28, pull-up. Hold LOW for download mode |
| 1 | UART0 TX | Output | Debug/log serial (115200 baud) |
| 3 | UART0 RX | Input | Debug/log serial |
| 13 | Radar NRESET | Output | Active-low reset for IWR6843AOP |
| 14 | RGB LED (Blue) | Output | LEDC PWM, active-low |
| 16 | External SRAM CS | Output | AP Memory 1604M-3SQR (unused by app) |
| 18 | UART TX to Radar | Output | ESP32 → IWR6843AOP (890000 baud) |
| 19 | UART RX from Radar | Input | IWR6843AOP → ESP32 |
| 26 | RGB LED (Red) | Output | LEDC PWM, active-low |
| 27 | RGB LED (Green) | Output | LEDC PWM, active-low |
| 32 | I2C SCL | Bidirectional | da218B (0x27) + OPT3001 (0x44), 400kHz |
| 33 | I2C SDA | Bidirectional | da218B (0x27) + OPT3001 (0x44), 400kHz |
| 34 | Accelerometer INT | Input | da218B interrupt line |
| 35 | Light Sensor INT | Input | OPT3001 interrupt (input-only GPIO) |
| 36 (VP) | User Button | Input | Active-low, bottom of device |

GPIOs 2, 4, 5, 12, 15, 17, 21, 22, 23, 25 are not mapped in the RE work or
board schematic. They are likely unused/floating or connected to internal
test points. Physical probing would be needed to confirm.

## Flash Partition Table

From the actual firmware dump (16MB flash):

| Label | Offset | Size | Type | Sub-type | Description |
|-------|--------|------|------|----------|-------------|
| nvs | 0x9000 | 32KB | DATA | WIFI | Non-volatile storage (WiFi creds, calibration) |
| otadata | 0x11000 | 8KB | DATA | OTA | OTA state tracking |
| phy_init | 0x13000 | 4KB | DATA | RF | WiFi PHY calibration |
| aqara_fw1 | 0x20000 | 2MB | APP | ota_0 | Main application firmware (slot 0) |
| aqara_fw2 | 0x220000 | 2MB | APP | ota_1 | Application firmware (slot 1) |
| test | 0x420000 | 76KB | APP | TEST | Test partition |
| mcu_ota | 0x433000 | 4MB | DATA | 0xFE | **Radar firmware image** for XMODEM transfer |
| fctry | 0x833000 | 24KB | DATA | WIFI | Factory calibration data |

## UART Test Points

For firmware extraction and serial access:

| Test Point | Function |
|------------|----------|
| TP8 | ESP32 UART TX |
| TP9 | ESP32 UART RX |
| TP28 | GPIO0 (hold LOW for download mode) |

## Radar Programming Interface

The IWR6843AOP can be updated two ways:

1. **Via ESP32 UART (primary)**: The ESP32 sends SubID `0x0127` (ota_set_flag)
   to put the radar into bootloader mode, then transfers firmware from the
   `mcu_ota` partition using the XMODEM protocol over the same UART connection.
   Source: `apps/user/ota/radar_ota.c` and `apps/user/ota/xmodem.c`.

2. **Direct flash programming (secondary)**: The P2 8-pin test header provides
   direct QSPI access to the radar's WinBond flash. There is also an unpopulated
   10-pin FFC for LVDS raw radar data output.

## Stock Firmware Details (from RE)

Extracted from the app descriptor and firmware strings:

| Field | Value |
|-------|-------|
| Model ID | `lumi.motion.agl001` |
| Manufacturer | `aqara` |
| ESP32 App Version | `4.66.85` |
| Build Date | Jul 8, 2025 at 17:49:32 |
| ESP-IDF | Custom fork, git hash `b48ac7fc-dirty` (not a standard release) |
| Developer | `zengzhaoze` (from source paths) |
| HomeKit SDK | Apple HomeKit ADK (`apple-homekit-adk/`) |
| Chip Revision | ESP32 v1.1 |

### Source File Structure (from firmware strings)

```
Embedded_esp32_hsfp2/
├── apps/
│   ├── master/master.c                        # Main application entry
│   ├── user/
│   │   ├── hal/acceleration_ambinent_light.c  # Accel + OPT3001 driver
│   │   └── ota/
│   │       ├── ota.c                          # ESP32 OTA handler
│   ��       ├── radar_ota.c                    # Radar OTA orchestration
│   │       └── xmodem.c                       # XMODEM protocol
│   └── homekit/port/src/
│       └── HAPPlatformLog.c                   # HomeKit platform layer
├── apple-homekit-adk/                          # Apple HAP SDK
│   ├── HAP/
│   │   ├── HAPDeviceID.c
│   │   └── HAPPairingPairVerify.c
│   └── PAL/POSIX/
│       └── HAPPlatformMutex.c
└── IDF/components/                             # ESP-IDF (custom fork)
    ├── driver/i2c.c
    └── hal/esp32/include/hal/i2c_ll.h
```

## Physical Construction

- **Case**: Two-piece plastic shell secured by 4 screws under rubber plugs
- **USB-C**: Daughter board connected via internal header (power only)
- **Antenna**: External U.FL WiFi antenna on flexible cable
- **PCB**: Held by plastic clips — can be propped up for access without full removal

## Power

- USB-C, 5V, ~1A
- No battery; requires continuous power
- Brownout risk: WiFi TX draws significant current. Use a quality USB-C cable
  and charger (not a PC USB port) to avoid BOD resets during startup.

## I2C Bus Notes

The I2C bus (GPIO32/33) is shared between the da218B accelerometer (0x27) and
OPT3001 light sensor (0x44). On the single-core ESP32, bus contention can occur
when both devices are accessed in rapid succession. The ESPHome driver adds a
5ms yield between device reads and performs automatic bus recovery
(`i2c_master_bus_reset`) on timeout/invalid-state errors.
