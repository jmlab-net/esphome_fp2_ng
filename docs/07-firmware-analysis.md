# Firmware Analysis Guide

## Overview

This guide covers reverse engineering the stock Aqara ESP32 firmware using
Ghidra with the MCP plugin for Claude-assisted analysis.

## Prerequisites

### Hardware
- Aqara FP2 with UART wires attached (TP8, TP9, TP28)
- USB-UART adapter (3.3V logic level)

### Software
- **Ghidra 12.0.3** — https://ghidra-sre.org (native Xtensa support)
- **Java 21 LTS** (OpenJDK)
- **ghidra-esp32-flash-loader** (dynacylabs) — **required** for proper import
- **ghidra-mcp** (bethington) — MCP server for Claude-assisted analysis
- **esptool** — `pip install esptool`
- **Xvfb + XFCE** (for headless servers) — Ghidra needs a display

## Step 1: Dump the Firmware

**Important**: Do this BEFORE flashing ESPHome. The stock firmware contains the
light sensor driver, radar OTA code, and all protocol handlers.

```bash
# Hold TP28 (GPIO0) LOW during power-on to enter download mode
esptool.py --baud 230400 --port /dev/ttyUSB0 read_flash 0x0 0x1000000 fp2_stock.bin

# Label with unit's HomeKit digits — flash contains unit-specific calibration
```

## Step 2: Load in Ghidra

### Install the ESP32 Flash Loader (Critical)

**Do not use the raw binary loader** — it does not create cross-references and
makes analysis nearly impossible. The flash loader correctly maps segments,
imports SVD peripherals, and resolves ROM symbols.

```bash
git clone https://github.com/dynacylabs/ghidra-esp32-flash-loader.git
cd ghidra-esp32-flash-loader
git checkout v12.0
GHIDRA_INSTALL_DIR=/path/to/ghidra gradle buildExtension
# Install: File → Install Extensions → select dist/*.zip → restart Ghidra
```

### Import the Firmware

1. `File → Import File` → select the **full flash dump** (not an extracted partition)
2. The flash loader auto-detects the ESP32 format and parses the partition table
3. Language: **Xtensa:LE:32:default**
4. Let auto-analysis run (~60 seconds, produces ~9,200 functions)

### Verify Proper Import

After import, you should see proper segments:
- `app_DROM0_3f400020` — flash-mapped read-only data (strings live here)
- `app_IRAM0_40080000` — fast IRAM code
- `app_IRAM0_400d0020` — flash-mapped code (main application)
- `.text` — ROM code
- Various `.bss_*` segments for BSS data

If you only see a single `ram:` segment, the flash loader didn't work.

## Step 3: Set Up Ghidra MCP

### Install bethington/ghidra-mcp

```bash
git clone https://github.com/bethington/ghidra-mcp.git
cd ghidra-mcp
./ghidra-mcp-setup.sh --deploy --ghidra-path /path/to/ghidra
pip install -r requirements.txt
```

### Enable and Start

1. In Ghidra: `File → Configure → Configure All Plugins → GhidraMCP` (check it)
2. `Tools → GhidraMCP → Start MCP Server`
3. The server binds to a Unix domain socket at
   `/run/user/1000/ghidra-mcp/ghidra-<pid>.sock`

### Configure Claude Code

```bash
claude mcp add ghidra-mcp /path/to/ghidra-mcp/.venv/bin/python /path/to/ghidra-mcp/bridge_mcp_ghidra.py
```

The bridge auto-discovers UDS sockets. All 193 tools become available.

### Headless Server Setup

For servers without a display:

```bash
# Install Xvfb and a desktop
sudo pacman -S xorg-server-xvfb xfce4 x11vnc

# Start virtual display + desktop + VNC
Xvfb :1 -screen 0 1920x1080x24 -nolisten tcp &
DISPLAY=:1 startxfce4 &
x11vnc -display :1 -forever -nopw -listen 0.0.0.0 &

# Launch Ghidra
DISPLAY=:1 /path/to/ghidraRun &
```

Connect via VNC to configure the plugin, then Claude Code connects via MCP.

## Step 4: Analysis Targets

### Completed: Light Sensor Driver

**Status: SOLVED** — TI OPT3001 at I2C address 0x44. Driver implemented.

Key findings from RE:
- Source: `apps/user/hal/acceleration_ambinent_light.c`
- `FUN_400e8d24` — OPT3001 init: writes config to register 1
- `FUN_400e8d5c` — da218B init: `0x0E` to reg `0x11`, `0x40` to reg `0x0F`
- `FUN_400e8f8c` — Calibration init: reads NVS coefficients (lux_low_k/b, etc.)
- `FUN_400e8d84` — Lux getter: reads structure offset +8
- Calibration: linear k/b coefficients per range, stored in NVS
- **OPT3001 config value**: `0xC610` (single-shot mode, 800ms, auto-range).
  Our ESPHome driver uses `0xCE10` (continuous mode). Aqara's single-shot
  approach saves power — sensor only converts when polled.

### Completed: Handler Function Name Table

**Status: SOLVED** — complete `radar_*` / `cloud_*` handler table extracted.

Extracted from DROM `3f409d00 - 3f40a6c0`. Maps every SubID to its local
handler (`radar_*`) and cloud relay handler (`cloud_*`). See
[02-uart-protocol.md](02-uart-protocol.md) for the full table.

Key discoveries:
- `radar_zone_people_number` — radar has **native per-zone counting** (SubID unknown)
- Cloud-only attributes found: bed height, overhead height, fall delay,
  blind zone, disturbance suppression
- OpCode dispatch table at `3f40a6cc` with 5 handler function pointers

### Completed: OpCode Dispatch Table

**Status: SOLVED** — all 5 opcode handlers identified.

Found at DROM `3f40a6cc`:
| OpCode | Handler Address |
|--------|----------------|
| 1 (RESPONSE) | `0x400DE904` |
| 2 (WRITE) | `0x400DE8F0` |
| 3 (ACK) | `0x400E1390` |
| 4 (READ) | `0x400DE8DC` |
| 5 (REPORT) | `0x400DE8C8` |

Note: Ghidra's auto-analysis did not create functions at these addresses.
Manual function creation in the GUI is needed before decompilation.

### Completed: Radar Firmware Version Table

Compatibility table at DROM `3f40a6f4`: versions `3.1.85` through `3.23.85+`.
The `.85` suffix is shared between ESP32 app (4.x.85) and radar (3.x.85)
firmware, likely a product variant identifier.

### Priority 1: Radar OTA (XMODEM)

**Status: MECHANISM UNDERSTOOD, implementation pending**

Key findings from RE:
- Source: `apps/user/ota/radar_ota.c` and `apps/user/ota/xmodem.c`
- `mcu_ota` partition: 4MB at offset 0x433000, sub_type 0xFE
- SubID `0x0127` (ota_set_flag) triggers radar bootloader mode
- Transfer uses XMODEM with retry, CAN, and timeout support
- Functions: `radar_ota_start`, `xmodem_new`, `xmodem_transfer`, `xmodem_end`
- String addresses in Ghidra: `3f40b229` (radar_ota.c), `3f40b30c` (start),
  `3f40b3c0` (xmodem functions)

**Next steps**: Decompile `radar_ota_start` to get the exact sequence — what
command puts the radar in bootloader mode, XMODEM parameters, completion signal.

### Priority 2: Unknown SubID Data Formats

Several SubIDs have unknown data types. The stock firmware handlers reveal them.

**Approach**: Find the main UART report dispatcher in the stock firmware
(equivalent to our `handle_report_()`). Each case/branch reveals the payload
parsing for that SubID.

| SubID | Name | What to find |
|-------|------|-------------|
| 0x0121 | FALL_DETECTION | Event structure, severity levels |
| 0x0154 | TARGET_POSTURE | Posture enum (standing/sitting/lying) |
| 0x0159 | SLEEP_DATA | Sleep tracking data format |
| 0x0161 | SLEEP_STATE | Sleep state enum (awake/light/deep?) |
| 0x0164 | REALTIME_PEOPLE | Difference from ONTIME (0x0165) — seen in logs |
| 0x0166 | REALTIME_COUNT | Also seen in logs as unhandled |
| 0x0174 | WALK_DISTANCE_ALL | Distance data format and units |

### Priority 3: NVS Lux Calibration

The stock firmware stores per-unit calibration coefficients in NVS:
- `lux_low_k`, `lux_low_b` — low range slope/intercept
- `lux_high_k`, `lux_high_b` — high range slope/intercept
- `lux_low_min`, `lux_low_max`, `lux_high_min`, `lux_high_max` — range bounds

The NVS partition has been extracted (`fp2_nvs.bin`). Reading these values and
applying the calibration would improve lux accuracy.

### Priority 4: 0x03xx Attribute Range

Commented-out code references three attributes in the 0x03xx range:
```cpp
// enqueue_read_((AttrId) 0x302); // Read radar flash ID
// enqueue_read_((AttrId) 0x303); // Read radar ID
// enqueue_read_((AttrId) 0x305); // Read radar calibration result
```

These appear to be radar system information attributes.

## Ghidra Analysis Tips

### Finding Functions by String Reference

Strings in the FP2 firmware live in `app_DROM0_3f400020`. To find the function
that uses a string:

1. `search_strings` to find the string address
2. `get_xrefs_to` on that address — returns the referencing function
3. `decompile_function` on the function address

### Byte Pattern Search for Strings

If `search_strings` doesn't find a string (e.g., not defined as a string type),
search for the raw bytes:

```
# "lux_low_k" = 6c 75 78 5f 6c 6f 77 5f 6b
search_byte_patterns pattern="6c 75 78 5f 6c 6f 77"
```

Then find references to that address using literal pool searches.

### Xtensa Literal Pools

Xtensa uses `l32r` instructions to load 32-bit values from a literal pool. The
literal pool entries appear as 4-byte little-endian addresses in memory, usually
just before the function that uses them. Search for the address bytes in
little-endian order:

```
# To find code referencing address 3f40b9d8:
search_byte_patterns pattern="d8 b9 40 3f"
```

## Reference Resources

### ESP32 Reverse Engineering

- [BlackVS/ESP32-reversing](https://github.com/BlackVS/ESP32-reversing) — curated resource list
- [wilco375/ESP-Firmware-Toolbox](https://github.com/wilco375/ESP-Firmware-Toolbox) — complete RE toolkit
- [Tarlogic FIDB guide](https://www.tarlogic.com/blog/esp32-firmware-using-ghidra-fidb/) — function identification

### Ghidra Extensions

| Extension | URL | Purpose |
|-----------|-----|---------|
| ghidra-esp32-flash-loader | [dynacylabs](https://github.com/dynacylabs/ghidra-esp32-flash-loader) | Load ESP32 flash dumps (required) |
| GhidraSVD | [antoniovazquezblanco](https://github.com/antoniovazquezblanco/GhidraSVD) | Import SVD peripheral maps |
| ESP32 SVD files | [espressif/svd](https://github.com/espressif/svd) | Official peripheral definitions |

### FP2-Specific RE

- [hansihe/AqaraPresenceSensorFP2ReverseEngineering](https://github.com/hansihe/AqaraPresenceSensorFP2ReverseEngineering) — UART protocol, board schematic, GPIO map
- [niceboygithub/AqaraPresenceSensorFP2](https://github.com/niceboygithub/AqaraPresenceSensorFP2) — hardware details, esptool commands

### MCP Server

- [bethington/ghidra-mcp](https://github.com/bethington/ghidra-mcp) — 193-tool MCP server for Claude-assisted Ghidra analysis
