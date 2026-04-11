# Aqara FP2 Hardware Reference

## Overview

The Aqara Presence Sensor FP2 (model `lumi.motion.agl001`) is a WiFi-based mmWave
presence detector with multi-zone and multi-person tracking capabilities. It is
USB-C powered and communicates via HomeKit natively.

## System Architecture

```
                    ┌──────────────────────────────────────┐
                    │          Aqara FP2 Sensor            │
                    │                                      │
  USB-C ──── 5V ───►│  ┌─────────────────┐                │
                    │  │  ESP32-SOLO1     │    UART        │
           WiFi ◄──►│  │  (WROOM-32U)    │◄──────────────►│
                    │  │                  │  GPIO18/19     │
                    │  │  - HomeKit HAP   │                │
                    │  │  - Aqara Cloud   │  ┌───────────┐ │
                    │  │  - WiFi stack    │  │TI IWR6843 │ │
                    │  │                  │  │   AOP     │ │
                    │  │  GPIO13 ────────►│  │           │ │
                    │  │  (NRESET)        │  │ 60GHz     │ │
                    │  │                  │  │ mmWave    │ │
                    │  │  I2C (IO32/33)──►│  │ Radar     │ │
                    │  │  ┌───────────┐   │  │           │ │
                    │  │  │MiraMEMS   │   │  └───────────┘ │
                    │  │  │da218B     │   │                │
                    │  │  │Accel      │   │  ┌───────────┐ │
                    │  │  └───────────┘   │  │WinBond    │ │
                    │  │                  │  │25Q64JVIQ  │ │
                    │  │  IO35/32/33 ────►│  │Radar Flash│ │
                    │  │  (Light Sensor)  │  │64Mbit     │ │
                    │  │                  │  └───────────┘ │
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
- **Person count**: The radar internally tracks individual targets with position,
  velocity, and classification data. This is where the person counting happens.

### MiraMEMS da218B (Accelerometer)

- **Interface**: I2C at address `0x27` on GPIO32 (SCL) / GPIO33 (SDA)
- **Role**: Detects sensor orientation and vibration. Used to determine mounting
  position (up, down, side, tilted) and report to the radar for calibration.
- **Interrupt**: GPIO34

### Light Sensor

- **Pins**: GPIO35, GPIO32, GPIO33 (analog inputs)
- **Status**: The exact sensor IC is unknown. All three pins read constant 3.16V
  regardless of ambient light changes in testing. May require specific
  initialization or use a protocol not yet reverse-engineered.

## GPIO Pin Map

| GPIO | Function | Direction | Notes |
|------|----------|-----------|-------|
| 13 | Radar NRESET | Output | Active-low reset for IWR6843AOP |
| 14 | RGB LED (Blue) | Output | Accent LED, active-low |
| 16 | External SRAM CS | Output | AP Memory 1604M-3SQR |
| 18 | UART TX to Radar | Output | ESP32 → IWR6843AOP |
| 19 | UART RX from Radar | Input | IWR6843AOP → ESP32 |
| 26 | RGB LED (Red) | Output | Status LED, active-low |
| 27 | RGB LED (Green) | Output | Status LED, active-low |
| 32 | I2C SCL / Light Sensor | Bidirectional | Shared with accelerometer |
| 33 | I2C SDA / Light Sensor | Bidirectional | Shared with accelerometer |
| 34 | Accelerometer INT | Input | da218B interrupt line |
| 35 | Light Sensor | Input | Analog input |
| 36 (VP) | User Button | Input | Active-low, bottom of device |

## UART Test Points

For firmware extraction and serial access:

| Test Point | Function |
|------------|----------|
| TP8 | ESP32 UART TX |
| TP9 | ESP32 UART RX |
| TP28 | GPIO0 (hold LOW for download mode) |

## Radar Programming Interface

The IWR6843AOP has a secondary flash programming interface:

- **P2 Connector**: 8-pin test point header for direct QSPI programming of the
  radar's WinBond flash
- **Unpopulated FFC**: 10-pin connector for LVDS raw radar data output
- **SOP Pins**: Sense-On-Power configuration:
  - SOP0=0, SOP1=0: UART bootloader mode
  - SOP0=1, SOP1=0: Normal execution mode

## Physical Construction

- **Case**: Two-piece plastic shell secured by 4 screws under rubber plugs
- **USB-C**: Daughter board connected via internal header (power only)
- **Antenna**: External U.FL WiFi antenna on flexible cable
- **PCB**: Held by plastic clips — can be propped up for access without full removal

## Power

- USB-C, 5V, ~1A
- No battery; requires continuous power
