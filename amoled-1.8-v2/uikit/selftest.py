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
    assert text_floor_sites == {"brand", "status", "reposts", "views", "pos"}, text_floor_sites


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
    check("racing.json lints clean", test_racing_is_clean)

    if _failures:
        print("\nFAILURES:")
        for f in _failures:
            print(" -", f)
        sys.exit(1)
    print("\nall selftests passed")
