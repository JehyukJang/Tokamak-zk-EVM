#!/usr/bin/env python3

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import zipfile
from pathlib import Path

ARCHIVE_FILES = {
    "combined_sigma.rkyv",
    "sigma_preprocess.rkyv",
    "sigma_verify.json",
    "crs_provenance.json",
}


def compatible_version(package_version: str) -> str:
    if re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", package_version) is None:
        raise ValueError(f"package version must be canonical MAJOR.MINOR.PATCH, got {package_version!r}")
    return ".".join(package_version.split(".")[:2])


def canonical_archive_name_pattern(package_version: str) -> re.Pattern[str]:
    compatibility = compatible_version(package_version)
    return re.compile(
        rf"^tokamak-backend-crs-v{re.escape(compatibility)}-(\d{{8}}T\d{{6}}Z)\.zip$"
    )


def extract_canonical_archive(archive_bytes: bytes, output: Path) -> None:
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        entries = {info.filename for info in archive.infolist() if not info.is_dir()}
        if entries != ARCHIVE_FILES:
            missing = sorted(ARCHIVE_FILES - entries)
            extra = sorted(entries - ARCHIVE_FILES)
            raise ValueError(f"CRS archive members are not canonical: missing={missing}, extra={extra}")
        output.mkdir(parents=True, exist_ok=True)
        for name in sorted(ARCHIVE_FILES):
            (output / name).write_bytes(archive.read(name))


def find_drive_archive(package_version: str, folder_id: str, credential_path: str):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        credential_path,
        scopes=["https://www.googleapis.com/auth/drive.readonly"],
    )
    service = build("drive", "v3", credentials=credentials, cache_discovery=False)
    query = (
        f"'{folder_id}' in parents and "
        "trashed = false and "
        "mimeType = 'application/zip'"
    )
    pattern = canonical_archive_name_pattern(package_version)
    matches = []
    page_token = None
    while True:
        response = (
            service.files()
            .list(
                q=query,
                pageSize=100,
                pageToken=page_token,
                fields="nextPageToken,files(id,name,webViewLink)",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        matches.extend(file for file in response.get("files", []) if pattern.fullmatch(file.get("name", "")))
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return service, require_unique_match(matches)


def require_unique_match(matches):
    if len(matches) > 1:
        names = sorted(f"{file['name']} ({file['id']})" for file in matches)
        raise ValueError(f"Drive contains duplicate canonical CRS archives: {names}")
    return matches[0] if matches else None


def download_drive_file(service, file_id: str) -> bytes:
    from googleapiclient.http import MediaIoBaseDownload

    output = io.BytesIO()
    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    downloader = MediaIoBaseDownload(output, request, chunksize=64 * 1024 * 1024)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return output.getvalue()


def write_outputs(found: bool, archive_name: str | None) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"found={'true' if found else 'false'}\n")
            output.write(f"archive_name={archive_name or ''}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--allow-missing", action="store_true")
    args = parser.parse_args()

    if args.archive:
        extract_canonical_archive(args.archive.read_bytes(), args.output)
        write_outputs(True, args.archive.name)
        return 0

    folder_id = os.environ.get("TOKAMAK_MPC_DRIVE_FOLDER_ID", "").strip()
    credential_path = os.environ.get("TOKAMAK_MPC_DRIVE_SERVICE_ACCOUNT_JSON_PATH", "").strip()
    if not folder_id or not credential_path:
        raise ValueError("Drive folder configuration and service-account credential path are required")
    service, selected = find_drive_archive(args.version, folder_id, credential_path)
    if selected is None:
        if not args.allow_missing:
            raise ValueError(f"No canonical CRS archive exists for compatibility {compatible_version(args.version)}")
        write_outputs(False, None)
        print(json.dumps({"found": False, "compatibility": compatible_version(args.version)}))
        return 0

    extract_canonical_archive(download_drive_file(service, selected["id"]), args.output)
    write_outputs(True, selected["name"])
    print(json.dumps({"found": True, "archive": selected}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"[release-crs] {error}", file=sys.stderr)
        sys.exit(1)
