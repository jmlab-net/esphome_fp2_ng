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

## Attribute IDs (SubIDs)

### Configuration Attributes (ESP32 → Radar, via WRITE)

| SubID | Name | Type | Description |
|-------|------|------|-------------|
| 0x0105 | MONITOR_MODE | UINT8 | Detection direction: 0=default, 1=left/right |
| 0x0106 | CLOSING_SETTING | UINT8 | Proximity: 0=far, 1=medium, 2=close |
| 0x0107 | EDGE_MAP | BLOB2 | Detection boundary grid (40 bytes) |
| 0x0109 | ENTRY_EXIT_MAP | BLOB2 | Entry/exit zone grid (40 bytes) |
| 0x0110 | INTERFERENCE_MAP | BLOB2 | Interference source grid (40 bytes) |
| 0x0111 | PRESENCE_DETECT_SENSITIVITY | UINT8 | Sensitivity: 1=low, 2=medium, 3=high |
| 0x0112 | LOCATION_REPORT_ENABLE | UINT8 | Enable target location streaming (0/1) |
| 0x0114 | ZONE_MAP | BLOB2 | Zone N area map: `[ZoneID(1)][Grid(40)]` |
| 0x0116 | WORK_MODE | UINT8 | Operating mode |
| 0x0122 | LEFT_RIGHT_REVERSE | UINT8 | L/R swap: 0=normal, 1=?, 2=reversed |
| 0x0123 | FALL_SENSITIVITY | UINT8 | Fall detection sensitivity |
| 0x0128 | TEMPERATURE | — | Radar temperature |
| 0x0138 | THERMO_EN | BOOL | Enable temperature reporting |
| 0x0141 | THERMO_DATA | UINT8 | Temperature data mode |
| 0x0151 | ZONE_SENSITIVITY | UINT16 | `[ZoneID << 8 | Sensitivity]` |
| 0x0152 | DETECT_ZONE_TYPE | — | Zone N type |
| 0x0153 | ZONE_CLOSE_AWAY_ENABLE | UINT16 | `[ZoneID << 8 | Enable]` |
| 0x0158 | PEOPLE_COUNT_REPORT_ENABLE | BOOL | Enable people count reports |
| 0x0162 | PEOPLE_NUMBER_ENABLE | BOOL | Enable people number tracking |
| 0x0163 | TARGET_TYPE_ENABLE | BOOL | Enable AI person detection |
| 0x0168 | SLEEP_MOUNT_POSITION | UINT8 | Sleep zone mounting position |
| 0x0169 | SLEEP_ZONE_SIZE | — | Sleep zone dimensions |
| 0x0170 | WALL_CORNER_POS | UINT8 | Mounting position: 0x01=wall, 0x02=left corner, 0x03=right corner |
| 0x0172 | DWELL_TIME_ENABLE | UINT8 | Enable dwell time tracking |
| 0x0173 | WALK_DISTANCE_ENABLE | UINT8 | Enable walking distance tracking |
| 0x0202 | ZONE_ACTIVATION_LIST | BLOB2 | 32-byte zone activation bitmap |

### Report Attributes (Radar → ESP32, via REPORT)

| SubID | Name | Type | Rate | Description |
|-------|------|------|------|-------------|
| 0x0102 | RADAR_SW_VERSION | UINT8 | ~1 Hz | Heartbeat / radar firmware version |
| 0x0103 | MOTION_DETECT | UINT8 | Event | Global motion state (0=motion, else=no motion) |
| 0x0104 | PRESENCE_DETECT | UINT8 | Event | Global presence state (0=empty, else=occupied) |
| 0x0115 | DETECT_ZONE_MOTION | UINT16 | Event | `[ZoneID][State]` zone motion event |
| 0x0116 | WORK_MODE | UINT8 | Event | Work mode change notification |
| 0x0117 | LOCATION_TRACKING_DATA | BLOB2 | 10-20 Hz | Per-target position data (see below) |
| 0x0128 | TEMPERATURE | UINT16 | Periodic | Radar chip temperature |
| 0x0142 | ZONE_PRESENCE | UINT16 | Event | `[ZoneID][State]` zone presence (1=occupied, 0=empty) |
| 0x0165 | ONTIME_PEOPLE_NUMBER | UINT32 | Periodic | Total detected person count |

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
3. ESP32 detects first heartbeat and begins initialization:
   a. Basic settings (monitor mode, L/R reverse, sensitivity, proximity)
   b. Feature enables (people count, target type, thermometer)
   c. Mounting position configuration
   d. Grid maps (interference, exit, edge)
   e. Zone maps with per-zone sensitivity
   f. Zone activation list
   g. Per-zone close/away enable
4. Each WRITE waits for ACK before proceeding (500ms timeout, 3 retries)
5. ESP32 publishes initial state (all zones = no presence/motion)
6. Steady state: radar sends reports, ESP32 ACKs and processes them

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
