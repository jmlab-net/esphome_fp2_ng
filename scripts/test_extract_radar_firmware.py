#!/usr/bin/env python3
"""
Comprehensive tests for extract_radar_firmware.py.

Covers:
- Happy path against the real stock 16 MB backup (if present)
- Synthetic flash dumps for edge cases:
    * file too small
    * garbage partition table (bad magic)
    * PT MD5 mismatch
    * PT present but no mcu_ota partition
    * mcu_ota partition present but blob has no MSTR images
    * mcu_ota with only FW1 (FW2/FW3 absent)
    * ambiguous layout (two 0xFE partitions)

Run:
    python scripts/test_extract_radar_firmware.py           # verbose
    python scripts/test_extract_radar_firmware.py -v quiet  # minimal
"""

from __future__ import annotations

import hashlib
import io
import struct
import subprocess
import sys
import tempfile
import traceback
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

# Make the script importable (scripts directory is not a package)
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import extract_radar_firmware as erf  # noqa: E402

STOCK_BACKUP = REPO_ROOT / "backup" / "aqara_fp2_homekit-52322103_ALL.bin"
RADAR_FW_CANONICAL = REPO_ROOT / "backup" / "radar_firmware.bin"


# --- Synthetic flash-dump helpers -------------------------------------------

def build_partition_entry(label: str, ptype: int, subtype: int,
                          offset: int, size: int) -> bytes:
    """Build a single 32-byte partition table entry."""
    return struct.pack(
        "<HBBII16sI",
        erf.MAGIC_ENTRY, ptype, subtype, offset, size,
        label.encode().ljust(16, b"\x00"), 0,
    )


def build_partition_table(entries: list[bytes], include_md5: bool = True) -> bytes:
    """Assemble a full 4 KB partition table sector with optional MD5 marker."""
    payload = b"".join(entries)
    if include_md5:
        md5 = hashlib.md5(payload).digest()
        payload += b"\xeb\xeb" + b"\xff" * 14 + md5
    return payload.ljust(erf.PT_SECTOR_SIZE, b"\xff")


def build_mstr_header(version: int = 1, num_files: int = 55) -> bytes:
    """Minimal TI MSTR container header (12 bytes)."""
    return b"MSTR" + struct.pack("<II", version, num_files)


def build_synthetic_flash(
    partitions: list[bytes],
    include_md5: bool = True,
    bootloader_magic_ok: bool = True,
    mcu_ota_offset: int | None = None,
    mcu_ota_size: int | None = None,
    mcu_ota_blob: bytes | None = None,
    total_size: int = 16 * 1024 * 1024,
) -> bytes:
    """Create a synthetic 16 MB flash dump for testing.

    Fills with 0xFF, stamps the bootloader magic at 0x1000, writes the PT at
    0x8000, and optionally places a radar blob at the mcu_ota location.
    """
    flash = bytearray(b"\xff" * total_size)
    if bootloader_magic_ok:
        flash[0x1000] = 0xE9
    pt = build_partition_table(partitions, include_md5=include_md5)
    flash[erf.PT_OFFSET:erf.PT_OFFSET + len(pt)] = pt
    if mcu_ota_offset is not None and mcu_ota_blob is not None:
        # Pad to mcu_ota_size with 0xFF tail
        target_size = mcu_ota_size if mcu_ota_size else len(mcu_ota_blob)
        chunk = mcu_ota_blob.ljust(target_size, b"\xff")
        flash[mcu_ota_offset:mcu_ota_offset + len(chunk)] = chunk
    return bytes(flash)


def build_canonical_radar_blob() -> bytes:
    """Build a minimum-viable radar blob with all 3 MSTR headers in place."""
    # Total: 2 MB. Enough to cover FW1/FW2/FW3 offsets with room for content.
    blob = bytearray(b"\xff" * 0x200000)
    # FW1 at 0x000000
    blob[0x000000:0x000000 + 12] = build_mstr_header(version=1, num_files=55)
    blob[0x000010:0x000020] = b"FW1-content-here"
    # FW2 at 0x0C0000
    blob[0x0C0000:0x0C0000 + 12] = build_mstr_header(version=1, num_files=55)
    blob[0x0C0010:0x0C0020] = b"FW2-content-here"
    # FW3 at 0x1A0000
    blob[0x1A0000:0x1A0000 + 12] = build_mstr_header(version=3, num_files=55)
    blob[0x1A0010:0x1A0020] = b"FW3-content-here"
    return bytes(blob)


# Canonical ESPHome 4MB layout parts (used when a full PT is needed)
CANONICAL_PARTS = lambda: [
    build_partition_entry("otadata",  0x01, 0x00, 0x009000, 0x002000),
    build_partition_entry("phy_init", 0x01, 0x01, 0x00B000, 0x001000),
    build_partition_entry("app0",     0x00, 0x10, 0x010000, 0x1C0000),
    build_partition_entry("app1",     0x00, 0x11, 0x1D0000, 0x1C0000),
    build_partition_entry("nvs",      0x01, 0x02, 0x390000, 0x06D000),
]

STOCK_PARTS = lambda: [
    build_partition_entry("nvs",       0x01, 0x02, 0x009000, 0x008000),
    build_partition_entry("otadata",   0x01, 0x00, 0x011000, 0x002000),
    build_partition_entry("phy_init",  0x01, 0x01, 0x013000, 0x001000),
    build_partition_entry("aqara_fw1", 0x00, 0x10, 0x020000, 0x200000),
    build_partition_entry("aqara_fw2", 0x00, 0x11, 0x220000, 0x200000),
    build_partition_entry("test",      0x00, 0x20, 0x420000, 0x013000),
    build_partition_entry("mcu_ota",   0x01, 0xFE, 0x433000, 0x400000),
    build_partition_entry("fctry",     0x01, 0x02, 0x833000, 0x006000),
]


# --- Tests ------------------------------------------------------------------

class ParsePartitionTableTests(unittest.TestCase):

    def test_happy_path(self):
        flash = build_synthetic_flash(CANONICAL_PARTS())
        parts = erf.parse_partition_table(flash)
        self.assertEqual(len(parts), 5)
        self.assertEqual(parts[0].label, "otadata")
        self.assertEqual(parts[-1].label, "nvs")
        self.assertEqual(parts[2].offset, 0x10000)
        self.assertEqual(parts[2].size, 0x1C0000)

    def test_stock_layout(self):
        flash = build_synthetic_flash(STOCK_PARTS())
        parts = erf.parse_partition_table(flash)
        labels = [p.label for p in parts]
        self.assertIn("mcu_ota", labels)
        mcu = next(p for p in parts if p.label == "mcu_ota")
        self.assertEqual(mcu.offset, 0x433000)
        self.assertEqual(mcu.size, 0x400000)
        self.assertEqual(mcu.subtype, 0xFE)

    def test_file_too_small(self):
        with self.assertRaises(erf.ExtractError) as cm:
            erf.parse_partition_table(b"\xff" * 0x1000)
        self.assertEqual(cm.exception.exit_code, 1)
        self.assertIn("too small", str(cm.exception))

    def test_bad_magic(self):
        # Flash with non-magic bytes where the first partition should be
        flash = bytearray(b"\xff" * (16 * 1024 * 1024))
        flash[erf.PT_OFFSET:erf.PT_OFFSET + 4] = b"\xca\xfe\xba\xbe"
        with self.assertRaises(erf.ExtractError) as cm:
            erf.parse_partition_table(bytes(flash))
        self.assertEqual(cm.exception.exit_code, 2)
        self.assertIn("unknown partition entry magic", str(cm.exception))

    def test_md5_mismatch(self):
        flash = bytearray(build_synthetic_flash(CANONICAL_PARTS()))
        # Corrupt one byte in the MD5
        md5_slot = erf.PT_OFFSET + 5 * erf.ENTRY_SIZE + 16
        flash[md5_slot] ^= 0xFF
        with self.assertRaises(erf.ExtractError) as cm:
            erf.parse_partition_table(bytes(flash))
        self.assertEqual(cm.exception.exit_code, 2)
        self.assertIn("MD5 mismatch", str(cm.exception))

    def test_missing_md5_but_ff_terminator(self):
        # Build PT manually without MD5 (end-of-table = all 0xFF)
        flash = build_synthetic_flash(CANONICAL_PARTS(), include_md5=False)
        parts = erf.parse_partition_table(flash)
        self.assertEqual(len(parts), 5)


class FindMcuOtaTests(unittest.TestCase):

    def test_found_by_label(self):
        parts = [
            erf.Partition("nvs", 1, 2, 0x9000, 0x5000, 0),
            erf.Partition("mcu_ota", 1, 0xFE, 0x433000, 0x400000, 0),
        ]
        p = erf.find_mcu_ota(parts)
        self.assertEqual(p.label, "mcu_ota")

    def test_found_by_subtype_fallback(self):
        parts = [
            erf.Partition("custom_radar", 1, 0xFE, 0x300000, 0x400000, 0),
        ]
        p = erf.find_mcu_ota(parts)
        self.assertEqual(p.label, "custom_radar")

    def test_missing_raises(self):
        parts = [erf.Partition("nvs", 1, 2, 0x9000, 0x5000, 0)]
        with self.assertRaises(erf.ExtractError) as cm:
            erf.find_mcu_ota(parts)
        self.assertEqual(cm.exception.exit_code, 2)
        self.assertIn("no 'mcu_ota'", str(cm.exception))

    def test_ambiguous_0xFE_subtypes(self):
        parts = [
            erf.Partition("foo", 1, 0xFE, 0x200000, 0x400000, 0),
            erf.Partition("bar", 1, 0xFE, 0x600000, 0x400000, 0),
        ]
        with self.assertRaises(erf.ExtractError) as cm:
            erf.find_mcu_ota(parts)
        self.assertEqual(cm.exception.exit_code, 2)
        self.assertIn("cannot disambiguate", str(cm.exception))


class TrimTrailingFfTests(unittest.TestCase):

    def test_trim_padding(self):
        self.assertEqual(erf.trim_trailing_ff(b"abc\xff\xff\xff"), b"abc")

    def test_no_trailing_ff(self):
        self.assertEqual(erf.trim_trailing_ff(b"abc"), b"abc")

    def test_all_ff(self):
        self.assertEqual(erf.trim_trailing_ff(b"\xff" * 100), b"")


class ValidateMstrImagesTests(unittest.TestCase):

    def test_all_three_present(self):
        blob = build_canonical_radar_blob()
        images = erf.validate_mstr_images(blob, strict=True)
        self.assertEqual(len(images), 3)
        self.assertEqual(images[0].offset, 0x000000)
        self.assertEqual(images[0].version, 1)
        self.assertEqual(images[1].offset, 0x0C0000)
        self.assertEqual(images[2].offset, 0x1A0000)
        self.assertEqual(images[2].version, 3)

    def test_missing_fw2_strict(self):
        blob = bytearray(build_canonical_radar_blob())
        # Wipe the MSTR magic at FW2
        blob[0x0C0000:0x0C0004] = b"ZZZZ"
        with self.assertRaises(erf.ExtractError) as cm:
            erf.validate_mstr_images(bytes(blob), strict=True)
        self.assertEqual(cm.exception.exit_code, 3)
        self.assertIn("FW2", str(cm.exception))

    def test_missing_fw2_relaxed(self):
        blob = bytearray(build_canonical_radar_blob())
        blob[0x0C0000:0x0C0004] = b"ZZZZ"
        images = erf.validate_mstr_images(bytes(blob), strict=False)
        self.assertEqual(len(images), 2)
        self.assertEqual({i.name[:3] for i in images}, {"FW1", "FW3"})

    def test_blob_too_short(self):
        blob = build_canonical_radar_blob()[:0x100]
        with self.assertRaises(erf.ExtractError) as cm:
            erf.validate_mstr_images(blob, strict=True)
        self.assertEqual(cm.exception.exit_code, 3)
        self.assertIn("too short", str(cm.exception))


class ExtractRadarFirmwareIntegrationTests(unittest.TestCase):

    def _make_dump(self, extra_blob=None, **pt_kwargs):
        blob = extra_blob if extra_blob is not None else build_canonical_radar_blob()
        return build_synthetic_flash(
            STOCK_PARTS(),
            mcu_ota_offset=0x433000,
            mcu_ota_size=0x400000,
            mcu_ota_blob=blob,
            **pt_kwargs,
        )

    def test_synthetic_stock_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            flash_path = Path(tmp) / "flash.bin"
            flash_path.write_bytes(self._make_dump())
            blob, parts, mcu, images = erf.extract_radar_firmware(flash_path)
            self.assertEqual(mcu.label, "mcu_ota")
            self.assertEqual(mcu.offset, 0x433000)
            self.assertEqual(len(images), 3)
            # Trimmed output should be the last meaningful byte of FW3
            # (the 16-byte content block we wrote ends at 0x1A0020)
            self.assertEqual(len(blob), 0x1A0020)

    def test_truncated_flash(self):
        with tempfile.TemporaryDirectory() as tmp:
            full = self._make_dump()
            # Truncate before mcu_ota ends — bad backup
            truncated = full[:0x500000]   # cuts into middle of mcu_ota
            path = Path(tmp) / "flash.bin"
            path.write_bytes(truncated)
            with self.assertRaises(erf.ExtractError) as cm:
                erf.extract_radar_firmware(path)
            self.assertEqual(cm.exception.exit_code, 1)
            self.assertIn("mcu_ota partition ends", str(cm.exception))

    def test_mcu_ota_all_ff(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty_blob = b"\xff" * 0x400000
            full = self._make_dump(extra_blob=empty_blob)
            path = Path(tmp) / "flash.bin"
            path.write_bytes(full)
            with self.assertRaises(erf.ExtractError) as cm:
                erf.extract_radar_firmware(path)
            # Empty blob → validate_mstr_images fails with exit code 3
            self.assertEqual(cm.exception.exit_code, 3)


class StockBackupTests(unittest.TestCase):
    """Tests against the real 16 MB stock backup if present in the repo."""

    @unittest.skipUnless(STOCK_BACKUP.exists(), f"{STOCK_BACKUP} not available")
    def test_real_backup_matches_canonical(self):
        blob, parts, mcu, images = erf.extract_radar_firmware(STOCK_BACKUP)

        # Partition layout matches what we know is on stock Aqara firmware
        labels = {p.label for p in parts}
        self.assertIn("mcu_ota", labels)
        self.assertIn("aqara_fw1", labels)
        self.assertIn("aqara_fw2", labels)
        self.assertEqual(mcu.offset, 0x433000)
        self.assertEqual(mcu.size, 0x400000)

        # Three MSTR images at expected offsets
        self.assertEqual(len(images), 3)
        offsets = [img.offset for img in images]
        self.assertEqual(offsets, [0x000000, 0x0C0000, 0x1A0000])

        # Byte-for-byte match against the canonical radar_firmware.bin shipped
        # in the repo (if it exists)
        if RADAR_FW_CANONICAL.exists():
            self.assertEqual(blob, RADAR_FW_CANONICAL.read_bytes(),
                             "Extracted radar blob must match backup/radar_firmware.bin")

        # Pin expected SHA256 so regressions are caught
        EXPECTED_SHA = "964d1fc24a78b1dcb1b8c18e3b4167ef475bb4b7cb87c68485909407ba31d2c2"
        self.assertEqual(hashlib.sha256(blob).hexdigest(), EXPECTED_SHA)


class CLITests(unittest.TestCase):
    """End-to-end CLI invocation via subprocess."""

    def _run(self, *args) -> subprocess.CompletedProcess:
        cmd = [sys.executable,
               str(REPO_ROOT / "scripts" / "extract_radar_firmware.py"),
               *args]
        return subprocess.run(cmd, capture_output=True, text=True)

    def test_missing_file(self):
        result = self._run("/nonexistent/path.bin")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", result.stderr)

    def test_help(self):
        result = self._run("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Extract radar firmware", result.stdout)

    def test_verify_only_synthetic(self):
        with tempfile.TemporaryDirectory() as tmp:
            flash = build_synthetic_flash(
                STOCK_PARTS(),
                mcu_ota_offset=0x433000,
                mcu_ota_size=0x400000,
                mcu_ota_blob=build_canonical_radar_blob(),
            )
            path = Path(tmp) / "flash.bin"
            path.write_bytes(flash)
            result = self._run(str(path), "--verify-only")
            self.assertEqual(result.returncode, 0, msg=result.stderr)
            self.assertIn("Verification OK", result.stdout)
            # Must not have written an output file
            self.assertFalse((path.parent / "radar_firmware.bin").exists())

    def test_full_extraction_synthetic(self):
        with tempfile.TemporaryDirectory() as tmp:
            flash = build_synthetic_flash(
                STOCK_PARTS(),
                mcu_ota_offset=0x433000,
                mcu_ota_size=0x400000,
                mcu_ota_blob=build_canonical_radar_blob(),
            )
            path = Path(tmp) / "flash.bin"
            path.write_bytes(flash)
            out = path.parent / "radar_firmware.bin"
            result = self._run(str(path), "-o", str(out))
            self.assertEqual(result.returncode, 0, msg=result.stderr)
            self.assertTrue(out.exists())
            # Output should not start with 0xFF (first byte = 'M' of MSTR)
            self.assertEqual(out.read_bytes()[:4], b"MSTR")

    def test_list_partitions_synthetic(self):
        with tempfile.TemporaryDirectory() as tmp:
            flash = build_synthetic_flash(STOCK_PARTS())
            path = Path(tmp) / "flash.bin"
            path.write_bytes(flash)
            result = self._run(str(path), "--list-partitions")
            self.assertEqual(result.returncode, 0, msg=result.stderr)
            self.assertIn("mcu_ota", result.stdout)
            self.assertIn("0x00433000", result.stdout)


def main() -> int:
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
