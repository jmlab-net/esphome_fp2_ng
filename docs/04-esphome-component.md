# ESPHome Component Reference

## Overview

The project provides two ESPHome external components:

- **`aqara_fp2`** — main radar UART communication and entity management
- **`aqara_fp2_accel`** — accelerometer driver for orientation detection

## Component Architecture

```
__init__.py          Python config schema and code generation
fp2_component.h      C++ header — types, enums, class declaration
fp2_component.cpp    C++ implementation — protocol, state machine, handlers
```

### Key Classes

- **`FP2Component`** — main component, extends `Component` and `UARTDevice`.
  Manages the UART state machine, command queue, and all sensor entities.
- **`FP2Zone`** — per-zone configuration and sensor holders. Contains the zone's
  grid bitmap, sensitivity, and pointers to presence/motion/count sensors.
- **`FP2LocationSwitch`** — switch entity to enable/disable target location
  reporting.
- **`AqaraFP2Accel`** — accelerometer component running on a dedicated FreeRTOS
  task for non-blocking I2C reads.

## UART State Machine

The frame decoder in `handle_incoming_byte_()` processes bytes one at a time:

```
SYNC → VER_H → VER_L → SEQ → OPCODE → LEN_H → LEN_L → H_CHECK → PAYLOAD → CRC_L → CRC_H
  │                                                         │                          │
  │ (not 0x55)                                              │ (checksum fail)          │ (CRC fail)
  └─────────────────────────────────────────────────────────┴──────────────────────────┘
                              Reset to SYNC
```

After successful CRC validation, the frame is dispatched to `handle_parsed_frame_()`
which routes by OpCode to:
- `handle_ack_()` — processes ACKs, releases command queue
- `handle_report_()` — processes radar reports (presence, motion, tracking, etc.)
- `handle_response_()` — handles reverse-read requests from the radar

## Command Queue

Commands are queued in a `std::deque<FP2Command>` and sent sequentially:

1. `send_next_command_()` sends the front command
2. If it's a WRITE, sets `waiting_for_ack_attr_id_` and waits
3. On ACK, pops the command and sends the next
4. On timeout (500ms), retries up to 3 times before dropping
5. ACK frames are high-priority — pushed to the front of the queue

## Exposed Entities

### Global Sensors

| Config Key | Entity Type | Class | Description |
|------------|-------------|-------|-------------|
| `global_zone.presence` | binary_sensor | occupancy | Overall presence (from SubID 0x0104) |
| `global_zone.motion` | binary_sensor | motion | Overall motion (from SubID 0x0103) |
| `people_count` | sensor | measurement | Total person count (from SubID 0x0165) |
| `target_tracking` | text_sensor | diagnostic | Base64-encoded target data (from SubID 0x0117) |
| `location_report_switch` | switch | — | Enable/disable location tracking reports |
| `radar_temperature` | sensor | temperature | Radar chip temperature in Celsius |
| `radar_software_version` | text_sensor | diagnostic | Radar firmware version |
| `mounting_position_sensor` | text_sensor | diagnostic | Current mount position string |

### Per-Zone Sensors

| Config Key | Entity Type | Class | Description |
|------------|-------------|-------|-------------|
| `presence` | binary_sensor | occupancy | Zone presence (from SubID 0x0142) |
| `motion` | binary_sensor | motion | Zone motion (from SubID 0x0115) |
| `zone_people_count` | sensor | measurement | People count in zone (derived from 0x0117 targets) |
| `zone_map_sensor` | text_sensor | diagnostic | Zone grid as hex string |

### Grid Diagnostic Sensors

| Config Key | Entity Type | Description |
|------------|-------------|-------------|
| `edge_label_grid_sensor` | text_sensor | Edge boundary grid hex |
| `entry_exit_grid_sensor` | text_sensor | Entry/exit grid hex |
| `interference_grid_sensor` | text_sensor | Interference source grid hex |

## Per-Zone People Counting

Zone people counting works by cross-referencing target positions from the
location tracking data (SubID 0x0117) against each zone's grid bitmap:

1. When any zone has a `zone_people_count` sensor configured, location reporting
   is automatically enabled during initialization
2. Each location tracking report (10-20 Hz) contains all tracked targets with
   their x/y positions
3. For each zone, the component counts how many targets fall within the zone's
   grid cells using `is_target_in_zone_()`
4. The count is published to the zone's sensor

The coordinate-to-grid mapping:
```cpp
col = int((-raw_x + 400) / 800.0 * 14.0) + 2  // offset_col = 2
row = int(raw_y / 800.0 * 14.0)                 // offset_row = 0
```

## Configuration Reference

### Minimal Config

```yaml
uart:
  id: uart_bus
  tx_pin: GPIO19
  rx_pin: GPIO18
  baud_rate: 890000

external_components:
  - source: github://JameZUK/esphome_fp2_ng@main
    refresh: 120s
    components: [ aqara_fp2, aqara_fp2_accel ]

aqara_fp2_accel:
  id: fp2_accel

aqara_fp2:
  id: fp2
  accel: fp2_accel
  uart_id: uart_bus
  radar_reset_pin: GPIO13
  mounting_position: wall  # wall | left_corner | right_corner

  global_zone:
    presence:
      name: "Presence"
```

### Full Config with Zone Counting

```yaml
aqara_fp2:
  id: fp2
  accel: fp2_accel
  uart_id: uart_bus
  radar_reset_pin: GPIO13
  mounting_position: left_corner
  left_right_reverse: false

  # Global sensors
  people_count:
    name: "Total People"
  radar_temperature:
    name: "Radar Temperature"
  radar_software_version:
    name: "Radar Version"
  target_tracking:
    name: "Targets"
  location_report_switch:
    name: "Report Targets"

  # Optional grids (14x14, X=active, .=inactive)
  interference_grid: |-
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............
    ..............

  # Global presence/motion
  global_zone:
    presence_sensitivity: medium  # low | medium | high
    presence:
      name: "Global Presence"
    motion:
      name: "Global Motion"

  # Detection zones
  zones:
    - id: bed_zone
      grid: |-
        ..............
        ..............
        ..............
        ..XXXXXXXXXX..
        ..XXXXXXXXXX..
        ..XXXXXXXXXX..
        ..XXXXXXXXXX..
        ..............
        ..............
        ..............
        ..............
        ..............
        ..............
        ..............
      presence_sensitivity: high
      presence:
        name: "Bed Presence"
      motion:
        name: "Bed Motion"
      zone_people_count:
        name: "Bed People Count"

    - id: desk_zone
      grid: |-
        ..............
        ..............
        ..............
        ..............
        ..............
        ..............
        ..............
        ..............
        ........XXXX..
        ........XXXX..
        ........XXXX..
        ..............
        ..............
        ..............
      presence_sensitivity: medium
      presence:
        name: "Desk Presence"
      zone_people_count:
        name: "Desk People Count"
```

### Required ESP32 Config

The FP2 uses a single-core ESP32 variant. This config block is mandatory:

```yaml
esp32:
  board: esp32-solo1
  framework:
    type: esp-idf
    sdkconfig_options:
      CONFIG_FREERTOS_UNICORE: "y"
      CONFIG_ESP_SYSTEM_SINGLE_CORE_MODE: "y"
    advanced:
      ignore_efuse_mac_crc: true
      ignore_efuse_custom_mac: true
```

### Map Config Service (for Lovelace Card)

To use the custom Lovelace card, add this API action:

```yaml
api:
  encryption:
    key: !secret api_encryption_key
  actions:
    - action: get_map_config
      supports_response: only
      then:
        - api.respond:
            data: !lambda |-
              id(fp2).json_get_map_data(root);
```

## Accelerometer Component

The `aqara_fp2_accel` component runs on a dedicated FreeRTOS task to avoid
blocking the main ESPHome loop with I2C operations.

- **I2C bus**: GPIO32 (SCL), GPIO33 (SDA), 400kHz
- **Device address**: 0x27 (MiraMEMS da218B)
- **Sample rate**: 10 samples averaged, configurable interval (default 100ms)
- **Outputs**: Orientation enum (UP, DOWN, SIDE, etc.), tilt angle, vibration state
- **Thread safety**: All public accessors use FreeRTOS mutexes

The radar periodically queries the ESP32 for orientation and angle data via
reverse-read requests (SubIDs 0x0143, 0x0120). The accelerometer component
provides these values.
