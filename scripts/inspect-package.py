"""Inspect a local package with Python's standard archive library; never extract."""
import base64
import json
import os
import re
import sys
import tarfile


def inspect(path):
    if os.path.getsize(path) > 10 * 1024 * 1024:
        raise ValueError()
    with tarfile.open(path, "r:gz") as archive:
        files = []
        directories = []
        names = set()
        total = 0
        for entry in archive:
            name = entry.name
            # The project's deliberate package paths use these portable names.
            # Reject aliases, duplicates and special types before reading data.
            if not re.fullmatch(r"package(?:/[A-Za-z0-9._-]+)*", name):
                raise ValueError()
            if any(part in (".", "..") for part in name.split("/")):
                raise ValueError()
            if name in names or len(names) >= 500 or entry.size < 0 or entry.mode & 0o7000:
                raise ValueError()
            names.add(name)
            if entry.isdir() and entry.size == 0:
                directories.append(name)
            elif entry.isfile() and not entry.issparse() and name != "package":
                total += entry.size
                if total > 20 * 1024 * 1024:
                    raise ValueError()
                files.append(entry)
            else:
                raise ValueError()
        allowed_directories = {"package"}
        for entry in files:
            parts = entry.name.split("/")
            allowed_directories.update("/".join(parts[:i]) for i in range(1, len(parts)))
        if any(name not in allowed_directories for name in directories):
            raise ValueError()
        # Every entry was checked before reading any member. Installation later
        # uses the same hash-checked archive in a separate owned consumer folder.
        return {
            "files": [{"path": entry.name, "size": entry.size, "mode": entry.mode,
                       "data": base64.b64encode(archive.extractfile(entry).read()).decode("ascii")}
                      for entry in sorted(files, key=lambda item: item.name)],
            "directories": sorted(directories),
        }


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError()
        print(json.dumps(inspect(sys.argv[1]), ensure_ascii=True))
    except Exception:
        print("Package archive inspection failed.", file=sys.stderr)
        sys.exit(1)
