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

- **Variant**: ESP32-SOLO1 (single-core)
- **Flash**: 16Mbit SPI (external)
- **PSRAM**: Yes
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
- **Config**: Register 0x01, continuous mode, 800ms conversion, auto-range
  (value `0xCE10`)
- **Calibration**: Stock firmware applies NVS-stored linear coefficients per range:
  `lux_low_k`, `lux_low_b` (slope/intercept for low range),
  `lux_high_k`, `lux_high_b` (slope/intercept for high range),
  with `lux_low_min`, `lux_low_max`, `lux_high_min`, `lux_high_max` bounds
- **Manufacturer/Device ID**: Register `0x7E` = `0x5449` (TI),
  register `0x7F` = `0x3001` (OPT3001)
- **Source file**: `apps/user/hal/acceleration_ambinent_light.c`
- **Status**: Fully implemented in ESPHome component

## GPIO Pin Map

| GPIO | Function | Direction | Notes |
|------|----------|-----------|-------|
| 13 | Radar NRESET | Output | Active-low reset for IWR6843AOP |
| 14 | RGB LED (Blue) | Output | Accent LED, active-low |
| 16 | External SRAM CS | Output | AP Memory 1604M-3SQR |
| 18 | UART TX to Radar | Output | ESP32 → IWR6843AOP (890000 baud) |
| 19 | UART RX from Radar | Input | IWR6843AOP → ESP32 |
| 26 | RGB LED (Red) | Output | Status LED, active-low |
| 27 | RGB LED (Green) | Output | Status LED, active-low |
| 32 | I2C SCL | Bidirectional | da218B accelerometer + OPT3001 light sensor |
| 33 | I2C SDA | Bidirectional | da218B accelerometer + OPT3001 light sensor |
| 34 | Accelerometer INT | Input | da218B interrupt line |
| 35 | Light Sensor INT | Input | OPT3001 interrupt (input-only GPIO) |
| 36 (VP) | User Button | Input | Active-low, bottom of device |

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
