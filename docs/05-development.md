# Development Guide

## Project Structure

```
esphome_fp2_ng/
├── components/
│   ├── aqara_fp2/
│   │   ├── __init__.py           # ESPHome config schema and codegen
│   │   ├── fp2_component.h       # C++ header (types, enums, class)
│   │   └── fp2_component.cpp     # C++ implementation (protocol, handlers)
│   └── aqara_fp2_accel/
│       ├── __init__.py           # Accelerometer config schema
│       ├── aqara_fp2_accel.h     # Accelerometer header
│       └── aqara_fp2_accel.cpp   # I2C driver, orientation, vibration
├── card.js                       # HA Lovelace card (target visualization)
├── fp2-card-test.html            # Browser test harness for card
├── docs/                         # This documentation
├── example_config.yaml           # Reference ESPHome configuration
├── FLASHING.md                   # Hardware flashing guide
├── hacs.json                     # HACS frontend integration metadata
└── images/                       # Flashing guide photos
```

## Building and Flashing

### Local Development

1. Clone the repository alongside your ESPHome config
2. Reference the components locally:
   ```yaml
   external_components:
     - source:
         type: local
         path: /path/to/esphome_fp2_ng/components
   ```
3. Compile: `esphome compile your_config.yaml`
4. Flash: `esphome upload your_config.yaml`

### From GitHub

```yaml
external_components:
  - source: github://JameZUK/esphome_fp2_ng@main
    refresh: 120s
    components: [ aqara_fp2, aqara_fp2_accel ]
```

## Adding New Attributes

When a new radar attribute is discovered or needs to be supported:

### 1. Define the Attribute ID

In `fp2_component.h`, add to the `AttrId` enum:

```cpp
enum class AttrId : uint16_t {
    // ...
    NEW_ATTRIBUTE = 0x0XXX,
};
```

### 2. Handle in Report Switch

In `fp2_component.cpp`, add a case to `handle_report_()`:

```cpp
case AttrId::NEW_ATTRIBUTE:
    if (payload.size() == expected_size && payload[2] == expected_type) {
        // Parse and process
        // Publish to sensor if applicable
    }
    break;  // IMPORTANT: always break unconditionally after the if block
```

**Critical**: The `break` must be outside and after the `if` block, not inside
it. Placing `break` inside the `if` causes fall-through to the next case when
the payload size check fails. This was a bug in the original code.

### 3. Add Sensor (if exposing to HA)

In `fp2_component.h`:
```cpp
// Add member
sensor::Sensor *new_sensor_{nullptr};

// Add setter
void set_new_sensor(sensor::Sensor *sensor) { new_sensor_ = sensor; }
```

In `__init__.py`:
```python
# Add config constant
CONF_NEW_SENSOR = "new_sensor"

# Add to CONFIG_SCHEMA
cv.Optional(CONF_NEW_SENSOR): sensor.sensor_schema(
    accuracy_decimals=0,
    state_class=STATE_CLASS_MEASUREMENT,
),

# Add to SENSOR_MAP
CONF_NEW_SENSOR: (sensor.new_sensor, "set_new_sensor"),
```

### 4. Send During Init (if configuration attribute)

In `check_initialization_()`:
```cpp
enqueue_command_(OpCode::WRITE, AttrId::NEW_ATTRIBUTE, (uint8_t) value);
```

## Key Implementation Patterns

### Null-Check Before Publish

Always check sensor pointers before publishing:
```cpp
if (some_sensor_ != nullptr) {
    some_sensor_->publish_state(value);
}
```

### Command Queue

Use the typed `enqueue_command_` overloads:
```cpp
enqueue_command_(OpCode::WRITE, attr_id, (uint8_t) val);   // UINT8
enqueue_command_(OpCode::WRITE, attr_id, (uint16_t) val);  // UINT16
enqueue_command_(OpCode::WRITE, attr_id, true);             // BOOL
enqueue_command_blob2_(attr_id, blob_data);                  // BLOB2
```

### Grid Bitmap Operations

Check if a coordinate falls within a grid:
```cpp
int col = ...;  // 0-15
int row = ...;  // 0-19
uint16_t row_val = (grid[row * 2] << 8) | grid[row * 2 + 1];
bool active = (row_val & (1 << (15 - col))) != 0;
```

## Known Limitations and Future Work

### Not Yet Implemented

- **Fall detection events**: Sensitivity is configurable but fall events are not
  processed or exposed as entities
- **Sleep zone**: `SLEEP_MOUNT_POSITION` and `SLEEP_ZONE_SIZE` attributes are
  defined but unused
- **Dwell time / walking distance**: Attributes defined, explicitly disabled
  during init
- **Radar firmware update**: No OTA mechanism for the IWR6843AOP firmware
- **Light sensor**: Hardware exists (3 analog pins) but sensor IC and protocol
  are unknown
- **Accelerometer calibration**: `calculate_calibration()` computes corrections
  but the function is never called from the main loop. A calibration trigger
  mechanism is needed.

### Architecture Considerations

- **Frame decoder timeout**: The UART state machine has no timeout for partial
  frames. If bytes arrive partially for a frame and then stop, the decoder
  remains in a non-SYNC state until the next 0x55 byte. Consider adding a
  timeout that resets to SYNC after ~100ms of inactivity.

- **Location tracking rate**: Target data arrives at 10-20 Hz. Publishing
  per-zone counts at this rate may be excessive for HA. Consider adding a
  configurable throttle or only publishing on change.

- **Zone people count and location reporting**: When `zone_people_count` is
  configured, location reporting is auto-enabled and cannot be disabled via the
  switch. This is intentional — the count depends on tracking data — but should
  be documented clearly to users.

## UART Sniffing (for Protocol Research)

To capture the raw UART traffic between ESP32 and radar without modifying
firmware:

1. Tap GPIO18 (TX) and GPIO19 (RX) with a logic analyzer or second UART adapter
2. Baud rate: 890,000
3. Decode using the frame format documented in
   [02-uart-protocol.md](02-uart-protocol.md)
4. The [AqaraPresenceSensorFP2ReverseEngineering](https://github.com/hansihe/AqaraPresenceSensorFP2ReverseEngineering)
   repository contains Python decoding scripts and a `sniff_uart_bidir.py` tool
   for Glasgow Interface Explorer hardware

## References

- [Original esphome_fp2](https://github.com/hansihe/esphome_fp2) — upstream project
- [AqaraPresenceSensorFP2ReverseEngineering](https://github.com/hansihe/AqaraPresenceSensorFP2ReverseEngineering) — protocol RE, board schematic, GPIO mapping
- [AqaraPresenceSensorFP2](https://github.com/niceboygithub/AqaraPresenceSensorFP2) — hardware details, esptool commands
- [ha-aqara-devices](https://github.com/Darkdragon14/ha-aqara-devices) — cloud API integration (alternative approach)
- [fp2-proxy](https://github.com/ebaauw/fp2-proxy) — HAP proxy to deCONZ (binary occupancy only)
- [TI IWR6843AOP Datasheet](https://www.ti.com/product/IWR6843AOP) — radar chip documentation
- [ESPHome External Components](https://esphome.io/components/external_components.html) — ESPHome docs
