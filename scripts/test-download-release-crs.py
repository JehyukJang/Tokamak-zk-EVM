#!/usr/bin/env python3

import importlib.util
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("download-release-crs.py")
SPEC = importlib.util.spec_from_file_location("download_release_crs", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def archive_bytes(names):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name in names:
            archive.writestr(name, name.encode("utf-8"))
    return output.getvalue()


class ReleaseCrsTest(unittest.TestCase):
    def test_extracts_exact_canonical_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "crs"
            MODULE.extract_canonical_archive(archive_bytes(MODULE.ARCHIVE_FILES), output)
            self.assertEqual({path.name for path in output.iterdir()}, MODULE.ARCHIVE_FILES)

    def test_rejects_missing_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "missing"):
                MODULE.extract_canonical_archive(
                    archive_bytes(MODULE.ARCHIVE_FILES - {"crs_provenance.json"}),
                    Path(temporary) / "crs",
                )

    def test_rejects_extra_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "extra"):
                MODULE.extract_canonical_archive(
                    archive_bytes(MODULE.ARCHIVE_FILES | {"build-metadata-mpc-setup.json"}),
                    Path(temporary) / "crs",
                )

    def test_uses_compatibility_class_in_archive_name(self):
        pattern = MODULE.canonical_archive_name_pattern("3.0.7")
        self.assertIsNotNone(pattern.fullmatch("tokamak-backend-crs-v3.0-20260831T120000Z.zip"))
        self.assertIsNone(pattern.fullmatch("tokamak-backend-crs-v3.0-20260831.zip"))
        self.assertIsNone(pattern.fullmatch("tokamak-backend-crs-v3.1-20260831T120000Z.zip"))

    def test_rejects_duplicate_compatibility_archives(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            MODULE.require_unique_match(
                [
                    {"name": "tokamak-backend-crs-v3.0-20260831T120000Z.zip", "id": "one"},
                    {"name": "tokamak-backend-crs-v3.0-20260831T130000Z.zip", "id": "two"},
                ]
            )


if __name__ == "__main__":
    unittest.main()
