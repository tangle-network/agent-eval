"""Reject Python distributions whose runtime metadata PyPI will not accept."""

from __future__ import annotations

import email
import sys
import tarfile
import zipfile
from pathlib import Path


def _metadata_files(dist_dir: Path) -> list[tuple[Path, str]]:
    metadata: list[tuple[Path, str]] = []
    for artifact in sorted(dist_dir.iterdir()):
        if artifact.suffix == ".whl":
            with zipfile.ZipFile(artifact) as archive:
                names = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
                if len(names) != 1:
                    raise ValueError(f"{artifact.name}: expected one wheel METADATA file")
                metadata.append((artifact, archive.read(names[0]).decode()))
        elif artifact.name.endswith(".tar.gz"):
            with tarfile.open(artifact, "r:gz") as archive:
                members = [
                    member
                    for member in archive.getmembers()
                    if member.name.count("/") == 1 and member.name.endswith("/PKG-INFO")
                ]
                if len(members) != 1:
                    raise ValueError(f"{artifact.name}: expected one top-level PKG-INFO file")
                extracted = archive.extractfile(members[0])
                if extracted is None:
                    raise ValueError(f"{artifact.name}: could not read PKG-INFO")
                metadata.append((artifact, extracted.read().decode()))
    return metadata


def main() -> int:
    dist_dir = Path(sys.argv[1]) if len(sys.argv) == 2 else Path("dist")
    metadata = _metadata_files(dist_dir)
    if not metadata:
        raise ValueError(f"{dist_dir}: no wheel or source distribution found")

    rejected: list[str] = []
    for artifact, raw_metadata in metadata:
        parsed = email.message_from_string(raw_metadata)
        for requirement in parsed.get_all("Requires-Dist", []):
            if " @ " in requirement:
                rejected.append(f"{artifact.name}: {requirement}")

    if rejected:
        print("PyPI rejects direct-URL runtime dependencies:", file=sys.stderr)
        for requirement in rejected:
            print(f"- {requirement}", file=sys.stderr)
        return 1

    print(f"Publishable Python metadata: {len(metadata)} distributions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
