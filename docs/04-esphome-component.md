# ESPHome Component Reference

## Overview

The project provides two ESPHome external components:

- **`aqara_fp2`** — main radar UART communication and entity management
- **`aqara_fp2_accel`** — accelerometer + OPT3001 light sensor driver

## Component Architecture

```
aqara_fp2/
  __init__.py          Python config schema and code generation
  fp2_component.h      C++ header — types, enums, class declaration
  fp2_component.cpp    C++ implementation — protocol, state machine, handlers

aqara_fp2_accel/
  __init__.py          Python config schema
  aqara_fp2_accel.h    C++ header — accel + OPT3001
  aqara_fp2_accel.cpp  C++ implementation — I2C, orientation, lux
```

### Key Classes

- **`FP2Component`** — main component, extends `Component` and `UARTDevice`.
  Manages the UART state machine, command queue, and all sensor entities.
- **`FP2Zone`** — per-zone configuration and sensor holders. Contains the zone's
  grid bitmap, sensitivity, and pointers to presence/motion/count sensors.
- **`FP2LocationSwitch`** — switch entity to enable/disable target location
  reporting.
- **`FP2CalibrateEdgeButton`** — button entity to trigger edge auto-calibration.
- **`FP2CalibrateInterferenceButton`** — button entity to trigger interference
  auto-calibration.
- **`AqaraFP2Accel`** — accelerometer + light sensor component running on a
  dedicated FreeRTOS task for non-blocking I2C reads.

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
- `handle_response_()` — handles reverse-read requests from the radar, and
  routes data-bearing responses through `handle_report_()` (some SubIDs like
  zone presence may arrive as RESPONSE instead of REPORT)

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
| `global_zone.presence` | binary_sensor | occupancy | Overall presence (SubID 0x0104: 0=empty, non-zero=occupied) |
| `global_zone.motion` | binary_sensor | motion | Overall motion (SubID 0x0103: even=active, odd=inactive) |
| `people_count` | sensor | measurement | Total person count (from SubID 0x0165) |
| `fall_detection` | binary_sensor | — | Fall event (SubID 0x0121) — see note below |
| `sleep_state` | text_sensor | — | Sleep state: none/awake/light/deep (SubID 0x0161) |
| `sleep_presence` | binary_sensor | occupancy | Sleep zone presence (SubID 0x0167) |
| `heart_rate` | sensor (bpm) | measurement | Heart rate (SubID 0x0159 byte[3], direct u8) |
| `respiration_rate` | sensor (br/min) | measurement | Respiration rate (SubID 0x0159 byte[6], direct u8) |
| `heart_rate_deviation` | sensor (bpm) | measurement | Derived ESP-side: population std-dev of the last 10 HR samples. The radar does not emit a deviation field. |
| `walking_distance` | sensor | measurement (m) | Cumulative walking distance (SubID 0x0174, confirmed cm÷100) |
| `target_tracking` | text_sensor | diagnostic | Base64-encoded target data (SubID 0x0117) |
| `location_report_switch` | switch | — | Show/hide target tracking data (see below) |
| `calibrate_edge` | button | diagnostic | Trigger edge boundary auto-calibration |
| `calibrate_interference` | button | diagnostic | Trigger interference auto-calibration |
| `clear_edge` | button | diagnostic | Clear/reset room boundary calibration |
| `clear_interference` | button | diagnostic | Clear/reset interference calibration |
| `radar_fw_stage` | button | diagnostic | **EXPERIMENTAL** — Stage radar firmware from URL to flash |
| `radar_ota` | button | diagnostic | **EXPERIMENTAL** — Flash staged firmware to radar via XMODEM |
| `radar_temperature` | sensor | temperature | Radar chip temperature in Celsius |
| `radar_software_version` | text_sensor | diagnostic | Radar firmware build number |
| `mounting_position_sensor` | text_sensor | diagnostic | Current mount position string |

### Per-Zone Sensors

| Config Key | Entity Type | Class | Description |
|------------|-------------|-------|-------------|
| `presence` | binary_sensor | occupancy | Zone presence (inferred from motion and people count) |
| `motion` | binary_sensor | motion | Zone motion (SubID 0x0115: even=active, odd=inactive) |
| `zone_people_count` | sensor | measurement | Native per-zone count (SubID 0x0175) |
| `posture` | text_sensor | — | Per-zone posture: none/standing/sitting/lying (SubID 0x0154) |
| `zone_map_sensor` | text_sensor | diagnostic | Zone grid as hex string |

*Heart rate and respiration in FW3 (Sleep Monitoring mode) arrive on SubID
**0x0159**, the primary FW3 vitals channel. Confirmed via decompile of
`vitals_hr_br_emitter @ 0x00006c84` (and its emit call at `0x0000701a`) in
`fp2_radar_vitalsigns.bin`. The 12-byte payload (after the BLOB2 header) is:
`[tid][0][0][HR_bpm u8][0][HR_conf][BR_bpm u8][0][BR_conf][sleep_state][sleep_stage][event]`.
HR and BR are **direct u8 bpm**, not scaled. 0x0159 is not gated on
`LOCATION_REPORT_ENABLE` — it fires every ~6 s whenever GTrack has a track
allocated.*

*SubID 0x0117 in FW3 is a secondary 15-byte channel that emits HR×100 / BR×100
as u16 BE but requires `config+0xb8 == 1` (LOCATION_REPORT_ENABLE=1) AND
`target_count > 0` AND a cumulative frame counter > 15, so it rarely fires
for a stationary sleeper. The driver logs 0x0117 payloads for observability
but does not publish them to HR/BR sensors (to avoid racing 0x0159). The
`heartDev` / `breathDev` slots in the 0x0117 payload are always zero in FW3
— there is no radar-emitted deviation value. `heart_rate_deviation` is
therefore computed on the ESP32 as a rolling population std-dev over the
last 10 valid HR samples (~60 s at the 6 s 0x0159 cadence).*

*In FW1/FW2, SubID 0x0117 carries X/Y target tracking — the driver's
decoder is mode-aware via `sleep_mode_active_` and routes accordingly. See
[02-uart-protocol.md](02-uart-protocol.md) and [07-firmware-analysis.md](07-firmware-analysis.md)
for full details.*

**Fall detection note:** Radar firmware analysis found that SubID 0x0121 is
**not sent by the radar directly**. Fall detection data goes through SubID
0x0155 (PEOPLE_COUNTING). The stock ESP32 firmware likely extracts fall
events from 0x0155 and rebroadcasts as 0x0121. Our handler for 0x0121 may
not receive data — this needs further investigation.

### Accelerometer / Light Sensor

| Config Key | Entity Type | Class | Description |
|------------|-------------|-------|-------------|
| `light_sensor` | sensor | illuminance | OPT3001 ambient light (lux) |

### Grid Diagnostic Sensors

| Config Key | Entity Type | Description |
|------------|-------------|-------------|
| `edge_label_grid_sensor` | text_sensor | Edge boundary grid hex |
| `entry_exit_grid_sensor` | text_sensor | Entry/exit grid hex |
| `interference_grid_sensor` | text_sensor | Interference source grid hex |

## Per-Zone People Counting

Zone people counting uses the radar's native per-zone count reports
(SubID 0x0175). The radar internally counts people in each configured zone
and sends periodic REPORT frames with `[zone_id, count]`.

### Location Reporting and People Counting

The radar's people counting depends on its internal location tracking being
active. The component always enables `LOCATION_REPORT_ENABLE` (0x0112) during
initialization to ensure counting works.

The **Report Targets** switch controls only whether target tracking data is
published to the `target_tracking` text sensor in HA. It does **not** disable
the radar's internal tracking — people counting, zone presence inference, and
all other features continue working regardless of the switch state.

### Zone Presence Inference

The radar may not send explicit zone presence reports (SubID 0x0142) when a
zone is already occupied at boot — it only fires on state transitions. To
ensure zone presence is always accurate, it is inferred from:

- **Zone motion active** → zone presence ON
- **Zone people count > 0** → zone presence ON
- **Zone people count == 0** → zone presence OFF
- **Global presence OFF** → all zones cleared (cascade)

### State Clearing Cascade

When global presence (SubID 0x0104) reports empty (state 0), the component
clears all zone and global states to ensure consistency:

- All zone presence, motion, people count, and posture → cleared
- Global people count → 0
- Sleep state → "none", sleep presence → off
- Heart rate, respiration rate, heart rate deviation → unknown (NAN)

## Auto-Calibration

Four button entities manage the radar's calibration:

- **`calibrate_edge`** — writes `EDGE_AUTO_ENABLE` (0x0150) = true. The radar
  scans the environment and sends back `EDGE_AUTO_SET` (0x0149) with the detected
  room boundary grid. The component stores the grid, applies it to the radar,
  and updates the card diagnostic sensor.

- **`calibrate_interference`** — writes `INTERFERENCE_AUTO_ENABLE` (0x0139) = true.
  The radar identifies interference sources and sends back
  `INTERFERENCE_AUTO_SET` (0x0125) with the detected interference grid.

- **`clear_edge`** — sends an empty (all-zero) grid to `EDGE_MAP` (0x0107),
  resetting room boundary detection to uncalibrated. Updates the card sensor.

- **`clear_interference`** — sends an empty grid to `INTERFERENCE_MAP` (0x0110),
  clearing all interference source markers. Updates the card sensor.

## Operating Modes

The `operating_mode` select entity switches between three distinct radar
firmware images on the IWR6843AOP:

| Mode in UI | scene_mode | Radar FW | Use case |
|------------|------------|----------|----------|
| Zone Detection | 3 | FW1 (MSS zone detection) | General presence, tracking, per-zone counts |
| Fall Detection | 8 | FW2 (3D people counting + fall ML) | Fall events, ceiling mount |
| Sleep Monitoring | 9 | FW3 (vital signs + capon3d tracking) | Heart rate, respiration, sleep stage |
| Fall + Positioning | 8 | FW2 | Same FW2 image with positioning data enabled |

Switching modes writes `WORK_MODE` (SubID 0x0116), which triggers the radar's
MSS to flash-save its current config and self-restart. The secondary bootloader
(SBL) then reads `work_mode` from flash and loads the matching firmware image
from QSPI (FW1 @ 0x40000, FW2 @ 0x100000+, FW3 @ 0x460000). The whole cycle
takes about 5-10 seconds.

### Sleep Monitoring — critical setup step

FW3 uses TI's Group Tracker (GTrack) from the Industrial Toolbox 4.11.0
Vital_Signs_With_People_Tracking reference design. GTrack's track-allocation
function `gtrack_moduleAllocate()` has a hard-coded gate that blocks track
creation for a stationary target:

```c
if (allocNum > pointsThre            // ≥10 points (default pointsThre=10)
 && allocSNR > snrThre                // cluster SNR sum > 20
 && fabs(un[2]) > velocityThre)       // |centroid radial velocity| > 0.1 m/s
{
    /* allocate new track */
}
```

A sleeping person has radial velocity ≈ 0 (only breathing micro-motion, which
produces sub-mm displacement — well below 0.1 m/s). The CFAR points feeding
into GTrack report `doppler = 0`, the cluster centroid velocity is 0, and the
allocation fails. **No track is ever created**, `numCurrentTargets` stays 0
in the MSS↔DSS shared struct, and the 0x0117 emit gate
(`target_count != 0` inside `FUN_00006c84`) suppresses all output.

Confirmed from Aqara's embedded default config (strings extracted from
`fp2_radar_vitalsigns.bin`):

```
allocationParam 20 100 0.1 10 0.5 20
# snrThre=20, snrThrObscured=100, velocityThre=0.1, pointsThre=10, maxDistThre=0.5, maxVelThre=20
stateParam 2 50 50 900 50 9000
# det2active=2, det2free=50, active2free=50, static2free=900, exit2free=50, sleep2free=9000
```

**Once a track IS allocated**, it persists for a long time without needing
re-detection: `static2free=900` frames (~45s at 20Hz) for static targets and
`sleep2free=9000` frames (~7.5 min) for sleep-state targets. The Kalman filter
updates from subsequent low-velocity points and maintains the track through
breathing micro-motion.

So the key is to get a track allocated first, then lie still.

**There is also a second, non-obvious requirement on the ESP side:** the
driver's post-boot init WRITE burst (15+ SubIDs: MONITOR_MODE, LEFT_RIGHT_REVERSE,
PRESENCE_DETECT_SENSITIVITY, FALL_SENSITIVITY, LOCATION_REPORT_ENABLE, THERMO_EN,
sleep-zone params, etc.) disrupts FW3's DSS track-allocation pipeline. Stock
Aqara ESP32 emits zero UART WRITEs on radar-ready (verified via Ghidra of
`fp2_aqara_fw1.bin`: `boot_init_main @ 0x400de62c`, `radar_ready_init_state @
0x400e6350`, and `after_radar_ready_poll @ 0x400e62b0` only issue lazy READs
for 0x0102/0x0116/0x0128). The stock flow is purely event-driven —
ZCL attribute writes from the Aqara app are forwarded 1-to-1 via
`HandleCloud_Write_Dispatcher @ 0x400e3399`, never a startup blast.

Set **`emulate_stock: true`** in the YAML. The driver gates the init burst
behind `!(emulate_stock_ && sleep_mode_active_)`, so Zone and Fall modes still
receive the full init (they empirically need it and don't suffer the GTrack
issue), while Sleep Monitoring skips the burst and keeps whatever config is
in the radar's flash from the previous WORK_MODE save.

**Correct usage:**

1. YAML: `emulate_stock: true` under `aqara_fp2:`. Re-flash if not already set.
2. Get out of bed (no stale track already active in the bed region)
3. Set `operating_mode` → `Zone Detection`, wait ~15 s
4. Set `operating_mode` → `Sleep Monitoring`. The WORK_MODE=9 WRITE triggers
   a flash-save of the current RAM config and reboots the radar into FW3.
   Wait ~15 s for `radar_state` to settle on `Sleep`
5. **Approach the bed and climb in with noticeable motion** (walking toward
   the bed, rolling, shifting). The motion generates CFAR points with
   |velocity| > 0.1 m/s — enough to cross GTrack's allocation gate within
   the first 2-3 seconds of detection
6. Lie still once in position. The allocated track is maintained through the
   `static2free` / `sleep2free` timers

Within ~6-12 s of a track being allocated, `0x0159` frames arrive and
`heart_rate` / `respiration_rate` start publishing. `heart_rate_deviation`
becomes available after 2+ HR samples (~12 s) and stabilises over the full
10-sample rolling window (~60 s).

**Why this differs from Zone Detection**: FW1 uses a simpler peak-detection
pipeline without the GTrack allocation velocity gate. It tracks a stationary
target as soon as CFAR finds a peak, which is why Zone Detection "just works"
in the same setup where Sleep Monitoring silently fails.

### Operating Mode state persistence

The last-selected `operating_mode` is saved to ESP32 NVS flash and restored on
boot — but the radar's `scene_mode` is independently saved to radar flash, so
the two can get out of sync (e.g., after a stock-firmware reflash). When they
disagree at boot, the driver does not force-resend `WORK_MODE`. To resync,
simply cycle the select entity to a different value then back.

## Radar Firmware OTA (EXPERIMENTAL)

> **WARNING: This feature is untested and experimental. Incorrect use could
> brick the radar module, requiring physical access to recover. Use at your
> own risk. Do not use unless you understand the implications.**

The component can update the TI IWR6843AOP radar's firmware via XMODEM-1K
over the existing UART connection. This is the same mechanism the stock
Aqara firmware uses to apply radar updates from the cloud.

### Prerequisites

- A valid TI IWR6843 firmware binary (must start with `MSTR` header)
- The firmware file must be extracted from a stock Aqara flash dump
  (offset 0x433000, typically ~2.4MB)
- **There is no way to read the radar's current firmware back** — XMODEM is
  one-way. Back up your stock flash dump before experimenting.

### How It Works

Two-step process for safety:

1. **Stage**: Downloads firmware from a URL to the ESP32's flash storage.
   Validates the MSTR header before writing. Does not touch the radar.
2. **Flash**: Reads staged firmware from ESP32 flash and transfers it to the
   radar via XMODEM-1K. The radar enters bootloader mode, receives the
   firmware, validates it, and restarts.

### Configuration

```yaml
aqara_fp2:
  # URL to a TI IWR6843 firmware binary (MSTR format)
  # Place the file in HA's /config/www/ folder and reference it here:
  radar_firmware_url: "http://homeassistant.local:8123/local/radar_firmware.bin"

  radar_fw_stage:
    name: "Stage Radar Firmware"   # Downloads URL → ESP32 flash
  radar_ota:
    name: "Flash Radar Firmware"   # Transfers flash → radar via XMODEM
```

### Safety Checks

- Firmware must have valid `MSTR` magic header (TI format)
- Minimum size 1KB, maximum 4MB
- Flash is verified after write
- The OTA button refuses to proceed without valid staged firmware
- During XMODEM transfer, do **not** power off the device

### Extracting Firmware from Stock Dump

```python
# Extract radar firmware from a full flash dump
with open('stock_flash.bin', 'rb') as f:
    f.seek(0x433000)
    data = f.read(4 * 1024 * 1024)

# Trim trailing 0xFF (erased flash)
size = len(data)
while size > 0 and data[size-1] == 0xFF:
    size -= 1

with open('radar_firmware.bin', 'wb') as f:
    f.write(data[:size])
```

### Known Limitations

- **Untested** — the XMODEM transfer has been implemented from reverse
  engineering but has not been validated on real hardware
- **No firmware source** — Aqara distributes radar firmware via their cloud
  only. The only known source is extracting from a stock flash dump.
- **No rollback** — if the transfer fails partway, the radar may be in an
  indeterminate state. A power cycle should recover it to the previous
  firmware (the radar validates before applying), but this is unconfirmed.
- **No version check** — the component does not verify whether the firmware
  is newer or compatible with the current radar hardware revision.

## OPT3001 Light Sensor

The OPT3001 ambient light sensor shares the I2C bus with the accelerometer:

- **Address**: 0x44
- **Mode**: Continuous conversion, 800ms, automatic full-scale range
- **Config register**: 0xCE10
- **Read rate**: Every ~1 second (10th cycle of the 100ms accel task)
- **Publish**: From the ESPHome main loop (thread-safe via mutex). Only publishes
  on >5% change to avoid flooding HA.
- **Bus contention**: 5ms yield between accel and OPT3001 reads. Automatic
  `i2c_master_bus_reset()` on timeout/invalid-state errors.
- **Optical cross-talk with status LED**: The OPT3001 and the device's
  indicator LED share the same front optical window. When the LED is on,
  the sensor reads artificially higher lux — most visible in a dark room,
  where the LED can dominate the reading. Stock firmware modulates the LED
  brightness against ambient lux to reduce this; the ESPHome driver does
  not. If you need clean ambient readings, turn the `Status LED` entity
  off (or use an automation to disable it during measurement windows).

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
  light_sensor:
    name: "Ambient Light"

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

### Full Config with All Features

```yaml
aqara_fp2_accel:
  id: fp2_accel
  light_sensor:
    name: "Ambient Light"

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
  fall_detection:
    name: "Fall Detected"

  # Sleep monitoring
  sleep_state:
    name: "Sleep State"
  sleep_presence:
    name: "Sleep Presence"
  heart_rate:
    name: "Heart Rate"
  respiration_rate:
    name: "Respiration Rate"
  heart_rate_deviation:
    name: "Heart Rate Deviation"

  # Target tracking
  target_tracking:
    name: "Targets"
  location_report_switch:
    name: "Report Targets"

  # Auto-calibration buttons
  calibrate_edge:
    name: "Calibrate Room Boundaries"
  calibrate_interference:
    name: "Calibrate Interference"

  # Radar firmware OTA (EXPERIMENTAL — see docs)
  # radar_firmware_url: "http://homeassistant.local:8123/local/radar_firmware.bin"
  # radar_fw_stage:
  #   name: "Stage Radar Firmware"
  # radar_ota:
  #   name: "Flash Radar Firmware"

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
      posture:
        name: "Bed Posture"
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
- **Accelerometer**: da218B at address 0x27
- **Light sensor**: OPT3001 at address 0x44 (same bus)
- **Sample rate**: 10 samples averaged, configurable interval (default 100ms)
- **Outputs**: Orientation enum (UP, DOWN, SIDE, etc.), tilt angle, vibration
  state, ambient light (lux)
- **Thread safety**: All public accessors use FreeRTOS mutexes. Sensor publish
  happens from the main loop, not the task.

The radar periodically queries the ESP32 for orientation and angle data via
reverse-read requests (SubIDs 0x0143, 0x0120). The accelerometer component
provides these values.
