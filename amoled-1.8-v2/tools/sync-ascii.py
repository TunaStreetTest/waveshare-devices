#!/usr/bin/env python3
"""Copy the canonical toAscii() from uikit/ascii.js into every app package.

The Brookesia JS runtime has no module loader -- an app is one global script --
so every apps/<id>/app/app.js has to carry its own copy of the sanitiser. This
keeps those copies honest: one source of truth in uikit/ascii.js, a mechanical
copy into each app, and tools/simulator/selftest.js asserting they still match.

    python3 tools/sync-ascii.py            # update every app
    python3 tools/sync-ascii.py --check    # fail if any copy is stale

Run it after editing uikit/ascii.js, and commit the app files it touches.
"""
import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CANON = ROOT / "uikit" / "ascii.js"
APPS = ROOT / "apps"

BEGIN = "/* --- BEGIN toAscii (canonical: uikit/ascii.js -- do not edit in place) --- */"
END = "/* --- END toAscii --- */"

# Every app funnels its screen text through one setText(); that is where the
# sanitiser has to sit, so nothing reaches SetText unfiltered.
SET_TEXT_RE = re.compile(r"(\n    function setText\(path, text\) \{\n)")


def canonical_block() -> str:
    src = CANON.read_text(encoding="utf-8")
    start = src.index(BEGIN)
    end = src.index(END) + len(END)
    return src[start:end]


def app_files():
    for manifest in sorted(APPS.glob("*/manifest.json")):
        app_js = manifest.parent / "app" / "app.js"
        if app_js.exists():
            yield app_js


def apply(app_js: pathlib.Path, block: str) -> bool:
    src = app_js.read_text(encoding="utf-8")
    original = src

    if BEGIN in src:
        start = src.index(BEGIN)
        end = src.index(END) + len(END)
        src = src[:start] + block + src[end:]
    else:
        m = SET_TEXT_RE.search(src)
        if not m:
            print(f"  SKIP {app_js.relative_to(ROOT)} - no setText(path, text) to guard")
            return False
        src = src[: m.start()] + "\n" + block + "\n" + src[m.start():]

    # Route setText through it. String(text) becomes toAscii(text), which does
    # the String() itself and is null/undefined safe.
    src = src.replace(
        "guiCall(\"SetText\", { Path: SCREEN + path, Text: String(text) });",
        "guiCall(\"SetText\", { Path: SCREEN + path, Text: toAscii(text) });",
    )
    src = re.sub(
        r"(\n    function setText\(path, text\) \{\n        )var s = String\(text\);",
        r"\1var s = toAscii(text);",
        src,
    )

    if src == original:
        return False
    app_js.write_text(src, encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if any app's copy is stale")
    args = ap.parse_args()

    block = canonical_block()
    stale = []
    for app_js in app_files():
        src = app_js.read_text(encoding="utf-8")
        rel = app_js.relative_to(ROOT)
        has_block = BEGIN in src and block in src
        wired = "toAscii(text)" in src
        if has_block and wired:
            print(f"  ok    {rel}")
            continue
        # An app with no setText() has no screen text to guard (the hello
        # template). That is not staleness -- do not fail --check on it.
        if not SET_TEXT_RE.search(src) and not has_block:
            print(f"  n/a   {rel} - no setText(path, text) to guard")
            continue
        stale.append(rel)
        if args.check:
            why = "sanitiser copy is stale" if BEGIN in src else "no sanitiser"
            if has_block and not wired:
                why = "sanitiser present but setText does not use it"
            print(f"  STALE {rel} - {why}")
        else:
            changed = apply(app_js, block)
            print(f"  {'updated' if changed else 'unchanged'} {rel}")

    if args.check and stale:
        print(f"\n{len(stale)} app(s) out of sync - run: python3 tools/sync-ascii.py")
        return 1
    print("\nall app copies match uikit/ascii.js" if not stale else "\nsynced")
    return 0


if __name__ == "__main__":
    sys.exit(main())
