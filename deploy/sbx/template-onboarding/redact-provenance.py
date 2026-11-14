#!/usr/bin/env python3
"""Redact one template's provenance stream and catalog entry in place (offline, control plane stopped).

    python3 redact-provenance.py STORE_DIR TEMPLATE_ID --pattern REGEX [--pattern REGEX ...] [--apply]
    python3 redact-provenance.py STORE_DIR --catalog-only --pattern REGEX [...] [--apply]

--catalog-only redacts every catalog entry (catalog/*.json) and touches no provenance record: for
text that reached only the catalog (a build's stored `log`, which no provenance record copies).

STORE_DIR is the control plane's SH_PROVENANCE_DIR (records/, heads/, blobs/, and catalog/ when the
template store shares the directory). For the template's stream (`template/<id>`), every record
with a string value that matches a pattern is rewritten with each match replaced by `<redacted>`
(keys are never rewritten, so a match only inside a key, or only across values in the canonical
text, is not a hit), and every LATER record of the stream is rewritten too, since its `prev` names
the one before: digests change from the first redacted record on, and the stream's head moves to
the new last record. The template's catalog entry (catalog/<id>.json), if there is one, is redacted
the same way. The old record files are removed, except a file the rewritten chain still names. A
`redaction` note is appended to `<STORE_DIR>/redactions.log` (stream, the old and new head, how
many records, when; never the matched text).

Provenance records are append-only by design (template lifecycle spec §7.2): this tool is for removing
data that must not be kept, a user's decision, and its use is itself recorded. An exported copy taken
before the redaction no longer verifies against the new head: that is the point.

Without --apply it prints what it would change (counts only) and changes nothing. Patterns are never
printed. Stdlib only, the canonical JSON of packages/control-plane/src/provenance.ts.
"""

import hashlib
import json
import os
import re
import sys
import tempfile
import time


def canonical(v):
    if v is None or isinstance(v, bool):
        return json.dumps(v)
    if isinstance(v, int):
        return json.dumps(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k) + ":" + canonical(v[k]) for k in sorted(v)) + "}"
    raise ValueError(f"not canonical JSON: {type(v).__name__}")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def scrub(v, pats):
    if isinstance(v, str):
        for p in pats:
            v = p.sub("<redacted>", v)
        return v
    if isinstance(v, list):
        return [scrub(x, pats) for x in v]
    if isinstance(v, dict):
        return {k: scrub(x, pats) for k, x in v.items()}
    return v


def write_atomic(path, data):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".redact-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def main(argv):
    if len(argv) < 2 or argv[0] in ("-h", "--help"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    if len(argv) > 1 and argv[1] == "--catalog-only":
        return catalog_only(argv[0], argv[2:])
    store, tid, rest = argv[0], argv[1], argv[2:]
    pats, apply = [], False
    while rest:
        if rest[0] == "--apply":
            apply, rest = True, rest[1:]
        elif rest[0] == "--pattern" and len(rest) > 1:
            pats.append(re.compile(rest[1]))
            rest = rest[2:]
        else:
            print("usage: redact-provenance.py STORE_DIR TEMPLATE_ID --pattern REGEX ... [--apply]", file=sys.stderr)
            return 2
    if not pats or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", tid):
        print("need at least one --pattern and a template id", file=sys.stderr)
        return 2
    stream = f"template/{tid}"
    head_path = os.path.join(store, "heads", sha(stream.encode()) + ".json")
    if not os.path.exists(head_path):
        print(f"stream {stream} has no head in {store}", file=sys.stderr)
        return 2
    with open(head_path) as f:
        head = json.load(f)
    # Walk the chain from the head.
    chain, at = [], head["head"]
    while at:
        raw = open(os.path.join(store, "records", at[len("sha256:"):] + ".json"), "rb").read()
        if "sha256:" + sha(raw) != at:
            print(f"record {at[:19]}... does not match its digest: refusing", file=sys.stderr)
            return 1
        r = json.loads(raw)
        chain.append(r)
        at = r["prev"]
    chain.reverse()
    # A hit is a record the redaction changes, not a match in its canonical text: scrub() rewrites
    # string values only, so a match inside a key, or across values, changes no byte.
    hits = [i for i, r in enumerate(chain) if scrub(r, pats) != r]
    cat_path = os.path.join(store, "catalog", tid + ".json")
    doc = json.load(open(cat_path)) if os.path.exists(cat_path) else None
    cat_hits = bool(doc) and scrub(doc, pats) != doc
    print(f"stream {stream}: {len(chain)} records, {len(hits)} match; catalog entry: {'matches' if cat_hits else 'clean'}")
    if not hits and not cat_hits:
        print("nothing to redact")
        return 0
    if not apply:
        print(f"would rewrite records from seq {hits[0] + 1 if hits else '-'} to {len(chain)}; run with --apply")
        return 0
    old_head, prev, rewritten, old_files, keep = head["head"], None, 0, [], set()
    for i, r in enumerate(chain):
        if hits and i >= hits[0]:
            old_files.append(os.path.join(store, "records", (("sha256:" + sha(canonical(r).encode()))[7:]) + ".json"))
            r = dict(scrub(r, pats))
            r["prev"] = prev
            rewritten += 1
        b = canonical(r).encode()
        d = "sha256:" + sha(b)
        if hits and i >= hits[0]:
            write_atomic(os.path.join(store, "records", d[7:] + ".json"), b)
            keep.add(os.path.join(store, "records", d[7:] + ".json"))
        prev = d
    if hits:
        write_atomic(head_path, canonical({"stream": stream, "head": prev, "count": len(chain)}).encode())
    new_head = prev
    # Every file the rewritten chain names stays, even one whose bytes the redaction left as they were.
    for f in old_files:
        if f not in keep and os.path.exists(f):
            os.remove(f)
    if doc:
        doc = scrub(doc, pats)
        # A build that cited a now-rewritten record names its new digest only through the chain;
        # the catalog keeps the create's digest (seq 1), which a redaction from seq 2 on leaves alone.
        write_atomic(cat_path, json.dumps(doc).encode())
    with open(os.path.join(store, "redactions.log"), "a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stream": stream,
                            "old_head": old_head, "new_head": new_head, "records_rewritten": rewritten,
                            "catalog_redacted": bool(cat_hits)}) + "\n")
    print(f"rewrote {rewritten} records; head {old_head[:19]}... -> {new_head[:19]}...; catalog {'redacted' if cat_hits else 'unchanged'}")
    return 0


def catalog_only(store, rest):
    pats, apply = [], False
    while rest:
        if rest[0] == "--apply":
            apply, rest = True, rest[1:]
        elif rest[0] == "--pattern" and len(rest) > 1:
            pats.append(re.compile(rest[1]))
            rest = rest[2:]
        else:
            print("usage: redact-provenance.py STORE_DIR --catalog-only --pattern REGEX ... [--apply]", file=sys.stderr)
            return 2
    if not pats:
        print("need at least one --pattern", file=sys.stderr)
        return 2
    cdir = os.path.join(store, "catalog")
    changed = 0
    for name in sorted(os.listdir(cdir)) if os.path.isdir(cdir) else []:
        if not name.endswith(".json"):
            continue
        path = os.path.join(cdir, name)
        raw = open(path).read()
        n = sum(len(p.findall(raw)) for p in pats)
        if not n:
            continue
        print(f"catalog/{name}: {n} match(es)")
        changed += 1
        if apply:
            write_atomic(path, json.dumps(scrub(json.loads(raw), pats)).encode())
    if apply and changed:
        with open(os.path.join(store, "redactions.log"), "a") as f:
            f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "catalog_only": True,
                                "entries_redacted": changed}) + "\n")
    print(f"{'redacted' if apply else 'would redact'} {changed} catalog entr{'y' if changed == 1 else 'ies'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
