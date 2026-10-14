"""Rebuild a remote binary file from bastion `tail -c +N FILE | head -c SIZE | base64` outputs.

Reads a Claude Code session transcript (JSONL), collects bastion execute_command results whose
command mentions FILE and matches `tail -c +N ... base64`, decodes them in offset order, checks the
chunks are contiguous, and verifies the expected size / md5 when given.

Usage:
  python3 -I assemble_b64_chunks.py --transcript SESSION.jsonl --remote-path FILE --out OUT \
      [--size BYTES] [--md5 HEX]
Exit codes: 0 ok, 1 gap/overlap or verification failure, 2 no chunks found.
"""
import argparse
import base64
import hashlib
import json
import re
import sys

OFFSET = re.compile(r"tail\s+-c\s+\+(\d+)")
NON_B64 = re.compile(r"[^A-Za-z0-9+/=]")
SAVED_TO = re.compile(r"saved to:?\s*(/\S+?\.(?:txt|json))(?=[.\s\\]|$)")


def text_of(content):
    if isinstance(content, str):
        text = content
    else:
        text = "".join(i.get("text", "") for i in content if isinstance(i, dict))
    saved = SAVED_TO.search(text)
    if saved:  # client persisted a large result to disk and kept only a preview
        with open(saved.group(1), encoding="utf-8") as fh:
            text = fh.read()
    try:
        return json.loads(text)["result"]
    except (ValueError, KeyError, TypeError):
        return text


def collect(transcript, remote_path):
    pending, chunks = {}, {}
    with open(transcript, encoding="utf-8") as fh:
        for line in fh:
            try:
                msg = json.loads(line).get("message", {})
            except ValueError:
                continue
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for item in content:
                if item.get("type") == "tool_use" and "bastion" in item.get("name", ""):
                    cmd = str((item.get("input") or {}).get("command", ""))
                    m = OFFSET.search(cmd)
                    if remote_path in cmd and "base64" in cmd and m:
                        pending[item["id"]] = int(m.group(1))
                elif item.get("type") == "tool_result" and item.get("tool_use_id") in pending:
                    raw = NON_B64.sub("", text_of(item.get("content", "")))
                    try:
                        data = base64.b64decode(raw, validate=True)
                    except ValueError as exc:
                        sys.exit(f"chunk at offset {pending[item['tool_use_id']]} is not valid base64 "
                                 f"({exc}); the result may be truncated or an error message")
                    chunks[pending[item["tool_use_id"]]] = data  # later retries win
    return chunks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--remote-path", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int)
    ap.add_argument("--md5")
    args = ap.parse_args()

    chunks = collect(args.transcript, args.remote_path)
    if not chunks:
        print("no base64 chunks found for", args.remote_path, file=sys.stderr)
        return 2
    buf, expected = bytearray(), 1
    for offset in sorted(chunks):
        if offset != expected:
            print(f"gap/overlap: expected offset {expected}, got {offset}", file=sys.stderr)
            return 1
        buf += chunks[offset]
        expected += len(chunks[offset])
    with open(args.out, "wb") as fh:
        fh.write(buf)
    md5 = hashlib.md5(buf).hexdigest()
    print(f"chunks={len(chunks)} bytes={len(buf)} md5={md5}")
    if args.size is not None and args.size != len(buf):
        print(f"size mismatch: expected {args.size}", file=sys.stderr)
        return 1
    if args.md5 and args.md5.lower() != md5:
        print(f"md5 mismatch: expected {args.md5}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
