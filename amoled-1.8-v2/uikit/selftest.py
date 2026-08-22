#!/usr/bin/env python3
"""Self-test for panelkit.py + lint.py (#208).

Two kinds of check:
  1. Deliberate violations (an 11px label, a 50px button, an absolute child
     under a stack) must raise at generation time -- proving the traps are
     structurally closed, not just documented.
  2. lint.py's structural checks agree with the fixtures: the dirty screen
     in fixtures/ flags exactly the known bad nodes, and racing's live
     home.json (built with panelkit) comes back clean.

The dirty fixture is tunastreet.xviewer's hand-written screen as it shipped
before #198 rebuilt it -- kept here as a frozen copy precisely because the
live file was going to be fixed, and a lint whose only proof is a file
somebody is about to repair has no proof at all.

Run: python3 selftest.py
"""
import os
import sys

import lint
import panelkit as pk
import tokens as tk

HERE = os.path.dirname(os.path.abspath(__file__))
DIRTY_JSON = os.path.join(HERE, "fixtures", "dirty-screen.json")
TAP_UNDER_IMAGE_JSON = os.path.join(HERE, "fixtures", "tap-under-image.json")
RACING_JSON = os.path.join(HERE, "..", "apps", "tunastreet.racing", "res", "screens", "home.json")

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
    """R6: the T-MINUS shape that shipped 2026-08-21 -- a tap zone with a
    decorative image drawn over it. The image defaults to clickable:true in
    the runtime and ate every tap; the fixture freezes both halves, the
    undeclared image and a correctly declared one."""
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

    if _failures:
        print("\nFAILURES:")
        for f in _failures:
            print(" -", f)
        sys.exit(1)
    print("\nall selftests passed")
