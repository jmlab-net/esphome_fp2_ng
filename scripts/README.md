# Scripts

Utility scripts for the esphome_fp2_ng project.

## `extract_radar_firmware.py`

Extracts the radar firmware blob from a full 16 MB Aqara FP2 flash backup.

### When to use this

If you've flashed ESPHome on your FP2 and kept a backup of the stock flash
(as recommended in [FLASHING.md](../FLASHING.md)), this script pulls the
radar firmware out of your backup so you can:

1. Host it somewhere reachable by the device (GitHub raw, HTTP server, etc.)
2. Set `radar_firmware_url` in your ESPHome YAML
3. Stage it to the `mcu_ota` partition via the **Stage Radar Firmware** button
4. Flash it to the radar via XMODEM-1K by pressing **Trigger Radar OTA**

This way you never need to trust a pre-shipped binary — the radar firmware you
deploy is extracted from your own device's factory image.

### Quick usage

```bash
# Extract (writes radar_firmware.bin next to input)
python scripts/extract_radar_firmware.py aqara_fp2_<serial>.bin

# Verify only (no output file)
python scripts/extract_radar_firmware.py aqara_fp2_<serial>.bin --verify-only

# Custom output path
python scripts/extract_radar_firmware.py aqara_fp2_<serial>.bin -o my_radar.bin

# Just print the partition table (debugging unknown backups)
python scripts/extract_radar_firmware.py aqara_fp2_<serial>.bin --list-partitions
```

No dependencies beyond the Python 3.9+ standard library.

### What it does

1. **Parses the ESP-IDF partition table** at flash offset `0x8000`
2. **Verifies the partition table MD5 checksum**
3. **Locates the `mcu_ota` partition** (by label, falling back to subtype `0xFE`)
4. **Extracts the partition contents** from the flash dump
5. **Trims trailing `0xFF` padding** to produce the minimum-size blob
6. **Validates the three TI MSTR container images** at their expected offsets:
   - FW1 (Zone Detection)      at `0x000000`
   - FW2 (Fall Detection)      at `0x0C0000`
   - FW3 (Sleep Monitoring)    at `0x1A0000`
7. **Writes `radar_firmware.bin`** with a per-image summary printed to stdout

Example output:
```
Partition table:
Label             Type  SubT       Offset         Size
------------------------------------------------------
nvs              0x01   0x02   0x00009000  0x00008000
otadata          0x01   0x00   0x00011000  0x00002000
phy_init         0x01   0x01   0x00013000  0x00001000
aqara_fw1        0x00   0x10   0x00020000  0x00200000
aqara_fw2        0x00   0x11   0x00220000  0x00200000
test             0x00   0x20   0x00420000  0x00013000
mcu_ota          0x01   0xfe   0x00433000  0x00400000
fctry            0x01   0x02   0x00833000  0x00006000

Selected partition: mcu_ota (offset=0x433000, size=0x400000)

Radar firmware images:
FW1 (Zone Detection)         0x000000  v1  55 files  727e2aad200b7adb...
FW2 (Fall Detection)         0x0c0000  v1  55 files  a73c869a1d69f896...
FW3 (Sleep/Vital Signs)      0x1a0000  v3  55 files  b9d488ce7b485e95...

Extracted radar blob: 2,424,849 bytes
SHA256:               964d1fc24a78b1dcb1b8c18e3b4167ef475bb4b7cb87c68485909407ba31d2c2

Wrote radar_firmware.bin  (2,424,849 bytes)
```

### Error handling

Exit codes:

| Code | Meaning                                                           |
|------|-------------------------------------------------------------------|
| 0    | Success (or verify OK)                                            |
| 1    | Input file problem — missing, truncated, not a flash dump        |
| 2    | Partition table problem — bad magic, MD5 mismatch, no mcu_ota    |
| 3    | MSTR image validation problem — expected image missing or bad    |

Common error messages and what they mean:

- **"file too small for a flash dump"** — you dumped less than 36 KB. Re-run
  esptool's `read_flash` with the full `0x0 0x1000000` range.
- **"partition table MD5 mismatch"** — either the backup is corrupted (re-dump)
  or the file isn't an ESP32 flash image at all.
- **"no 'mcu_ota' partition found"** — the backup is probably from an older
  Aqara firmware (pre-mcu_ota) or from an ESPHome build with the default 4 MB
  layout. Only stock Aqara backups contain the radar firmware.
- **"mcu_ota partition ends at 0x... but file is only ..."** — your backup was
  truncated. Re-dump the full 16 MB.
- **"expected MSTR magic at 0x... got ..."** — the `mcu_ota` partition exists
  but doesn't contain the expected radar firmware layout. May indicate a
  failed stock OTA or a very different firmware version.

## `test_extract_radar_firmware.py`

Comprehensive test suite for the extractor. 26 tests covering:

- Partition table parsing (happy path, stock Aqara layout, bad magic, MD5 mismatch, missing terminator)
- `mcu_ota` discovery (by label, fallback to subtype, ambiguity, missing)
- Trailing `0xFF` trimming edge cases
- MSTR image validation (all present, FW2 missing, too-short blob)
- End-to-end extraction against synthetic flash dumps
- CLI interface (help, missing file, verify-only, full extraction, partition listing)
- **Byte-for-byte match against the real stock 16 MB backup** (if present in `backup/`)

Run:
```bash
python scripts/test_extract_radar_firmware.py
```

Expected output:
```
Ran 26 tests in ~1s
OK
```
