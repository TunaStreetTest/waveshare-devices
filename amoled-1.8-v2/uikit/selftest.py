#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Steven Matison
#
# SPDX-License-Identifier: Apache-2.0
"""Self-test for panelkit.py + lint.py.

Two kinds of check:
  1. Deliberate violations (an 11px label, a 50px button, an absolute child
     under a stack) must raise at generation time -- proving the traps are
     structurally closed, not just documented.
  2. lint.py's structural checks agree with the fixtures: the dirty screen
     in fixtures/ flags exactly the known bad nodes, and racing's live
     home.json (built with panelkit) comes back clean.

The dirty fixture is tunastreet.xviewer's hand-written screen as it shipped
before the kit existed -- kept as a frozen copy because the live file was
going to be fixed, and a lint whose only negative proof is a file someone is
about to repair has no negative proof.

Run: python3 selftest.py
"""
import os
import re
import sys

import lint
import panelkit as pk
import tokens as tk

HERE = os.path.dirname(os.path.abspath(__file__))
DIRTY_JSON = os.path.join(HERE, "fixtures", "dirty-screen.json")
TAP_UNDER_IMAGE_JSON = os.path.join(HERE, "fixtures", "tap-under-image.json")
RACING_JSON = os.path.join(HERE, "..", "apps", "tunastreet.racing", "res", "screens", "home.json")
LINT_JS = os.path.join(HERE, "..", "tools", "simulator", "lint.js")
APPS_DIR = os.path.join(HERE, "..", "apps")

_failures = []


def check(name, fn):
    try:
        fn()
    except AssertionError as e:
        _failures.append("%s: %s" % (name, e))
    except Exception as e:
        _failures.append("%s: unexpected %s: %s" % (name, type(e).__name__, e))
    else:
        print("ok   ", name)


def expect_raises(fn, *a, **kw):
    try:
        fn(*a, **kw)
    except ValueError:
        return
    raise AssertionError("expected ValueError, got none")


# ---------------------------------------------------------- deliberate raises
def test_label_below_text_floor():
    expect_raises(pk.label, "t", 0, 0, 100, 20, text="x", role="body", size=11)


def test_label_outside_band():
    # 12 is >= the text floor but not a legal size for role="hero" ([40, 56])
    expect_raises(pk.label, "t", 0, 0, 100, 20, text="x", role="hero", size=12)


def test_button_below_target_height():
    expect_raises(pk.button, "b", 0, 0, 300, 50, "GO", "app.go")


def test_button_above_target_height():
    expect_raises(pk.button, "b", 0, 0, 300, 120, "GO", "app.go")


def test_stack_rejects_absolute_child():
    absolute_child = pk.label("x", 10, 10, 50, 20, text="x")  # x, y given -> absolute
    expect_raises(pk.stack, "s", [absolute_child])


def test_canvas_rejects_flow_child():
    flow_child = pk.label("x", None, None, 50, 20, text="x")  # x=y=None -> flow
    expect_raises(pk.canvas, "c", 0, 0, 100, 100, children=[flow_child])


def test_row_clamps_gap_for_tap_targets():
    a = pk.button("a", None, None, 100, 80, "A", "app.a")
    b = pk.label("b", None, None, 100, 30, text="b")  # not a tap target
    r = pk.row("r", 0, 0, [a, b], gap=4)
    xa = r["children"][0]["placement"]["x"]
    xb = r["children"][1]["placement"]["x"]
    assert xb - xa >= 100 + tk.TARGET_GAP_MIN, (
        "row did not clamp gap to target_gap_min for a row containing a tap target")


# --------------------------------------------------------------- lint fixtures
def test_dirty_fixture_flags_known_bad_nodes():
    violations = lint.lint_file(DIRTY_JSON)
    require_valid_press_sites = set()
    text_floor_sites = set()
    for v in violations:
        node_ref = v.split(" ", 1)[0]     # "<file>:/path/to/node"
        rule = v.split(" ")[1]
        node_id = node_ref.rsplit("/", 1)[-1]
        if rule == "R2" and "requireValidPress" in v:
            require_valid_press_sites.add(node_id)
        if rule == "R3":
            text_floor_sites.add(node_id)
    assert require_valid_press_sites == {"nav_prev", "likebox", "nav_next"}, require_valid_press_sites
    # "likes" is fontSize 15. That was exactly the old floor, so it used to
    # pass; the floor moved to 16 when the compiled Montserrat ladder went into
    # tokens.json (15 has no compiled face and was being drawn at 12), so it is
    # now correctly flagged along with the rest.
    assert text_floor_sites == {"brand", "status", "reposts", "views", "pos", "likes"}, text_floor_sites


def test_undeclared_image_over_tap_zone_is_flagged():
    """R6: a tap zone with a decorative image drawn over it. The image
    defaults to clickable:true in the runtime and consumes every tap. The
    fixture freezes both halves -- the undeclared image and a correctly
    declared one."""
    violations = lint.lint_file(TAP_UNDER_IMAGE_JSON)
    r6 = set()
    for v in violations:
        if v.split(" ")[1] == "R6":
            r6.add(v.split(" ", 1)[0].rsplit("/", 1)[-1])
    assert r6 == {"art_undeclared"}, r6


def test_non_ascii_text_is_flagged():
    """R7: no FreeType on this board, so anything outside ASCII is a white
    box. The frozen dirty screen still carries the old nav glyphs."""
    violations = lint.lint_file(DIRTY_JSON)
    r7 = set()
    for v in violations:
        if v.split(" ")[1] == "R7":
            r7.add(v.split(" ", 1)[0].rsplit("/", 1)[-1])
    assert r7 == {"nav_prev", "nav_next"}, r7


def test_racing_is_clean():
    violations = lint.lint_file(RACING_JSON)
    assert violations == [], violations


# ------------------------------------------------------------- the newer rules
def test_off_ladder_font_size_raises():
    """R8: there is no FreeType and no TinyTTF in this build, so a fontSize is
    not scaled to order -- get_builtin_font() returns an exact match or the
    closest SMALLER compiled face. 18 is between rungs and would be drawn at
    16, silently."""
    expect_raises(pk.label, "t", 0, 0, 100, 30, text="x", role="body", size=18)


def test_label_box_shorter_than_line_height_raises():
    """R9: Montserrat 16 has a real line height of 18px, so a 14px box clips
    descenders. The threshold is the actual .line_height from the compiled
    font, not the ~1.3x a desktop habit assumes."""
    expect_raises(pk.label, "t", 0, 0, 100, 14, text="x", role="body", size=16)


def test_corner_text_is_flagged_by_screen():
    """R10: the glass is a rounded rectangle. A left-aligned label at the
    normal 16px edge inset but only 2px down sits inside the corner arc --
    x-viewer's 'n/N' counter, reported twice before it was computed rather
    than eyeballed. screen() lints the assembled tree, which is where the
    absolute position is finally known, so this is caught at generation."""
    corner = pk.label("counter", 16, 2, 60, 20, text="3/8", role="body", align="left")
    expect_raises(pk.screen, "s", [corner])


def test_r5_uses_absolute_coordinates():
    """A child's placement.x is relative to its parent, so a box only escapes
    the panel once the ancestor offsets are added in. Checking the raw x/y
    (which is what this lint did before) both misses real escapes and invents
    fake ones."""
    inner = pk.label("inner", 300, 0, 60, 20, text="x", role="body")
    outer = pk.canvas("outer", 40, 100, 328, 40, children=[inner])
    violations = lint.lint_tree({"type": "viewScreen", "id": "s", "children": [outer]}, "t")
    r5 = [v for v in violations if " R5 " in v]
    assert len(r5) == 1 and "inner" in r5[0], r5
    assert "(340,100,60,20)" in r5[0], "R5 did not add the parent offset: %s" % r5


# ------------------------------------------------------ parity with the JS twin
def test_rule_ids_match_lint_js():
    """The kit ships two linters: this one gates *generation*, and
    tools/simulator/lint.js gates the *flash*. They read the same tokens.json
    and must implement the same rule numbers -- if they drift, a generator
    passes its own gate and fails later, or (worse) passes both and fails on
    the glass. R0 is lint.js-only: it is a dynamic reachability check that
    needs a booted app, and has no structural twin."""
    assert os.path.exists(LINT_JS), "missing " + LINT_JS
    js = open(LINT_JS).read()
    js_rules = set(re.findall(r'"(R\d+)"', js)) - {"R0"}
    py_rules = set(re.findall(r'"(R\d+)"', open(os.path.join(HERE, "lint.py")).read()))
    assert py_rules == set(lint.RULES), (
        "lint.py's RULES table disagrees with the rules it actually reports: %s"
        % (py_rules ^ set(lint.RULES)))
    assert js_rules == py_rules, (
        "lint.py and lint.js implement different rule sets: only in JS %s, "
        "only in Python %s" % (sorted(js_rules - py_rules), sorted(py_rules - js_rules)))


def test_shipped_apps_are_clean():
    """Every app currently on the glass passes the full rule set. This is what
    makes the additions above a strengthening rather than a rewrite: they
    found nothing in code that was already believed good."""
    dirty = {}
    for app in sorted(os.listdir(APPS_DIR)):
        screens = os.path.join(APPS_DIR, app, "res", "screens")
        if not os.path.isdir(screens):
            continue
        for name in sorted(os.listdir(screens)):
            if not name.endswith(".json"):
                continue
            v = lint.lint_file(os.path.join(screens, name))
            if v:
                dirty[app + "/" + name] = v
    assert not dirty, dirty


if __name__ == "__main__":
    check("label below text floor raises", test_label_below_text_floor)
    check("label outside role band raises", test_label_outside_band)
    check("button below target height raises", test_button_below_target_height)
    check("button above target height raises", test_button_above_target_height)
    check("stack() rejects absolute child", test_stack_rejects_absolute_child)
    check("canvas() rejects flow child", test_canvas_rejects_flow_child)
    check("row() clamps gap for tap targets", test_row_clamps_gap_for_tap_targets)
    check("dirty fixture flags exactly the known bad nodes", test_dirty_fixture_flags_known_bad_nodes)
    check("undeclared image over a tap zone raises R6", test_undeclared_image_over_tap_zone_is_flagged)
    check("non-ASCII label text raises R7", test_non_ascii_text_is_flagged)
    check("racing.json lints clean", test_racing_is_clean)
    check("off-ladder fontSize raises (R8)", test_off_ladder_font_size_raises)
    check("label box under the line height raises (R9)", test_label_box_shorter_than_line_height_raises)
    check("text in the rounded corner raises (R10)", test_corner_text_is_flagged_by_screen)
    check("R5 uses absolute, not parent-relative, coordinates", test_r5_uses_absolute_coordinates)
    check("lint.py and lint.js implement the same rules", test_rule_ids_match_lint_js)
    check("every shipped app lints clean", test_shipped_apps_are_clean)

    if _failures:
        print("\nFAILURES:")
        for f in _failures:
            print(" -", f)
        sys.exit(1)
    print("\nall selftests passed")
