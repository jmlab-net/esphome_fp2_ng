#!/usr/bin/env python3
"""
Extract the radar firmware blob from an Aqara FP2 stock flash backup.

The FP2's ESP32 flash (16 MB) contains a `mcu_ota` data partition that holds
three TI IWR6843 MSTR container images (FW1/FW2/FW3). This script reads the
partition table at offset 0x8000, locates mcu_ota by subtype, extracts its
content, trims trailing 0xFF padding, and validates the three MSTR images.

The output is a `radar_firmware.bin` file that can be:
- flashed to the device's `mcu_ota` partition via the Stage Radar Firmware
  button (HTTP download) or esptool
- streamed to the radar over XMODEM-1K via the Trigger Radar OTA button

Usage:
    # Extract with auto-detected output name
    python extract_radar_firmware.py aqara_fp2_52322103.bin

    # Custom output
    python extract_radar_firmware.py aqara_fp2_52322103.bin -o my_radar.bin

    # Validate only (no output file written)
    python extract_radar_firmware.py aqara_fp2_52322103.bin --verify-only

    # Print partition table
    python extract_radar_firmware.py aqara_fp2_52322103.bin --list-partitions

Exit codes:
    0 — success (or verify OK)
    1 — input file problem (missing, too small, not a flash dump)
    2 — partition table problem (bad MD5, missing mcu_ota, etc.)
    3 — MSTR image validation problem (missing FW1/FW2/FW3, wrong magic)
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

# ESP-IDF partition table format constants
PT_OFFSET = 0x8000
PT_SECTOR_SIZE = 0x1000
ENTRY_SIZE = 32
MAGIC_ENTRY = 0x50AA          # 0xAA 0x50 LE
MAGIC_MD5 = 0xEBEB            # 0xEB 0xEB LE
MCU_OTA_SUBTYPE = 0xFE

# Expected MSTR image layout within the mcu_ota blob (stock Aqara)
EXPECTED_IMAGES = [
    ("FW1 (Zone Detection)",     0x000000, "Wall/multi-person, default"),
    ("FW2 (Fall Detection)",     0x0C0000, "Ceiling, DSP scoring, height"),
    ("FW3 (Sleep/Vital Signs)",  0x1A0000, "Bedside, heart rate + respiration"),
]
MIN_RADAR_FW_SIZE = 0x1A4000       # at least first 2 MSTR images + some of FW3


@dataclass
class Partition:
    """A single partition table entry."""
    label: str
    type: int
    subtype: int
    offset: int
    size: int
    flags: int

    @property
    def end(self) -> int:
        return self.offset + self.size


@dataclass
class MSTRImage:
    """Metadata for a single TI MSTR container image."""
    name: str
    offset: int         # offset within the radar firmware blob
    version: int
    num_files: int
    sha256: str


class ExtractError(Exception):
    """Recoverable error during extraction; carries an exit code."""
    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


# --- Partition table parsing ------------------------------------------------

def parse_partition_table(flash: bytes) -> list[Partition]:
    """Parse the ESP-IDF partition table at flash[0x8000:0x9000].

    Returns the ordered list of partitions up to (but not including) the MD5
    marker entry. Raises ExtractError if the table is malformed or the MD5
    checksum doesn't match.
    """
    if len(flash) < PT_OFFSET + PT_SECTOR_SIZE:
        raise ExtractError(
            f"file too small for a flash dump ({len(flash)} bytes); "
            "expected at least 0x9000 bytes to reach the partition table",
            exit_code=1,
        )

    pt_data = flash[PT_OFFSET:PT_OFFSET + PT_SECTOR_SIZE]
    partitions: list[Partition] = []
    entries_bytes = b""

    for i in range(0, PT_SECTOR_SIZE, ENTRY_SIZE):
        entry = pt_data[i:i + ENTRY_SIZE]
        magic = struct.unpack("<H", entry[:2])[0]

        if magic == MAGIC_ENTRY:
            ptype, subtype = entry[2], entry[3]
            offset, size = struct.unpack("<II", entry[4:12])
            label = entry[12:28].rstrip(b"\x00").decode("ascii", errors="replace")
            flags = struct.unpack("<I", entry[28:32])[0]
            partitions.append(Partition(label, ptype, subtype, offset, size, flags))
            entries_bytes += entry

        elif magic == MAGIC_MD5:
            # MD5 marker: 16 bytes header (magic + 14 * 0xFF) + 16 bytes MD5
            stored_md5 = entry[16:32]
            calculated = hashlib.md5(entries_bytes).digest()
            if stored_md5 != calculated:
                raise ExtractError(
                    f"partition table MD5 mismatch "
                    f"(stored={stored_md5.hex()}, calc={calculated.hex()}). "
                    "Input may be corrupted or not a valid ESP32 flash dump.",
                    exit_code=2,
                )
            return partitions

        elif entry == b"\xFF" * ENTRY_SIZE:
            # End of table marker
            return partitions

        else:
            raise ExtractError(
                f"unknown partition entry magic 0x{magic:04x} at PT offset 0x{i:03x}. "
                "Input is probably not a valid ESP32 flash dump.",
                exit_code=2,
            )

    return partitions


def find_mcu_ota(partitions: list[Partition]) -> Partition:
    """Locate the mcu_ota partition by label or subtype."""
    # First try by name (canonical for stock Aqara firmware)
    for p in partitions:
        if p.label == "mcu_ota":
            return p

    # Fallback: search by subtype 0xFE (custom data partition used by Aqara)
    candidates = [p for p in partitions if p.type == 0x01 and p.subtype == MCU_OTA_SUBTYPE]
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        raise ExtractError(
            f"found {len(candidates)} partitions with subtype 0xFE — cannot "
            "disambiguate without a 'mcu_ota' label",
            exit_code=2,
        )

    raise ExtractError(
        "no 'mcu_ota' partition found in the flash dump. "
        "This file may be from an older FP2 firmware, a different device, "
        "or an ESPHome build without the custom 16 MB layout. "
        "Use --list-partitions to see what was detected.",
        exit_code=2,
    )


# --- Radar firmware extraction ----------------------------------------------

def trim_trailing_ff(data: bytes) -> bytes:
    """Strip trailing 0xFF padding so the output is the minimum meaningful size."""
    last = len(data) - 1
    while last >= 0 and data[last] == 0xFF:
        last -= 1
    return data[:last + 1]


def validate_mstr_images(blob: bytes, strict: bool = True) -> list[MSTRImage]:
    """Verify the three TI MSTR images at their expected offsets.

    Returns the list of detected images. If strict=True, raises ExtractError
    on the first missing/malformed image. If strict=False, returns only the
    images that were successfully detected.
    """
    images: list[MSTRImage] = []
    for name, off, _desc in EXPECTED_IMAGES:
        if off + 12 > len(blob):
            if strict:
                raise ExtractError(
                    f"radar blob too short to contain {name} at 0x{off:06x} "
                    f"(only {len(blob)} bytes)",
                    exit_code=3,
                )
            continue

        magic = blob[off:off + 4]
        if magic != b"MSTR":
            if strict:
                raise ExtractError(
                    f"expected MSTR magic at 0x{off:06x} for {name}, got {magic.hex()}. "
                    "Radar firmware blob does not match the known Aqara layout.",
                    exit_code=3,
                )
            continue

        version = struct.unpack("<I", blob[off + 4:off + 8])[0]
        num_files = struct.unpack("<I", blob[off + 8:off + 12])[0]
        # Compute per-image SHA256 over the expected region
        # (until next image offset, or end of blob for FW3)
        if off == 0x1A0000:
            img_end = len(blob)
        else:
            img_end = next(
                nxt_off for _nxt_name, nxt_off, _ in EXPECTED_IMAGES if nxt_off > off
            )
        sha = hashlib.sha256(blob[off:img_end]).hexdigest()
        images.append(MSTRImage(name=name, offset=off, version=version,
                                num_files=num_files, sha256=sha))

    return images


def extract_radar_firmware(flash_path: Path) -> tuple[bytes, list[Partition], Partition, list[MSTRImage]]:
    """Extract the radar firmware blob from an FP2 flash dump.

    Returns:
        (radar_blob, all_partitions, mcu_ota_partition, mstr_images)
    """
    data = flash_path.read_bytes()

    # ESP32 flash dumps should have the bootloader magic at offset 0x1000
    # (0xE9 start of image header). Warn if missing.
    if len(data) > 0x1000 and data[0x1000] != 0xE9:
        # Soft warning — some users may have sparse dumps
        print(
            f"warning: byte at 0x1000 is 0x{data[0x1000]:02x}, "
            "expected 0xE9 (ESP32 bootloader magic). File may not be a full flash dump.",
            file=sys.stderr,
        )

    partitions = parse_partition_table(data)
    if not partitions:
        raise ExtractError(
            "partition table at 0x8000 is empty. "
            "Input is probably not a valid ESP32 flash dump.",
            exit_code=2,
        )

    mcu_ota = find_mcu_ota(partitions)

    if mcu_ota.end > len(data):
        raise ExtractError(
            f"mcu_ota partition ends at 0x{mcu_ota.end:x} but file is only "
            f"{len(data)} bytes. Did you read the full 16 MB during backup?",
            exit_code=1,
        )

    raw_blob = data[mcu_ota.offset:mcu_ota.end]
    blob = trim_trailing_ff(raw_blob)
    images = validate_mstr_images(blob, strict=True)

    return blob, partitions, mcu_ota, images


# --- CLI --------------------------------------------------------------------

def format_partition_table(partitions: list[Partition]) -> str:
    rows = [f"{'Label':<16} {'Type':>5} {'SubT':>5} {'Offset':>12} {'Size':>12}"]
    rows.append("-" * len(rows[0]))
    for p in partitions:
        rows.append(
            f"{p.label:<16} 0x{p.type:02x}   0x{p.subtype:02x}   "
            f"0x{p.offset:08x}  0x{p.size:08x}"
        )
    return "\n".join(rows)


def format_images(images: list[MSTRImage]) -> str:
    rows = [f"{'Image':<28} {'Offset':>10} {'Version':>8} {'Files':>7} {'SHA256 (first 16 hex)':>24}"]
    rows.append("-" * len(rows[0]))
    for img in images:
        rows.append(
            f"{img.name:<28} 0x{img.offset:06x}  {img.version:>8}  {img.num_files:>7}   {img.sha256[:16]}..."
        )
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract radar firmware from an Aqara FP2 full flash backup.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Example:\n"
            "  python extract_radar_firmware.py aqara_fp2_52322103.bin\n"
            "  python extract_radar_firmware.py aqara_fp2_52322103.bin -o radar.bin\n"
            "  python extract_radar_firmware.py aqara_fp2_52322103.bin --verify-only\n"
        ),
    )
    parser.add_argument("input", type=Path, help="Full flash backup (.bin, typically 16 MB)")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="Output path (default: radar_firmware.bin next to input)")
    parser.add_argument("--verify-only", action="store_true",
                        help="Validate structure; do not write an output file")
    parser.add_argument("--list-partitions", action="store_true",
                        help="Print the full partition table and exit")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="Suppress progress output (errors still go to stderr)")
    args = parser.parse_args(argv)

    if not args.input.exists():
        print(f"error: {args.input} does not exist", file=sys.stderr)
        return 1

    def log(msg: str) -> None:
        if not args.quiet:
            print(msg)

    try:
        if args.list_partitions:
            data = args.input.read_bytes()
            partitions = parse_partition_table(data)
            print(format_partition_table(partitions))
            return 0

        log(f"Reading {args.input} ({args.input.stat().st_size:,} bytes)...")
        blob, partitions, mcu_ota, images = extract_radar_firmware(args.input)

        log("")
        log("Partition table:")
        log(format_partition_table(partitions))
        log("")
        log(f"Selected partition: {mcu_ota.label} "
            f"(offset=0x{mcu_ota.offset:06x}, size=0x{mcu_ota.size:x})")
        log("")
        log("Radar firmware images:")
        log(format_images(images))
        log("")

        sha = hashlib.sha256(blob).hexdigest()
        log(f"Extracted radar blob: {len(blob):,} bytes")
        log(f"SHA256:               {sha}")

        if args.verify_only:
            log("")
            log("Verification OK — no output written (--verify-only).")
            return 0

        out_path = args.output or args.input.with_name("radar_firmware.bin")
        out_path.write_bytes(blob)
        log("")
        log(f"Wrote {out_path}  ({len(blob):,} bytes)")
        log("")
        log("Next steps:")
        log("  - Host this file somewhere reachable by the FP2 over HTTP(S).")
        log("  - Add `radar_firmware_url:` to your aqara_fp2 YAML config.")
        log("  - Press Stage Radar Firmware in Home Assistant to load it into mcu_ota.")
        return 0

    except ExtractError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
