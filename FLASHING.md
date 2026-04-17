# Flashing ESPHome on the Aqara FP2

> **This guide replaces the stock Aqara firmware with ESPHome.** After the initial
> serial flash, all subsequent updates happen over Wi-Fi. You'll need physical
> access to the device **once** — to solder test-point connections for serial.

See the official ESPHome flashing guide for general tooling:
<https://esphome.io/guides/physical_device_connection/>

---

## 1. Choose your partition layout

The FP2's ESP32-SOLO1 module has **16 MB of physical flash**. ESPHome's default
build only uses 4 MB, leaving 12 MB unused. You have two options:

### Option A — Default 4 MB layout *(simpler)*
- All ESPHome features work (zones, sleep, fall detection via FW1, etc.)
- **Radar firmware OTA is disabled** — no `mcu_ota` partition to stage into
- You can still switch radar scene modes within the currently loaded FW1
- Upgrade to Option B later via another serial flash (not OTA)

### Option B — 16 MB layout with `mcu_ota` partition *(recommended)*
- All Option A features, **plus** radar firmware OTA
- 4 MB `mcu_ota` partition at offset `0x433000` (matches stock Aqara exactly)
- Required to flash different radar firmware images (FW2 for fall detection, FW3 for vital signs)
- One-time initial serial flash; all updates thereafter are OTA

**The rest of this guide assumes Option B.** For Option A, skip the
"Add the partition table" step and omit `flash_size` / `partitions` from your YAML.

---

## 2. Back up stock firmware

**Do this before flashing anything else.** The stock flash contains per-unit
calibration data (accelerometer, OPT3001 light sensor, radar) **and the three
radar firmware images** — none of it can be recovered if lost.

```bash
pip install esptool
esptool --chip esp32 --port /dev/ttyUSB0 \
    read_flash 0x0 0x1000000 aqara_fp2_<serial>.bin
```

Note: rename the output file with the unit's serial number (from the QR code on
the device) — calibration is per-unit.

### Extract the radar firmware from your backup

The stock flash contains an `mcu_ota` data partition (4 MB at `0x433000`) that
holds the three TI IWR6843 MSTR container images needed for radar OTA. A
Python script is included to pull this out:

```bash
python scripts/extract_radar_firmware.py aqara_fp2_<serial>.bin
# → writes radar_firmware.bin (~2.4 MB) next to the input
```

The script parses the partition table, locates `mcu_ota`, trims trailing `0xFF`
padding, and verifies all three MSTR headers (FW1/FW2/FW3). See
[scripts/README.md](scripts/README.md) for full details.

Keep the resulting `radar_firmware.bin` somewhere safe — you'll host it over
HTTP and point your YAML's `radar_firmware_url` at it. See §Staging radar
firmware below.

## 3. Disassemble the device

1. Remove the 4 rubber plugs on the rear and unscrew the 4 screws.
2. Firmly pull the front and rear of the device apart — the rear panel unplugs from the USB daughterboard.

![back_screws.jpg](images/back_screws.jpg)

![flashing_connections.jpg](images/flashing_connections.jpg)

## 4. Connect to test points

You need: GND, 3V3 (or USB 5V via the daughterboard), TX, RX, EN (reset), GPIO0 (boot mode).

![wires_connected.jpg](images/wires_connected.jpg)

- Prop the PCB up with a toothpick if you don't want to remove it fully from the case.
- If you do remove it, unplug the antenna first.
- Powering from the USB daughterboard is easier than soldering a 3V3 wire.

## 5. Add the partition table *(Option B only)*

Copy the canonical CSV from this repo into your ESPHome config directory:

```bash
cp components/aqara_fp2/partitions_fp2.csv /config/esphome/
```

Your YAML's `esp32:` block must then include:

```yaml
esp32:
  board: esp32-solo1
  flash_size: 16MB                    # <-- unlocks upper 12MB
  partitions: partitions_fp2.csv      # <-- custom layout with mcu_ota
  framework:
    type: esp-idf
    sdkconfig_options:
      CONFIG_FREERTOS_UNICORE: "y"
      CONFIG_ESP_SYSTEM_SINGLE_CORE_MODE: "y"
    advanced:
      ignore_efuse_mac_crc: true
      ignore_efuse_custom_mac: true
```

Layout (verified byte-for-byte against ESP-IDF's `gen_esp32part.py`):

| Partition | Offset      | Size     |
|-----------|-------------|----------|
| otadata   | `0x009000`  | 8 KB     |
| phy_init  | `0x00B000`  | 4 KB     |
| app0      | `0x010000`  | 1792 KB  |
| app1      | `0x1D0000`  | 1792 KB  |
| nvs       | `0x390000`  | 436 KB   |
| **mcu_ota** | **`0x433000`** | **4 MB** |

---

## 6. Compile and flash

1. In the ESPHome addon, **Install → Manual download** to build `firmware.factory.bin`.
   You'll find it at `.esphome/build/<name>/.pioenvs/<name>/firmware.factory.bin`.
2. Put the ESP32 into download mode:
   - Easiest: a USB-serial adapter (CP2102, FT232) with RTS→EN and DTR→GPIO0 auto-resets.
   - Otherwise: hold GPIO0 to GND and tap EN to reset.
3. Flash the factory image (bootloader + partition table + otadata + app, all-in-one):

```bash
esptool --chip esp32 --port /dev/ttyUSB0 --baud 460800 \
    erase_flash

esptool --chip esp32 --port /dev/ttyUSB0 --baud 460800 \
    write_flash --flash_mode dio --flash_size 16MB \
    0x0 firmware.factory.bin
```

> `--flash_mode dio` is correct for the FP2 module. `--flash_size 16MB` tells
> the ROM to accept images sized for 16 MB. These are required for Option B.

## 7. Reassemble

Desolder test-point wires, reconnect the USB daughterboard, put the PCB back
into the case (plastic clips), screw it shut, replug the antenna before the
rear panel goes on.

Device will boot, connect to Wi-Fi, and be adoptable in Home Assistant.

---

## Staging radar firmware *(Option B only)*

Once the device is running with the 16 MB layout, the `mcu_ota` partition is
empty. To enable radar OTA, stage the firmware once via the **Stage Radar
Firmware** button — this HTTPS-downloads the radar firmware blob and writes
it to `mcu_ota`.

You need an HTTP(S) URL for `radar_firmware.bin`. Two options:

**A. Use the copy you extracted from your own backup** *(recommended)*
```bash
python scripts/extract_radar_firmware.py aqara_fp2_<serial>.bin
# → radar_firmware.bin
# Upload to any static host (GitHub raw, nginx, HA /config/www/, etc.)
# and reference the URL in your YAML.
```
This is the safest path — you know the firmware matches your hardware revision exactly.

**B. Use the shipped copy** *(convenient but assumes Aqara revision compatibility)*
```
https://raw.githubusercontent.com/JameZUK/esphome_fp2_ng/main/backup/radar_firmware.bin
```

In your YAML:

```yaml
aqara_fp2:
  radar_firmware_url: <your URL from A or B above>
  radar_fw_stage:
    name: "Stage Radar Firmware"
  radar_ota:
    name: "Trigger Radar OTA"
  radar_ota_probe:
    name: "Radar OTA Probe (safe test)"   # recommended for first-time validation
```

### Recommended first-time validation

1. Press **Radar OTA Probe** — safe test, no flash writes. Confirms the radar
   bootloader accepts the XMODEM-1K handshake. Takes ~3 seconds.
2. Press **Stage Radar Firmware** — downloads 2.4 MB over HTTPS (~15–60 s
   depending on Wi-Fi). Writes to `mcu_ota`.
3. Press **Trigger Radar OTA** — flashes the staged firmware to the radar
   over UART XMODEM-1K. Takes ~3 minutes.

### What's in radar_firmware.bin

The shipped `backup/radar_firmware.bin` contains all three TI IWR6843 MSTR
container images, packed contiguously (byte-identical to the stock Aqara
`mcu_ota` partition extracted via `esptool read_flash 0x433000 0x400000`):

| Image | Offset      | Size    | MSTR version | Role |
|-------|-------------|---------|--------------|------|
| FW1   | `0x000000`  | 768 KB  | v1, 55 files | Zone Detection (default) |
| FW2   | `0x0C0000`  | 896 KB  | v1, 55 files | Fall Detection (DSP scoring) |
| FW3   | `0x1A0000`  | 708 KB  | v3, 55 files | Sleep Monitoring (vital signs) |

Total: 2,424,849 bytes, SHA256
`964d1fc24a78b1dcb1b8c18e3b4167ef475bb4b7cb87c68485909407ba31d2c2`.

When you trigger radar OTA, **the full 2.4 MB container is streamed** — the
radar's SBL handles the multi-image format internally. This matches the stock
Aqara app's behavior exactly.

---

## Recovery from a bricked device

If a partition table rewrite or bad flash leaves the device non-responsive:

### Quick recovery (restore default 4 MB PT only)
Preserves the current app + WiFi creds in NVS:
```bash
esptool --chip esp32 --port /dev/ttyUSB0 --baud 460800 \
    write_flash --flash_mode dio 0x8000 backup/pt_recovery_4mb.bin
```

### Full recovery (full ESPHome factory flash)
Wipes everything, reinstalls clean:
```bash
esptool --chip esp32 --port /dev/ttyUSB0 --baud 460800 erase_flash
esptool --chip esp32 --port /dev/ttyUSB0 --baud 460800 \
    write_flash --flash_mode dio --flash_size 16MB \
    0x0 firmware.factory.bin
```

### Total restore to stock Aqara firmware
If you want to revert to the original firmware entirely (loses ESPHome):
```bash
esptool --chip esp32 --port /dev/ttyUSB0 --baud 460800 \
    write_flash --flash_mode dio --flash_size 16MB \
    0x0 aqara_fp2_<serial>.bin
```
