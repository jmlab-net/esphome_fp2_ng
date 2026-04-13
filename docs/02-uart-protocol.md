# Aqara FP2 UART Protocol Specification

## Overview

The ESP32 and TI IWR6843AOP radar communicate over UART using a custom
Aqara-designed protocol. This is **not** TI's standard TLV frame format.

- **ESP32 TX pin**: GPIO18
- **ESP32 RX pin**: GPIO19
- **Radar NRESET**: GPIO13
- **Baud rate**: 890,000

## Frame Format

All frames follow this structure:

```
┌──────┬───────┬───────┬─────┬────────┬───────┬───────┬────────┬─────────┬───────┬───────┐
│ Sync │ Ver_H │ Ver_L │ Seq │ OpCode │ Len_H │ Len_L │ HCheck │ Payload │ CRC_L │ CRC_H │
│ 0x55 │ 0x00  │ 0x01  │     │        │       │       │        │  N bytes│       │       │
│ 1B   │ 1B    │ 1B    │ 1B  │ 1B     │ 1B    │ 1B    │ 1B     │  var    │ 1B    │ 1B    │
└──────┴───────┴───────┴─────┴────────┴───────┴───────┴────────┴─────────┴───────┴───────┘
  [0]    [1]     [2]    [3]    [4]      [5]     [6]     [7]      [8..N+7]  [N+8]  [N+9]
```

| Field | Size | Description |
|-------|------|-------------|
| Sync | 1 | Fixed `0x55` — frame start marker |
| Version | 2 | Fixed `0x0001` — protocol version |
| Sequence | 1 | Rolling frame counter (0-255) |
| OpCode | 1 | Operation type (see below) |
| Length | 2 | Payload length in bytes (big-endian) |
| Header Check | 1 | `~(sum(bytes[0:7]) - 1) & 0xFF` |
| Payload | N | Attribute data (see Payload Structure) |
| CRC-16 | 2 | CRC-16/MODBUS over entire frame excluding CRC bytes (little-endian) |

## Header Checksum

Computed over bytes 0-6 (Sync through Len_L):

```
header_check = (~(sum(frame[0:7]) - 1)) & 0xFF
```

## CRC-16/MODBUS

- Polynomial: 0xA001 (reflected)
- Initial value: 0xFFFF
- Computed over the entire frame from Sync through Payload (excluding CRC bytes)
- Stored in little-endian byte order

## OpCodes

| Value | Name | Direction | Description |
|-------|------|-----------|-------------|
| 0x01 | RESPONSE | Radar → ESP32 | Standard response to a read request, OR reverse-read request (SubID only, no data) |
| 0x02 | WRITE | ESP32 → Radar | Write attribute value |
| 0x03 | ACK | Both | Acknowledge receipt of a frame |
| 0x04 | READ | ESP32 → Radar | Standard read request, OR reverse-read response (values, replying to a 0x01 query) |
| 0x05 | REPORT | Radar → ESP32 | Asynchronous/unsolicited report |

### OpCode Dispatch Table (from RE)

Found at DROM address `3f40a6cc` in the stock firmware:

| OpCode | Name | Handler Address | Description |
|--------|------|-----------------|-------------|
| 0x01 | RESPONSE | `0x400DE904` | Response/reverse-read handler |
| 0x02 | WRITE | `0x400DE8F0` | Write handler |
| 0x03 | ACK | `0x400E1390` | ACK handler (largest) |
| 0x04 | READ | `0x400DE8DC` | Read/reverse-response handler |
| 0x05 | REPORT | `0x400DE8C8` | Report handler |

### ACK Behaviour

- All WRITE commands expect an ACK from the radar
- All REPORT frames (except heartbeat/`RADAR_SW_VERSION`) should be ACKed by the ESP32
- ACK and READ (reverse response) frames do not expect an ACK
- Timeout: 500ms per attempt, 3 retries before dropping

## Payload Structure

The payload starts with a 2-byte attribute ID (SubID), followed by a data type
byte and the value:

```
┌────────────┬──────────┬───────────┐
│ SubID (2B) │ DataType │ Data (N)  │
│ Big-endian │  (1B)    │           │
└────────────┴──────────┴───────────┘
```

### Data Types

| Value | Name | Size | Description |
|-------|------|------|-------------|
| 0x00 | UINT8 | 1 byte | Unsigned 8-bit integer |
| 0x01 | UINT16 | 2 bytes | Unsigned 16-bit integer (big-endian) |
| 0x02 | UINT32 | 4 bytes | Unsigned 32-bit integer (big-endian) |
| 0x03 | VOID | 0 bytes | No data (used in ACKs) |
| 0x04 | BOOL | 1 byte | Boolean (0 or 1) |
| 0x05 | STRING | variable | Null-terminated string |
| 0x06 | BLOB2 | 2 + N bytes | Length-prefixed binary: `[Len_H][Len_L][Data...]` |

### Reverse-Read Requests

When the radar sends a RESPONSE (0x01) with a payload of exactly 2 bytes
(SubID only, no data type or value), it is a **reverse-read request** — the
radar is asking the ESP32 to provide a value. The ESP32 replies with a READ
(0x04) frame containing the requested data.

Known reverse-read attributes:
- `0x0143` DEVICE_DIRECTION — ESP32 returns accelerometer orientation
- `0x0120` ANGLE_SENSOR_DATA — ESP32 returns accelerometer tilt angle

## Complete Attribute ID (SubID) Reference

Status: Y = implemented, P = partial (defined but not fully handled), N = not implemented

### System / Info

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0101 | HW_VERSION | ? | R→E | N | Hardware version |
| 0x0102 | RADAR_SW_VERSION | UINT8 | R→E | Y | Heartbeat / firmware version (~1Hz) |
| 0x0127 | OTA_SET_FLAG | ? | E→R | N | OTA update flag |
| 0x0201 | DEBUG_LOG | ? | R→E | N | Debug log output |

### Detection Reports

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0103 | MOTION_DETECT | UINT8 | R→E | Y | Global motion (even=active, odd=inactive) |
| 0x0104 | PRESENCE_DETECT | UINT8 | R→E | Y | Global presence (0=empty, non-zero=occupied) |
| 0x0115 | DETECT_ZONE_MOTION | UINT16 | R→E | Y | Zone motion `[zone_id, state]` |
| 0x0116 | WORK_MODE | UINT8 | Both | Y | Work mode report/config |
| 0x0142 | ZONE_PRESENCE | UINT16 | R→E | Y | Zone presence `[zone_id, state]` |

### Configuration

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0105 | MONITOR_MODE | UINT8 | E→R | Y | Detection direction (0=default, 1=L/R) |
| 0x0106 | CLOSING_SETTING | UINT8 | E→R | Y | Proximity (0=far, 1=med, 2=close) |
| 0x0111 | PRESENCE_DETECT_SENSITIVITY | UINT8 | E→R | Y | Sensitivity (1-3) |
| 0x0122 | LEFT_RIGHT_REVERSE | UINT8 | E→R | Y | L/R swap (0/1/2) |
| 0x0170 | WALL_CORNER_POS | UINT8 | E→R | Y | Mount: 1=wall, 2=left, 3=right |

### Grid Maps

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0107 | EDGE_MAP | BLOB2 | E→R | Y | Detection boundary (40B grid) |
| 0x0109 | ENTRY_EXIT_MAP | BLOB2 | E→R | Y | Enter/exit zones (40B grid) |
| 0x0110 | INTERFERENCE_MAP | BLOB2 | E→R | Y | Interference sources (40B grid) |
| 0x0114 | ZONE_MAP | BLOB2 | E→R | Y | Zone area `[ID(1) + grid(40)]` |
| 0x0151 | ZONE_SENSITIVITY | UINT16 | E→R | Y | Zone sensitivity `[ID<<8\|sens]` |
| 0x0152 | DETECT_ZONE_TYPE | ? | E→R | P | Zone type (defined, not exposed) |
| 0x0153 | ZONE_CLOSE_AWAY_ENABLE | UINT16 | E→R | Y | Zone close/away `[ID<<8\|en]` |
| 0x0202 | ZONE_ACTIVATION_LIST | BLOB2 | E→R | Y | 32-byte zone bitmap |
| 0x0203 | ZONE_CONFIG_SYNC | UINT8 | E→R | N | Zone config sync (see below) |

### Auto-Calibration

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0125 | INTERFERENCE_AUTO_SET | BLOB2 | R→E | Y | Auto-detected interference grid |
| 0x0139 | INTERFERENCE_AUTO_ENABLE | BOOL | E→R | Y | Start interference auto-detect |
| 0x0149 | EDGE_AUTO_SET | BLOB2 | R→E | Y | Auto-detected edge grid |
| 0x0150 | EDGE_AUTO_ENABLE | BOOL | E→R | Y | Start edge auto-detect |
| 0x0160 | DELETE_FALSE_TARGETS | ? | E→R | N | Delete false targets |

### Location Tracking

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0112 | LOCATION_REPORT_ENABLE | UINT8 | E→R | Y | Enable target streaming |
| 0x0117 | LOCATION_TRACKING_DATA | BLOB2 | R→E | Y | Target positions (10-20Hz) |
| 0x0120 | ANGLE_SENSOR_DATA | UINT8 | E→R | Y | Accel angle (reverse-read) |
| 0x0143 | DEVICE_DIRECTION | UINT8 | E→R | Y | Orientation (reverse-read) |

### People Counting

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0155 | PEOPLE_COUNTING | BLOB2 | R→E | N | People counting data (complex blob) |
| 0x0158 | PEOPLE_COUNT_REPORT_ENABLE | BOOL | E→R | Y | Enable count reports |
| 0x0162 | PEOPLE_NUMBER_ENABLE | BOOL | E→R | Y | Enable number tracking |
| 0x0163 | TARGET_TYPE_ENABLE | BOOL | E→R | Y | AI person detection |
| 0x0164 | REALTIME_PEOPLE | UINT32 | R→E | Y | Real-time total person count |
| 0x0165 | ONTIME_PEOPLE_NUMBER | UINT32 | R→E | Y | Periodic total person count |
| 0x0166 | REALTIME_COUNT | UINT32 | R→E | Y | Real-time count (logged) |
| **0x0175** | **ZONE_PEOPLE_NUMBER** | **UINT16** | **R→E** | **Y** | **`[zone_id<<8\|count]` — native per-zone people count from radar** |

### Posture / Activity

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0154 | TARGET_POSTURE | UINT16 | R→E | Y | `[zone_id<<8\|posture]` — per-zone posture (0=none,1=standing,2=sitting,3=lying) |
| 0x0157 | POSTURE_REPORT_ENABLE | BOOL | E→R | P | Enable posture reporting (stalls queue — commented out) |
| 0x0172 | DWELL_TIME_ENABLE | BOOL | E→R | P | Dwell tracking (disabled in init) |
| 0x0173 | WALK_DISTANCE_ENABLE | BOOL | E→R | P | Walking distance (disabled in init) |
| 0x0174 | WALK_DISTANCE_ALL | UINT32 | R→E | N | Walking distance (converted to float) |

### Fall Detection

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0121 | FALL_DETECTION | UINT8 | R→E | Y | Fall event state byte (binary_sensor) |
| 0x0123 | FALL_SENSITIVITY | UINT8 | E→R | P | Sensitivity (stalls queue — commented out) |
| 0x0134 | FALL_OVERTIME_PERIOD | UINT32 | E→R | N | Fall overtime report period |
| 0x0135 | FALL_OVERTIME_DETECTION | UINT32 | R→E | N | Fall overtime detection event |

### Sleep Monitoring

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0156 | SLEEP_REPORT_ENABLE | BOOL | E→R | Y | Enable sleep reporting |
| 0x0159 | SLEEP_DATA | BLOB2 | R→E | Y | 3-4x IEEE 754 float **LE**: heartRate, breathRate, heartDev, [breathDev] (confirmed from radar FW) |
| 0x0161 | SLEEP_STATE | UINT8 | R→E | Y | 0=awake, 1=light, 2=deep, 3=rem |
| 0x0167 | SLEEP_PRESENCE | UINT8 | R→E | Y | Sleep zone presence (binary_sensor) |
| 0x0168 | SLEEP_MOUNT_POSITION | UINT8 | E→R | P | Sleep mount pos (defined, unused) |
| 0x0169 | SLEEP_ZONE_SIZE | UINT32 | E→R | P | Sleep zone dimensions |
| 0x0171 | SLEEP_IN_OUT | UINT8 | R→E | Y | Sleep zone entry/exit (updates sleep_presence) |
| 0x0176 | SLEEP_EVENT | UINT8 | R→E | Y | Sleep event type (logged) |

### BLOB2 Byte Order

Typed protocol fields (UINT8, UINT16, UINT32) use **big-endian** byte order
in the UART payload. However, BLOB2 content is **raw bytes in the radar's
native little-endian** byte order (TI IWR6843 is ARM Cortex-R4, LE).

This was confirmed by decompiling `radar_sleep_data` (0x400e47c4) in the
stock firmware: it performs a raw `memcpy` of the BLOB2 content into 3 x
uint32 on the little-endian ESP32, with no byte swap.

### Sleep Data (SubID 0x0159) — Confirmed from Radar Firmware

The BLOB2 payload contains IEEE 754 floats in little-endian byte order.
This was confirmed by analysing debug strings in the radar firmware binary
(TI Vital Signs with People Tracking demo, strings at offset 0x1a1394):

```
heartRate = %.0f
breathRate = %.0f
heartDev = %.0f
breathingDev = %.0f
```

| Offset | Field | Type | Unit | Description |
|--------|-------|------|------|-------------|
| 0-3 | heartRate | float LE | bpm | Heart rate |
| 4-7 | breathRate | float LE | breaths/min | Respiration rate |
| 8-11 | heartDev | float LE | bpm | Heart rate deviation/variability |
| 12-15 | breathingDev | float LE | breaths/min | Breathing deviation (not captured by stock ESP32) |

The stock ESP32 firmware copies the first 12 bytes (3 floats) via memcpy,
dropping the 4th field (breathingDev). Our implementation does the same.

**Important:** These are IEEE 754 float values, NOT uint32 integers. Reading
the raw bytes as uint32 produces garbage (e.g. float 72.0 = 0x42900000 =
1,116,733,440 as uint32).

### Walking Distance (SubID 0x0174) — Confirmed

The UINT32 value is in **centimetres**. The stock firmware divides by the
constant 100.0 (confirmed at `Ram400d0ff4` = float 0x42C80000 = 100.0) to
produce metres.

### Previously Undocumented SubIDs (from handler table RE)

| SubID | Type | Dir | Description |
|-------|------|-----|-------------|
| 0x0113 | BOOL | R→E | Unknown (report only) |
| 0x0118 | any | R→E | Reserved (null handler) |
| 0x0119 | any | — | Reserved (null handler) |
| 0x0124 | any | — | Reserved (null handler) |
| 0x0126 | any | R→E | Reserved (null handler) |
| 0x0129 | any | E←R | Reverse-read request (unknown purpose) |
| 0x0130-0x0133 | any | — | Reserved (null handlers) |
| 0x0136-0x0137 | any | — | Reserved (null handlers) |
| 0x0140 | any | R→E | Report only (null handler) |
| 0x0177 | UINT16 | R→E | Unknown (new SubID from handler table) |
| 0x0178 | UINT16 | R→E | Unknown (new SubID from handler table) |
| 0x0179 | UINT16 | R→E | Unknown (new SubID from handler table) |
| 0x0180 | BLOB2 | E→R | Unknown (new SubID from handler table) |

### Temperature

| SubID | Name | Type | Dir | Status | Description |
|-------|------|------|-----|--------|-------------|
| 0x0128 | TEMPERATURE | UINT16 | R→E | Y | Radar chip temperature |
| 0x0138 | THERMO_EN | BOOL | E→R | Y | Enable temperature reporting |
| 0x0141 | THERMO_DATA | UINT8 | E→R | Y | Temperature data mode |

*Dir: R→E = Radar to ESP32, E→R = ESP32 to Radar*

## Location Tracking Data (SubID 0x0117)

This is the richest data source, containing per-target tracking information.

### Payload Layout

```
[SubID 2B] [Type 0x06] [Len_H] [Len_L] [Count 1B] [Target0 14B] [Target1 14B] ...
```

- **Count** (byte 5 in payload): Number of tracked targets (uint8)
- **Targets**: Array of 14-byte target structures

### Target Structure (14 bytes)

| Offset | Field | Type | Range | Description |
|--------|-------|------|-------|-------------|
| 0 | Target ID | uint8 | 0-255 | Unique tracker ID |
| 1-2 | X Position | int16 BE | -400 to +400 | Horizontal position |
| 3-4 | Y Position | int16 BE | 0 to 800 | Distance from sensor |
| 5-6 | Z Position | int16 BE | — | Vertical position |
| 7-8 | Velocity | int16 BE | — | Movement speed |
| 9-10 | SNR | uint16 BE | — | Signal-to-noise ratio |
| 11 | Classifier | uint8 | — | Object classification (person vs other) |
| 12 | Posture | uint8 | — | Body posture/orientation |
| 13 | Active | uint8 | — | Activity state |

### Coordinate System

```
        Sensor
          ▼
    X=+400  X=-400
    ┌──────────────┐  Y = 0 (closest to sensor)
    │              │
    │   Detection  │
    │     Area     │
    │              │
    │              │
    └──────────────┘  Y = 800 (farthest from sensor)
```

- **X axis**: Parallel to sensor face. +400 = left edge, -400 = right edge
- **Y axis**: Perpendicular to sensor. 0 = closest, 800 = farthest
- **Physical scale**: Raw range 800 units ≈ 7 metres
- **Conversion**: `metres = raw_value / 800.0 * 7.0`

The coordinate system is the same regardless of mounting position (wall, left
corner, right corner). Mounting position affects the radar's internal
calibration, not the coordinate ranges.

## Startup Sequence

1. ESP32 resets radar via GPIO13 (NRESET low for 100ms, then high)
2. Radar begins sending heartbeat reports (`RADAR_SW_VERSION`, ~1 Hz)
3. **Wait for radar boot completion** — the radar sends heartbeats during its
   boot phase but does NOT ACK WRITE commands during this time. Init is
   deferred until a non-heartbeat frame arrives (TEMPERATURE 0x0128 or
   DEVICE_DIRECTION 0x0143), which signals the radar is fully ready.
4. ESP32 begins initialization sequence:
   a. Basic settings (monitor mode, L/R reverse, sensitivity, proximity)
   b. Feature enables (people count, target type, sleep, thermometer)
   c. Mounting position configuration
   d. Grid maps (interference, exit, edge)
   e. Zone maps with per-zone sensitivity
   f. Zone activation list (0x0202)
   g. Per-zone close/away enable
5. Each WRITE waits for ACK before proceeding (500ms timeout, 3 retries)
6. ESP32 publishes initial state (all zones = no presence/motion)
7. Steady state: radar sends reports, ESP32 ACKs and processes them

**Note**: The stock firmware also sends ZONE_CONFIG_SYNC (0x0203) on every
heartbeat after zone reconfiguration. Our component does not implement this
because zones are static (defined in YAML at compile time). See the 0x0203
section below for details.

## Grid Maps

All grids are 40 bytes encoding a 20-row x 16-column bitmap.

### Encoding

- Each row is 2 bytes, big-endian
- Bit 15 (MSB of first byte) = column 0 (leftmost)
- Bit 0 (LSB of second byte) = column 15 (rightmost)
- Row 0 is closest to the sensor

### User-Facing Grid (14x14)

The user configures zones using a 14x14 ASCII grid. This maps to the internal
20x16 grid with offsets:

- Row offset: 0 (input row 0 → internal row 0)
- Column offset: 2 (input col 0 → internal col 2)
- Active area occupies rows 0-13, columns 2-15

### Mapping Raw Coordinates to Grid

To determine which grid cell a target occupies:

```
grid_col = int((-raw_x + 400) / 800.0 * 14.0) + 2
grid_row = int(raw_y / 800.0 * 14.0)
```

Then check the zone's grid bitmap:
```
row_val = (grid[row * 2] << 8) | grid[row * 2 + 1]
is_in_zone = (row_val & (1 << (15 - col))) != 0
```

## Edge Grid Requirement

The radar does **not** send global presence/motion reports (0x0103, 0x0104)
unless an edge grid (0x0107) is configured. Without it, the radar tracks targets
(0x0117 data flows) but never triggers binary presence detection.

If no `edge_grid` is specified in the ESPHome config, a full-coverage default
is sent automatically during initialization. The default covers 14 active
rows (0-13) with columns 2-15 active (row value `0x3FFC`).

## Zone Configuration Sync (SubID 0x0203)

Reverse-engineered from the stock firmware. This SubID is **not required** for
basic operation but is documented here for future reference.

### Mechanism

The stock firmware sends `WRITE SubID=0x0203 UINT8 <value>` to the radar.
This is a zone configuration synchronization command triggered after runtime
zone changes.

### Call Chain (from RE)

```
radar_sw_version()        @ 0x400e4f28  (heartbeat handler, SubID 0x0102)
  └─ heartbeat_config_sync()  @ 0x400decd4  (sends WRITE 0x0203)
       └─ FUN_400e7e20()      @ 0x400e7e20  (frame builder, opcode=2=WRITE)
```

### When It's Sent

Called from the heartbeat handler on every heartbeat (~1Hz), but **only when**:
1. A "needs sync" flag (`Ram400d1480`) is set, AND
2. An internal zone config state flag is set

The flag is set by `FUN_400e5ebc()` (zone reconfiguration trigger), which:
- Increments a persistent NVS counter (config version)
- Triggers zone-related callbacks
- Resets ALL detection states (presence, motion) to 0xFF (unknown)
- Sets the heartbeat sync flag

### Payload

```
[SubID: 0x02 0x03] [DataType: 0x00 (UINT8)] [Value: 1 byte]
```

The value comes from offset 599 (0x257) of the main state struct at
`Ram400d0e2c`. Its exact meaning is unclear but is likely a zone
configuration version counter or active zone count.

### Handler Table

SubID 0x0203 has **no entry** in the 139-entry handler registration table at
`0x3FFB1158`. It is write-only (ESP32 → radar). SubID 0x0202
(ZONE_ACTIVATION_LIST) is also write-only with no handler entry.

### Why We Don't Implement It

Our ESPHome component uses static zones (defined in YAML at compile time).
The stock firmware sends 0x0203 after **runtime** zone reconfiguration
(e.g., via the Aqara app). Since our zones never change after init, the
one-time ZONE_ACTIVATION_LIST (0x0202) sent during init is sufficient.

If dynamic zone reconfiguration is ever added, this command should be sent
after each zone change, following the stock firmware pattern:
1. Send updated zone maps and activation list
2. Set the sync flag
3. heartbeat_config_sync fires on next heartbeat, sending 0x0203

## Handler Function Name Table (from RE)

Extracted from DROM at `3f409d00 - 3f40a6c0`. Each SubID has two handler
functions in the stock firmware:
- `radar_*` — processes data locally (HomeKit, sensor updates)
- `cloud_*` — relays data to Aqara cloud servers

| SubID | radar_ handler | cloud_ handler |
|-------|---------------|----------------|
| 0x0101 | `radar_hw_version` | — |
| 0x0102 | `radar_sw_version` | — |
| 0x0103 | `radar_motion_detection` | `cloud_motion_detection` |
| 0x0104 | `radar_presence_detection` | `cloud_presence_detection` |
| 0x0105 | — | `cloud_monitor_mode` |
| 0x0106 | — | `cloud_closing_setting` |
| 0x0107 | — | `cloud_edge_lable` |
| 0x0109 | — | `cloud_import_export_lable` |
| 0x0110 | — | `cloud_interference_source` |
| 0x0111 | — | `cloud_presence_detection_sensitivity` |
| 0x0112 | — | `cloud_location_report_enable` |
| 0x0114 | `radar_zone_map` | `cloud_detect_zone_setting` |
| 0x0115 | `radar_detect_zone_motion` | `cloud_detect_zone_motion` |
| 0x0116 | — | `cloud_work_mode` |
| 0x0117 | `radar_location_track_data` | `cloud_location_track_data` |
| 0x0120 | `radar_angle_sensor_data` | — |
| 0x0121 | `radar_fall_detection` | `cloud_fall_detection` |
| 0x0122 | — | `cloud_left_right_reverse` |
| 0x0123 | — | `cloud_fall_detection_sensitivity` |
| 0x0125 | `radar_interference_auto_setting` | — |
| 0x0128 | `radar_temperature` | `cloud_temperature` |
| 0x0134 | — | `cloud_fall_overtime_report_period` |
| 0x0135 | `radar_fall_overtime_detection` | `cloud_fall_overtime_detection` |
| 0x0138 | — | `cloud_thermodynamic_chart_enable` |
| 0x0139 | — | `cloud_interference_auto_enable` |
| 0x0141 | `radar_thermodynamic_chart_data` | `cloud_thermodynamic_chart_data` |
| 0x0142 | `radar_detect_zone_presence` | `cloud_detect_zone_presence` |
| 0x0143 | `radar_device_direction` | — |
| 0x0149 | `radar_edge_auto_setting` | — |
| 0x0150 | — | `cloud_edge_auto_enable` |
| 0x0151 | — | `cloud_detect_zone_sensitivity` |
| 0x0152 | — | `cloud_detect_zone_type` |
| 0x0153 | — | `cloud_detect_zone_close_away_enalbe` |
| 0x0154 | `radar_target_posture` | `cloud_target_posture` |
| 0x0155 | `radar_people_counting` | `cloud_people_counting` |
| 0x0156 | — | `cloud_sleep_report_enable` |
| 0x0157 | — | `cloud_posture_report_enable` |
| 0x0158 | — | `cloud_people_counting_report_enable` |
| 0x0159 | `radar_sleep_data` | `cloud_sleep_data` |
| 0x0160 | — | `cloud_delete_false_target` |
| 0x0161 | `radar_sleep_state` | `cloud_sleep_state` |
| 0x0162 | — | `cloud_people_number_enable` |
| 0x0163 | — | `cloud_target_type_enable` |
| 0x0164 | `radar_realtime_people_number` | `cloud_realtime_people_number` |
| 0x0165 | `radar_ontime_people_number` | `cloud_ontime_people_number` |
| 0x0166 | `radar_realtime_people_counting` | `cloud_realtime_people_counting` |
| 0x0167 | `radar_sleep_presence` | `cloud_sleep_presence` |
| 0x0168 | — | `cloud_sleep_zone_mount_position` |
| 0x0169 | — | `cloud_sleep_zone_size` |
| 0x0170 | — | `cloud_wall_corner_mount_position` |
| 0x0171 | `radar_sleep_inout_state` | `cloud_sleep_inout_state` |
| 0x0172 | — | `cloud_dwell_time_enable` |
| 0x0173 | — | `cloud_walking_distance_enable` |
| 0x0174 | `radar_walking_distance_all` | `cloud_walking_distance_all` |
| 0x0176 | `radar_sleep_event` | `cloud_sleep_event` |
| 0x0175 | `radar_zone_people_number` | `cloud_zone_people_number` |
| 0x0201 | `radar_debug_log_report` | — |

### Cloud-Only Attributes (from RE)

These attributes are configured/used exclusively by the Aqara cloud and have
no corresponding SubID in the radar UART protocol:

| Handler Name | Description |
|---|---|
| `cloud_sleep_bed_height` | Bed height configuration for sleep zone |
| `cloud_overhead_height` | Ceiling/overhead height configuration |
| `cloud_fall_delay_time` | Fall detection delay before alerting |
| `cloud_falldown_blind_zone` | Fall detection exclusion zone |
| `cloud_disturbance_enable` | Disturbance suppression toggle |
| `cloud_disturbance_time_setting` | Disturbance suppression timing |
| `cloud_interface_ctrl_report` | Interface control reporting |
| `cloud_reset_absent_status` | Reset absence state |

### Native Per-Zone People Counting (SubID 0x0175)

The radar natively supports per-zone person counting via SubID **0x0175**
(`radar_zone_people_number`). Payload format: **UINT16** where
`high byte = zone ID`, `low byte = people count in that zone`. This is the
same format as zone presence (0x0142) and target posture (0x0154).

**Status: Implemented.** The ESPHome component handles 0x0175 reports
directly. It also derives per-zone counts from target tracking data (0x0117)
as a fallback when location reporting is enabled.

### Handler Registration Table Structure (from RE)

The stock firmware's SubID dispatch uses a registration table at DRAM
`0x3FFB1158` with 139 entries, each 32 bytes:

```c
struct handler_entry {          // 32 bytes per entry
    uint16_t sub_id;            // +0x00: SubID
    uint8_t  data_type;         // +0x02: expected type (7 = any)
    uint8_t  padding;           // +0x03
    uint32_t user_data;         // +0x04: context passed to handler
    void    *handler_func;      // +0x08: radar handler function
    void    *cloud_func;        // +0x0C: cloud relay function
    uint8_t  reserved[8];       // +0x10 - +0x17
    uint8_t  allowed_opcodes[5];// +0x18 - +0x1C: which opcodes trigger this
};
```

The dispatcher at `FUN_400de81c` iterates all 139 entries, matching on
SubID and opcode. If the data type doesn't match (and isn't 7/any), the
frame is NACKed.

## Radar Firmware Version Compatibility

The stock ESP32 firmware (v4.66.85) contains a version compatibility table
for radar firmware versions. Found at DROM `3f40a6f4`:

```
3.1.85, 3.2.85, 3.3.85, ..., 3.23.85+
```

The `.85` suffix appears to be a hardware/product variant identifier shared
between ESP32 app firmware (4.x.85) and radar firmware (3.x.85).
