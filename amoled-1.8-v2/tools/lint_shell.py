#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Steven Matison
#
# SPDX-License-Identifier: Apache-2.0
"""Run the UI kit's rules over the Brookesia SHELL resources.

The kit's two linters (uikit/lint.py at generation time, tools/simulator/
lint.js before a flash) only ever saw apps/*/res/screens/*.json. Every upstream
shell screen and template was unchecked -- which is exactly how
`requireValidPress: true` sat in `launcher_app_button.json` swallowing launcher
taps until #197 found it by hand, and how the launcher grid kept a scroll
container nothing needed (#220). The shell is data on littlefs, it ships the
same way an app screen does, and it is where the framework-level touch bugs
have actually been.

What this adds over pointing lint.py at the files directly: the shell dialect
is not the generated dialect. Sizes are strings with units ("112dp", "16sp"),
positions are `${constant...}` references and `${expr(...)}` arithmetic over
`${env.widthDp}` / `${env.heightDp}`, and the constants themselves come from
two merged assets. This resolves all of that to the plain numbers lint.py
expects, then runs the same rule set -- so a shell file is judged by the same
tokens.json as our own screens.

Sources, in the order the device sees them:
  * upstream tree           ~/esp/esp-brookesia/system/brookesia_system_super/
                            resource/shell   (or $BROOKESIA_DIR)
  * our overlay, which wins platform/overlay/system/brookesia_system_super/
                            resource/shell
Constants merge default.json then portrait.json, matching root.json's variant
rule for a 368x448 portrait panel.

Two verdicts, because we own half of this tree and inherit the other half:

  * OUR OVERLAY is gated. Anything we ship in platform/overlay must be clean,
    or carry an explicit entry in WAIVERS below saying why it is deliberate.
    The exit code counts these.
  * UPSTREAM is surveyed. Its findings are printed, not gated -- they are real
    (message_dialog draws its buttons at 12px, keyboard_input's toggle sits
    4px from the input) but they are not ours to have broken, and a gate that
    is permanently red is a gate nobody reads.

    python3 lint_shell.py                 # gate the overlay, survey upstream
    python3 lint_shell.py --rules R2 R11  # only these rules
    python3 lint_shell.py --list          # what would be linted, and from where

Exit code is the count of non-waived findings in OUR overlay (0 = clean).
"""
import copy
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "uikit"))

import lint  # noqa: E402
import tokens as tk  # noqa: E402

OVERLAY = os.path.join(HERE, "..", "platform", "overlay", "system",
                       "brookesia_system_super", "resource", "shell")
UPSTREAM = os.path.join(
    os.environ.get("BROOKESIA_DIR", os.path.expanduser("~/esp/esp-brookesia")),
    "system", "brookesia_system_super", "resource", "shell")

ENV = {"widthDp": tk.W, "heightDp": tk.H, "densityDpi": 160}

# Findings in our own overlay that are deliberate. Each needs a reason, and a
# reason that says what would make us change our mind.
WAIVERS = [
    ("overlay:templates/launcher_app_button.json", "R2", "pressLock",
     "The tile inherits pressLock:false from the press.scale interaction "
     "template, which needs the pressLost event to animate back up. What "
     "actually lost launcher taps was not drift off a 108x112 tile -- it was "
     "the grid's scroll container: once LVGL starts scrolling it sets "
     "indev->pointer.scroll_obj, which sends PRESS_LOST and suppresses "
     "CLICKED entirely. #220 removed that scroll. If a tap on a tile is still "
     "reported as unreliable, declaring commonProps.pressLock:true on the "
     "tile node is the next lever (a node's own commonProps beats the "
     "interaction template's -- merge_object_defaults in parser_node.cpp); "
     "the cost is that sliding off tile A and releasing over tile B launches "
     "A."),
]


# A shell node can be sized "match"/"wrap"/a percentage, which numeric_shape
# drops rather than guess. lint.py then sees a zero-area box, and R5 (off-panel)
# reads a merely-negative x as an escape -- upstream's debug_panel, x=-12 with
# an unresolvable width, is not off-panel, we just do not know how wide it is.
_ZERO_BOX = re.compile(r"R5 box \(-?\d+,-?\d+,0,0\)")


def is_unknowable(violation):
    return bool(_ZERO_BOX.search(violation))


def waiver_for(violation):
    for label, rule, needle, reason in WAIVERS:
        parts = violation.split(" ")
        if violation.startswith(label) and rule in parts and needle in violation:
            return reason
    return None

# A shell asset that is neither a screen nor a view template has no node tree
# to lint (constants, styles, flows, i18n, the image index).
LINTABLE = ("viewScreen", "viewTemplate")

_UNIT = re.compile(r"^(-?\d+(?:\.\d+)?)(dp|sp|px|pt)$")
_REF = re.compile(r"\$\{(constant|env)\.([A-Za-z0-9_.]+)\}")
_EXPR = re.compile(r"^\$\{expr\((.*)\)\}$", re.S)


def deep_merge(base, add):
    for key, value in add.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def shell_file(rel):
    """Overlay first -- that is the file the board actually gets."""
    over = os.path.join(OVERLAY, rel)
    return over if os.path.exists(over) else os.path.join(UPSTREAM, rel)


def load_constants():
    merged = {}
    for rel in ("constants/default.json", "constants/portrait.json"):
        path = shell_file(rel)
        if not os.path.exists(path):
            continue
        with open(path) as handle:
            deep_merge(merged, json.load(handle).get("data", {}))
    return merged


def dotted(tree, path):
    node = tree
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def to_number(value):
    """"112dp" -> 112, 112 -> 112, "match" -> None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        match = _UNIT.match(value.strip())
        if match:
            return int(float(match.group(1)))
        if re.match(r"^-?\d+(\.\d+)?$", value.strip()):
            return int(float(value))
    return None


def resolve_scalar(value, constants):
    """One substitution pass over a single string."""
    if not isinstance(value, str):
        return value

    expr = _EXPR.match(value.strip())
    if expr:
        body = _REF.sub(lambda m: str(_lookup(m, constants)), expr.group(1))
        body = re.sub(r"(-?\d+(?:\.\d+)?)(dp|sp|px|pt)\b", r"\1", body)
        if re.match(r"^[\d\s+\-*/().<>=&|!]+$", body):
            try:
                # Arithmetic only -- the regex above admits no names or calls.
                return int(eval(body, {"__builtins__": {}}, {}))  # noqa: S307
            except Exception:
                return value
        return value

    whole = _REF.fullmatch(value.strip())
    if whole:
        return _lookup(whole, constants)
    return _REF.sub(lambda m: str(_lookup(m, constants)), value)


def _lookup(match, constants):
    kind, path = match.group(1), match.group(2)
    if kind == "env":
        return ENV.get(path, match.group(0))
    found = dotted(constants, path)
    return match.group(0) if found is None else found


def resolve(node, constants, depth=0):
    """Resolve references/expressions/units throughout a node tree."""
    if isinstance(node, dict):
        return {k: resolve(v, constants, depth) for k, v in node.items()}
    if isinstance(node, list):
        return [resolve(v, constants, depth) for v in node]
    if isinstance(node, str):
        resolved = resolve_scalar(node, constants)
        # A constant can itself hold a reference; the parser resolves those
        # too. Bounded so a self-referential constant cannot spin.
        if isinstance(resolved, str) and resolved != node and depth < 5:
            return resolve(resolved, constants, depth + 1)
        return resolved
    return node


def numeric_shape(node):
    """Turn the resolved tree into the shape lint.py reads: numbers where a
    number is meant, and the key dropped where it is "match"/"wrap"/a percent
    (lint.py's geometry pass deliberately does not guess those)."""
    if not isinstance(node, dict):
        return node
    out = dict(node)
    for section, keys in (("placement", ("x", "y", "width", "height")),
                          ("style", ("fontSize",))):
        block = out.get(section)
        if not isinstance(block, dict):
            continue
        block = dict(block)
        for key in keys:
            if key not in block:
                continue
            number = to_number(block[key])
            if number is None:
                block.pop(key)
            else:
                block[key] = number
        out[section] = block
    if isinstance(out.get("children"), list):
        out["children"] = [numeric_shape(c) for c in out["children"]]
    return out


def assets():
    """Every shell asset with a node tree, overlay winning over upstream."""
    seen = {}
    for root in (UPSTREAM, OVERLAY):
        for sub in ("screens", "templates"):
            directory = os.path.join(root, sub)
            if not os.path.isdir(directory):
                continue
            for name in sorted(os.listdir(directory)):
                if name.endswith(".json"):
                    seen[sub + "/" + name] = os.path.join(directory, name)
    return sorted(seen.items())


def lint_shell(only=None):
    """-> (overlay_findings, waived, upstream_findings)."""
    constants = load_constants()
    ours, waived, upstream = [], [], []
    for rel, path in assets():
        with open(path) as handle:
            raw = json.load(handle)
        if raw.get("type") not in LINTABLE:
            continue
        tree = raw.get("node") if raw.get("type") == "viewTemplate" else raw
        if not isinstance(tree, dict):
            continue
        resolved = numeric_shape(resolve(copy.deepcopy(tree), constants))
        is_ours = os.path.abspath(OVERLAY) in os.path.abspath(path)
        label = ("overlay:" if is_ours else "upstream:") + rel
        for violation in lint.lint_tree(resolved, file_label=label):
            if only and violation.split(" ")[1] not in only:
                continue
            if is_unknowable(violation):
                continue
            if not is_ours:
                upstream.append(violation)
            elif waiver_for(violation):
                waived.append((violation, waiver_for(violation)))
            else:
                ours.append(violation)
    return ours, waived, upstream


def main():
    argv = sys.argv[1:]
    if "--list" in argv:
        for rel, path in assets():
            print("%-40s %s" % (rel, path))
        return 0
    only = None
    if "--rules" in argv:
        only = set(argv[argv.index("--rules") + 1:])
        unknown = only - set(lint.RULES)
        if unknown:
            print("unknown rule(s): %s" % sorted(unknown), file=sys.stderr)
            return 2
    ours, waived, upstream = lint_shell(only)

    print("== our overlay (gated) ==")
    for violation in ours:
        print(violation)
    if not ours:
        print("clean")
    for violation, reason in waived:
        print("WAIVED " + violation)
        print("       reason: " + reason)

    print("\n== upstream shell (survey, not gated) ==")
    for violation in upstream:
        print(violation)
    if not upstream:
        print("clean")

    print("\n[lint-shell] overlay: %d finding(s), %d waived | upstream: %d "
          "finding(s) | %d asset(s)"
          % (len(ours), len(waived), len(upstream), len(assets())))
    return min(len(ours), 255)


if __name__ == "__main__":
    sys.exit(main())
