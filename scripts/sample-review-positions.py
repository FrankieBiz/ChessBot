"""Extract a deterministic deep-search benchmark sample from a Lichess PGN archive."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from calibrate import HEADER, extract_position


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    headers, text = {}, []
    with subprocess.Popen(["zstd", "-dc", str(args.archive)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding="utf-8", errors="replace") as process:
        for line in process.stdout:
            if line.startswith('[Event "'):
                site = headers.get("Site")
                if site and int.from_bytes(hashlib.sha256(site.encode()).digest()[:4], "big") % 40 == 0:
                    movetext = " ".join(text)
                    row = extract_position(headers, movetext)
                    if row is not None:
                        print(json.dumps({"movetext": movetext, "row": row}))
                headers, text = {}, []
            line = line.strip()
            header = HEADER.fullmatch(line)
            if header:
                headers[header[1]] = header[2]
            elif line:
                text.append(line)
        errors = process.stderr.read()
        if process.wait() and "premature end" not in errors.lower():
            raise RuntimeError(errors)


if __name__ == "__main__":
    main()
