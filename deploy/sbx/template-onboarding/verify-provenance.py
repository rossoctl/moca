#!/usr/bin/env python3
"""Verify a Moca template provenance export offline (template lifecycle spec §7.2).

    python3 deploy/sbx/template-onboarding/verify-provenance.py EXPORT.json [--head STREAM=sha256:HEX ...]
        [--egress SANDBOX_ID=FILE ...]

EXPORT.json is the control plane's provenance export (schema moca-provenance-export/1). Needs only
Python 3's standard library and the file: no Moca, no cluster, no network. Checks every record's
digest (the sha256 of its canonical JSON), every stream's seq and prev chain up to its listed head
and count, every blob against its sha256, that each check cites a policy record and each gate a
blob of the export. An export can only prove itself consistent; --head compares a stream's head
with one kept elsewhere, which is what catches an export that dropped its latest records.

--egress (optional) checks a sandbox's egress log, as `GET /v1/sandboxes/{id}/egress
?format=ndjson` returned it, against the export: the sha256 of FILE's bytes and its line count must
be the `egress` of the newest `sandbox` record of that sandbox naming one (its end record, or a later
`state: egress` record). It prints the log's `dropped` and `complete` as recorded, with the reasons
(`droppedBy`: proxy, cap, budget, invalid) when the record names them; whether an
incomplete log still counts is the reader's call. Without --egress nothing about egress is checked.

The rules are the ones packages/control-plane/src/provenance.ts (verifyExport) applies; its test
runs this script on the same exports so the two cannot drift apart.

Exit: 0 verified; 1 a check failed (each printed); 2 usage or an unreadable file.
"""

import base64
import hashlib
import json
import re
import sys

EXPORT_SCHEMA = "moca-provenance-export/1"
RECORD_SCHEMA = "moca-provenance-record/1"
KINDS = {"policy", "create", "gate", "build", "check", "activate", "deactivate", "tag", "visibility",
         "owner", "retire", "reject", "use", "sandbox", "session"}
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def canonical(value):
    """Canonical JSON, byte for byte what provenance.ts's canonicalJson writes."""
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise ValueError("canonical JSON holds safe integers only")
        return json.dumps(value)
    if isinstance(value, float):
        raise ValueError("canonical JSON holds integers only")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value):
            if not re.fullmatch(r"[\x20-\x7e]*", k):
                raise ValueError(f"canonical JSON keys are printable ASCII, got {k!r}")
            parts.append(json.dumps(k) + ":" + canonical(value[k]))
        return "{" + ",".join(parts) + "}"
    raise ValueError(f"canonical JSON refuses a {type(value).__name__}")


def digest(record):
    return "sha256:" + hashlib.sha256(canonical(record).encode("utf-8")).hexdigest()


def verify(doc):
    errors = []
    if doc.get("schema") != EXPORT_SCHEMA:
        return [f"schema is {doc.get('schema')!r}, want {EXPORT_SCHEMA}"], []
    by_digest, by_stream = {}, {}
    for r in doc.get("records", []):
        try:
            d = digest(r)
        except ValueError as e:
            errors.append(f"a record of {r.get('stream')} is not canonical JSON: {e}")
            continue
        by_digest[d] = r
        by_stream.setdefault(r.get("stream"), []).append((d, r))
    blobs = set()
    for b in doc.get("blobs", []):
        data = base64.b64decode(b.get("base64", ""))
        if "sha256:" + hashlib.sha256(data).hexdigest() != b.get("sha256"):
            errors.append(f"blob {b.get('sha256')} does not match its bytes")
        else:
            blobs.add(b["sha256"])
    listed = set()
    for h in doc.get("streams", []):
        stream = h.get("stream")
        listed.add(stream)
        rs = by_stream.get(stream, [])
        prev = None
        for i, (d, r) in enumerate(rs):
            where = f"{stream} seq {r.get('seq')}"
            if r.get("schema") != RECORD_SCHEMA:
                errors.append(f"{where}: schema {r.get('schema')!r}")
            if r.get("seq") != i + 1:
                errors.append(f"{where}: expected seq {i + 1}")
            if r.get("prev") != prev:
                errors.append(f"{where}: prev {r.get('prev')} does not name the record before it ({prev})")
            kind = r.get("kind")
            if kind not in KINDS:
                errors.append(f"{where}: unknown kind {kind}")
            if (kind == "policy") != (stream == "policy"):
                errors.append(f"{where}: a {kind} record in stream {stream}")
            body = r.get("body") or {}
            if kind == "check":
                p = body.get("policy")
                if not (isinstance(p, str) and by_digest.get(p, {}).get("kind") == "policy"):
                    errors.append(f"{where}: check cites policy {p}, not a policy record of this export")
            if kind == "gate":
                g = body.get("record_sha256")
                if g not in blobs:
                    errors.append(f"{where}: gate cites {g}, not a blob of this export")
            prev = d
        if len(rs) != h.get("count"):
            errors.append(f"{stream}: {len(rs)} records, its head says {h.get('count')}")
        if prev != h.get("head"):
            errors.append(f"{stream}: the last record is {prev}, its head says {h.get('head')}")
    for s in by_stream:
        if s not in listed:
            errors.append(f"records of stream {s}, which has no head in the export")
    return errors, doc.get("streams", [])


def check_egress(doc, sandbox_id, data):
    """The --egress check: FILE's sha256 and line count against the newest egress the export names."""
    named = None
    for r in doc.get("records", []):
        body = r.get("body") or {}
        if r.get("kind") == "sandbox" and body.get("sandboxId") == sandbox_id and isinstance(body.get("egress"), dict):
            named = body["egress"]
    if named is None:
        return [f"egress {sandbox_id}: no sandbox record of the export names its egress log"], None
    # Fail closed on the record's own shape: in Python True == 1 and 1.0 == 1, so `events` must be
    # a non-negative int that is not a bool, and `sha256` a sha256:<64 hex> string.
    events, digest = named.get("events"), named.get("sha256")
    shape = []
    if not isinstance(events, int) or isinstance(events, bool) or events < 0:
        shape.append(f"egress {sandbox_id}: the record's events is {events!r}, not a count")
    if not isinstance(digest, str) or not DIGEST_RE.match(digest):
        shape.append(f"egress {sandbox_id}: the record's sha256 is {digest!r}, not sha256:<64 hex>")
    if shape:
        return shape, None
    errors = []
    got = "sha256:" + hashlib.sha256(data).hexdigest()
    if got != named.get("sha256"):
        errors.append(f"egress {sandbox_id}: the file's sha256 is {got}, the record names {named.get('sha256')}")
    lines = data.count(b"\n")
    if lines != named.get("events") or (data and not data.endswith(b"\n")):
        errors.append(f"egress {sandbox_id}: the file has {lines} lines, the record names {named.get('events')} events")
    return errors, named


USAGE = "usage: verify-provenance.py EXPORT.json [--head STREAM=sha256:HEX ...] [--egress SANDBOX_ID=FILE ...]"


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    path, want, egress = argv[0], {}, {}
    rest = argv[1:]
    while rest:
        if rest[0] not in ("--head", "--egress") or len(rest) < 2 or "=" not in rest[1]:
            print(USAGE, file=sys.stderr)
            return 2
        key, value = rest[1].split("=", 1)
        if rest[0] == "--egress":
            try:
                with open(value, "rb") as f:
                    egress[key] = f.read()
            except OSError as e:
                print(f"verify-provenance.py: cannot read {value}: {e}", file=sys.stderr)
                return 2
            rest = rest[2:]
            continue
        stream, head = key, value
        if not DIGEST_RE.match(head):
            print(f"--head {stream}: {head!r} is not sha256:<64 hex>", file=sys.stderr)
            return 2
        want[stream] = head
        rest = rest[2:]
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        print(f"verify-provenance.py: cannot read {path}: {e}", file=sys.stderr)
        return 2
    errors, streams = verify(doc)
    heads = {h.get("stream"): h.get("head") for h in streams}
    for stream, head in want.items():
        if heads.get(stream) != head:
            errors.append(f"{stream}: the export's head is {heads.get(stream)}, the kept head is {head}")
    named = {}
    for sandbox_id, data in egress.items():
        errs, named[sandbox_id] = check_egress(doc, sandbox_id, data)
        errors.extend(errs)
    for e in errors:
        print(f"FAIL {e}")
    if errors:
        return 1
    for h in streams:
        print(f"ok {h['stream']}: {h['count']} records, head {h['head']}")
    for sandbox_id, n in named.items():
        if n is None:
            continue
        state = "complete" if n.get("complete") else f"INCOMPLETE, {n.get('dropped')} dropped"
        by = n.get("droppedBy")
        if not n.get("complete") and isinstance(by, dict):
            why = ", ".join(f"{k} {v}" for k, v in sorted(by.items()) if isinstance(v, int) and v > 0)
            state += f" ({why})" if why else ""
        print(f"ok egress {sandbox_id}: {n.get('events')} events, {n.get('sha256')}, {state}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
