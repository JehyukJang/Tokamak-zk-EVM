#!/usr/bin/env python3

import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("download-release-crs.py")
SPEC = importlib.util.spec_from_file_location("download_release_crs", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def entry(name, folder=False):
    return {
        "id": name,
        "name": name,
        "mimeType": MODULE.FOLDER_MIME_TYPE if folder else "application/octet-stream",
    }


class ReleaseCrsTest(unittest.TestCase):
    def test_uses_compatibility_class(self):
        self.assertEqual(MODULE.compatible_version("3.0.7"), "3.0")
        with self.assertRaisesRegex(ValueError, "canonical"):
            MODULE.compatible_version("3.0")

    def test_accepts_exact_version_directory_members(self):
        MODULE.validate_version_entries([entry(name) for name in MODULE.CRS_PAYLOAD_FILES])

    def test_rejects_missing_or_unexpected_version_directory_members(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            MODULE.validate_version_entries([entry(name) for name in MODULE.CRS_PAYLOAD_FILES - {"verifier_keys.rkyv"}])
        with self.assertRaisesRegex(ValueError, "extra"):
            MODULE.validate_version_entries([entry(name) for name in MODULE.CRS_PAYLOAD_FILES | {"legacy.zip"}])

    def test_rejects_duplicate_or_wrong_type_entries(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            MODULE.require_unique([entry("3.0", True), entry("3.0", True)], "3.0", True)
        with self.assertRaisesRegex(ValueError, "wrong"):
            MODULE.require_unique([entry("3.0")], "3.0", True)

    def test_validates_shared_tau_digest_from_provenance(self):
        digest = hashlib.sha256(b"tau").hexdigest()
        provenance = json.dumps({"artifacts": {name: digest for name in MODULE.CRS_PAYLOAD_FILES | {"tau_sequence.rkyv"}}}).encode()
        self.assertEqual(MODULE.provenance_artifact_digests(provenance)["tau_sequence.rkyv"], digest)
        with self.assertRaisesRegex(ValueError, "invalid"):
            MODULE.provenance_artifact_digests(
                json.dumps({"artifacts": {name: "bad" for name in MODULE.CRS_PAYLOAD_FILES | {"tau_sequence.rkyv"}}}).encode()
            )


if __name__ == "__main__":
    unittest.main()
