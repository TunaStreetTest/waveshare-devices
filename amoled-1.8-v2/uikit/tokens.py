#!/usr/bin/env python3
"""Loader for uikit/tokens.json -- the single source of truth for sizing,
colour and trap policy on the Waveshare ESP32-S3-Touch-AMOLED-1.8 V2 (#208).

Why a loader instead of just writing these as Python literals: tokens.json has
a second reader -- tools/simulator/lint.js, a sibling agent's JS pre-flash
check. Two readers, one file. If a number needs to change, it changes in
tokens.json or nowhere; this module never redefines or forks a value, it only
exposes what's already there.
"""
import json
import os

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tokens.json")
with open(_PATH) as _f:
    _T = json.load(_f)

DEVICE = _T["device"]
W = DEVICE["width"]
H = DEVICE["height"]

TEXT = _T["text"]
TEXT_FLOOR = TEXT["floor"]              # 16 -- hard floor, not a suggestion (#205)
FONT_LADDER = tuple(TEXT["font_ladder"])  # the only sizes the board can draw
LINE_HEIGHT = {int(k): v for k, v in TEXT["line_height"].items()}
TEXT_BANDS = TEXT["bands"]              # role -> [min, max] fontSize

TOUCH = _T["touch"]
TARGET_H_MIN = TOUCH["target_h_min"]    # 76
TARGET_H_MAX = TOUCH["target_h_max"]    # 88
TARGET_GAP_MIN = TOUCH["target_gap_min"]  # 40
TARGET_W_FULL = TOUCH["target_w_full"]  # 320

SAFE = _T["safe_area"]
CORNER_RADIUS = SAFE["corner_radius"]


def corner_inset(d):
    """Horizontal inset the rounded glass demands at `d` px from the top or
    bottom edge. 0 once you are past the corner arc.

    The panel is a rounded rectangle: near the edges the usable width is less
    than the nominal 368, so a label at the normal 16px edge inset but only a
    couple of pixels down sits inside the curve.
    """
    import math
    r = CORNER_RADIUS
    if d >= r or d < 0:
        return 0
    return int(math.ceil(r - math.sqrt(max(0.0, r * r - (r - d) * (r - d)))))


SPACE = _T["space"]
EDGE = SPACE["edge"]                    # 16
ROW = SPACE["row"]                      # 12
SECTION = SPACE["section"]              # 24
RADIUS = SPACE["radius"]                # 12

COLOR = _T["color"]
BG = COLOR["bg"]
INK = COLOR["ink"]
MUTED = COLOR["muted"]
DARK = COLOR["dark"]
ORANGE = COLOR["orange"]
GREEN = COLOR["green"]
RED = COLOR["red"]
AMBER = COLOR["amber"]
PINK = COLOR["pink"]
GOLD = COLOR["gold"]
SILVER = COLOR["silver"]
BRONZE = COLOR["bronze"]

TRAPS = _T["traps"]
CONTAINER_LAYOUT = TRAPS["container_layout"]            # "none"
CONTAINER_SCROLLABLE = TRAPS["container_scrollable"]    # False
CONTAINER_PRESS_LOCK = TRAPS["container_press_lock"]    # True
TAP_EVENTS = tuple(TRAPS["tap_events"])                  # ("pressed", "released")
FORBID_REQUIRE_VALID_PRESS = TRAPS["forbid_require_valid_press"]


def band(role):
    """(min, max) fontSize for a text role. Unknown role -> KeyError listing
    the real ones, so a typo fails loud at generation time, not on the glass."""
    try:
        return tuple(TEXT_BANDS[role])
    except KeyError:
        raise KeyError("unknown text role %r -- have: %s" % (role, sorted(TEXT_BANDS)))


def default_size(role):
    """A role's default fontSize: the band floor -- the smallest size that
    still reads as that role. Callers that want the band ceiling pass size
    explicitly."""
    return band(role)[0]


def check_size(role, size):
    """Raise if `size` is not a legal fontSize for `role`. Below the absolute
    text floor is always illegal, even for a role whose band floor is lower
    (none currently are, but the floor check is unconditional on purpose)."""
    if size < TEXT_FLOOR:
        raise ValueError(
            "fontSize %d is below the text floor (%d) -- unreadable at arm's "
            "length on this panel, see tokens.json text.note" % (size, TEXT_FLOOR))
    lo, hi = band(role)
    if not (lo <= size <= hi):
        raise ValueError(
            "fontSize %d is outside the %r band [%d, %d]" % (size, role, lo, hi))
    if size not in FONT_LADDER:
        # There is no FreeType/TinyTTF on this build, so a size is not scaled to
        # order -- get_builtin_font() returns the closest SMALLER compiled face.
        # An off-ladder size renders silently smaller than it reads here.
        drawn = max([r for r in FONT_LADDER if r < size], default=None)
        raise ValueError(
            "fontSize %d is not a compiled Montserrat size -- it would render at "
            "%s. Use one of: %s (tokens.json text.font_ladder)"
            % (size,
               ("%dpx" % drawn) if drawn else "the LVGL default",
               ", ".join(str(r) for r in FONT_LADDER)))


def check_target_height(h):
    """Raise if `h` is not a legal tap-target height (#205: 50-56px tall
    buttons 10px apart read as one blob and caused mis-taps)."""
    if not (TARGET_H_MIN <= h <= TARGET_H_MAX):
        raise ValueError(
            "tap target height %d is outside [%d, %d] -- see tokens.json "
            "touch.note" % (h, TARGET_H_MIN, TARGET_H_MAX))
