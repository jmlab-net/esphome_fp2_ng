# Changelog (esphome_fp2_ng)

Changes from the upstream [hansihe/esphome_fp2](https://github.com/hansihe/esphome_fp2).

## 2026-04-11 — Initial Fork

### Bug Fixes

- **Switch fall-through in `handle_report_()`**: Every case in the report
  handler's switch statement used a pattern where `break` was inside an `if`
  block. If the payload size check failed, execution fell through to the next
  case, causing malformed packets to be misinterpreted as different report types.
  Fixed by moving `break` outside the `if` blocks for all affected cases:
  `RADAR_SW_VERSION`, `WORK_MODE`, `DETECT_ZONE_MOTION`, `MOTION_DETECT`,
  `PRESENCE_DETECT`, `ZONE_PRESENCE`.

- **Null pointer dereferences**: `global_motion_sensor_` and
  `global_presence_sensor_` were dereferenced without null checks in
  `handle_report_()`. If `global_zone` was configured without `motion` or
  `presence` sensors, these would crash. Added null checks.

- **PI constant typo**: `aqara_fp2_accel.h` defined PI as `3.141614159265`
  (extra "61" inserted). Corrected to `3.14159265358979`.

- **Dead accelerometer calibration**: `calculate_calibration()` computed
  correction values then immediately zeroed them out and returned, with the
  actual return/log statements unreachable. Removed the zeroing-out code to
  restore the intended behaviour.

- **ESP-IDF 5.5+ compilation error** (upstream issue #2): Migrated from the
  removed `driver/i2c.h` legacy API to `driver/i2c_master.h`. Used
  `i2c_master_transmit_receive()` for register reads (not `i2c_master_receive()`
  which would skip the register address write — a bug in the community-proposed
  fix).

- **Wall mounting mode card** (upstream issue #3): The Lovelace card had a
  placeholder coordinate conversion for wall mode (`target.x * 0.01`). The raw
  coordinate space is identical for all mounting positions, so applied the same
  proven conversion formula used for corner modes.

### New Features

- **Global people count sensor**: The `ONTIME_PEOPLE_NUMBER` report (SubID
  0x0165) was received and logged but never exposed as an entity. Added a
  `people_count` sensor option.

- **Per-zone people count sensors** (upstream issue #1): Added `zone_people_count`
  sensor option per zone. Works by cross-referencing target positions from the
  location tracking data (SubID 0x0117) against each zone's grid bitmap.
  Location reporting is automatically enabled when any zone has this sensor
  configured.

### Re-enabled

- **Zone motion handler**: The zone motion publish logic in `DETECT_ZONE_MOTION`
  was commented out, so per-zone motion binary sensors never updated. Uncommented.

### Cleanup

- Removed commented-out `add_zone()` dead code
- Removed remaining unreachable code in accelerometer calibration
