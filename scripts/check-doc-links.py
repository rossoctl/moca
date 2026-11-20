#!/usr/bin/env python3
"""Check relative links and in-repo anchors in tracked Markdown files.

Offline and deterministic: external (http/mailto) links are not fetched. Code fences and inline code
are ignored. Inline and reference-style links are checked. Anchors use GitHub's heading slug rules. Exit status 1 when any link is broken.

Usage: scripts/check-doc-links.py [path ...]   (default: every tracked *.md except pi-fork/)
"""
import os
import re
import subprocess
import sys

# GitHub-relative URLs that resolve on github.com but not in a checkout.
ALLOW = {("SECURITY.md", "../../security/advisories/new")}

LINK = re.compile(r"\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
FENCE = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1", re.S | re.M)
REFDEF = re.compile(r"^[ ]{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$", re.M)
INLINE = re.compile(r"`[^`\n]*`")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$", re.M)


def slug(text):
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.replace("`", "").lower()
    text = re.sub(r"[^\w\- ]", "", text, flags=re.U)
    return text.strip().replace(" ", "-")


def anchors(path, cache={}):
    if path not in cache:
        body = FENCE.sub("", open(path, encoding="utf-8").read())
        seen, out = {}, set()
        for h in HEADING.findall(body):
            s = slug(h)
            n = seen.get(s, 0)
            seen[s] = n + 1
            out.add(s if n == 0 else f"{s}-{n}")
        cache[path] = out
    return cache[path]


def main(argv):
    files = argv or [
        f
        for f in subprocess.check_output(["git", "ls-files", "*.md"], text=True).splitlines()
        if f and not f.startswith("pi-fork/")
    ]
    bad = []
    for f in files:
        text = INLINE.sub("", FENCE.sub("", open(f, encoding="utf-8").read()))
        for link in [m.group(1) for m in LINK.finditer(text)] + REFDEF.findall(text):
            if link.startswith("pathname://"):
                # Docusaurus escape for a file the docs plugin does not route (the .html explainers):
                # the target is still checked, relative to this page.
                link = link[len("pathname://") :]
            if re.match(r"(https?:|mailto:|tel:)", link) or "<" in link or (f, link) in ALLOW:
                continue
            target, _, frag = link.partition("#")
            path = os.path.normpath(os.path.join(os.path.dirname(f), target)) if target else f
            if not os.path.exists(path):
                bad.append(f"{f}: missing target {link}")
            elif frag and path.endswith(".md") and frag.lower() not in anchors(path):
                bad.append(f"{f}: missing anchor {link}")
    for b in bad:
        print(b)
    print(f"checked {len(files)} files, {len(bad)} broken link(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
