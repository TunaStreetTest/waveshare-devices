#!/usr/bin/env python3
"""UI primitives for JSON-UI screens on the AMOLED 1.8 V2 (#208).

Every function here returns a JSON-UI node dict in the exact shape the
ESP-Brookesia `SystemGui` runtime expects. They exist because two structural
mistakes each cost a flash cycle in #205, and documenting "don't do that" in a
comment was not enough to stop a fresh session from doing it again:

  Trap 1 -- a container with layout.type flex/grid lays out its own children
  and silently overrides any absolute x/y they carry. A screen built this way
  renders near-blank: the nodes exist, LVGL just put them somewhere else.
  Closed here by `canvas()` always emitting layout:{"type":"none"} and
  refusing a flow-placed child, and by `stack()` refusing an absolute-placed
  child -- whichever container you reach for, the wrong kind of child raises
  at generation time instead of rendering wrong on the glass.

  Trap 2 -- `container` defaults to scrollable:true, so a press that drifts a
  few px turns into a scroll and the tap is dropped; `requireValidPress:true`
  on a `clicked` event does the same thing for a different reason (it discards
  a tap the finger drifted through). Closed here by never exposing scrollable,
  pressLock or requireValidPress as parameters at all -- every primitive that
  can take a tap hardcodes scrollable:false, pressLock:true, and fires on
  pressed+released. There is no code path in this module that can emit
  requireValidPress or a scrollable container.

Sizing is enforced against uikit/tokens.json, not re-guessed per screen:
label() checks its fontSize against the role's band (and the absolute text
floor); button() checks its height against the tap-target band. An app that
tries to ship an 11px label or a 50px button gets a Python exception, not a
flash cycle that "looks fine in the editor" and is unreadable on the panel.

lint.py re-checks the same rules structurally (for hand-written JSON that
didn't go through this module, e.g. res/screens/home.json built by another
tool) and screen() calls it on the assembled tree before returning, so a
screen built with panelkit is linted the moment it's built -- not just at
flash time, and not only when someone remembers to run lint.py by hand.
"""
import tokens as tk
import lint

NONE_LAYOUT = {"type": "none"}


# --------------------------------------------------------------- internals
def _flow_layout(direction, main_align, cross_align, gap):
    return {
        "type": "flex",
        "flexFlow": "row" if direction == "row" else "column",
        "mainAlign": main_align,
        "crossAlign": cross_align,
        "gap": gap,
    }


def _apply_hidden_binding(bindings, hidden):
    b = dict(bindings or {})
    if hidden:
        b["commonProps.hidden"] = hidden
    return b


def _placement(x, y, w, h):
    """Absolute placement dict, or (x=None, y=None) a flow placement with no
    x/y at all -- for a node built to be dropped into row()/stack() before
    its final position is known."""
    if x is None and y is None:
        return {"mode": "flow", "width": w, "height": h}
    return {"mode": "absolute", "x": x, "y": y, "width": w, "height": h}


def _tap_events(action):
    """Trap 2, closed: the only event shape a tap target in this module can
    ever emit. pressed AND released both fire the same action -- pressed for
    an instant/responsive feel, released as the catch-all if pressed was
    somehow swallowed upstream. Nothing here can become `clicked` +
    requireValidPress."""
    return [
        {"type": "pressed", "effects": [{"type": "emitAction", "action": action}]},
        {"type": "released", "effects": [{"type": "emitAction", "action": action}]},
    ]


# ------------------------------------------------------------------ screen
def screen(id, children, bg=tk.BG):
    """The root viewScreen. layout/scrollable/pressLock are not parameters --
    a screen is always non-scrolling, absolute-rooted and press-locked.

    Lints the assembled tree before returning (R1/R4/R5 are structural checks
    over the whole tree, not something a single primitive call can catch) and
    raises if anything violates -- a bad screen can't be written to disk.
    """
    n = {
        "type": "viewScreen", "id": id,
        "style": {"bgColor": bg, "padding": 0},
        "layout": NONE_LAYOUT,
        "commonProps": {"scrollable": False, "pressLock": True, "clickable": True},
        "children": children,
    }
    violations = lint.lint_tree(n, file_label=id)
    if violations:
        raise ValueError("screen %r failed lint:\n%s" % (id, "\n".join(violations)))
    return n


# ---------------------------------------------------------------- canvas
def canvas(id, x, y, w, h, bg=tk.BG, radius=0, children=None, bindings=None,
           click=None, hidden=None, clickable=None):
    """Absolute-placement container -- the workhorse for a device this small,
    where every panel is hand-laid-out pixels, not flowed text.

    Always emits layout:{"type":"none"}, scrollable:false, pressLock:true
    (trap 1 and trap 2, closed unconditionally -- there's no parameter that
    turns them back on). Rejects a child in flow placement, because a flow
    child under a none-layout parent just sits wherever it was given no
    coordinates to sit at.

    x=None (y must also be None) leaves this canvas itself flow-placed --
    for building a canvas meant to be dropped into row()/stack() before its
    own final position is known -- but its children are still required to be
    absolute, since its own layout is (and always is) "none".
    """
    children = children or []
    for c in children:
        if c.get("placement", {}).get("mode") == "flow":
            raise ValueError(
                "canvas %r: child %r is flow-placed -- flow placement only "
                "means something under stack(), not under an absolute "
                "canvas()" % (id, c.get("id")))
    n = {
        "type": "container", "id": id,
        "placement": _placement(x, y, w, h),
        "layout": NONE_LAYOUT,
        "style": {"bgColor": bg, "padding": 0, "radius": radius},
        "commonProps": {"scrollable": False, "pressLock": True,
                        "clickable": bool(click) if clickable is None else clickable},
        "children": children,
    }
    b = _apply_hidden_binding(bindings, hidden)
    if b:
        n["bindings"] = b
    if click:
        n["events"] = _tap_events(click)
    return n


# ----------------------------------------------------------------- stack
def stack(id, children, direction="column", gap=tk.ROW, main_align="start",
          cross_align="center", bg=tk.BG, padding=0, clickable=False,
          bindings=None, click=None, hidden=None):
    """Flex/flow container -- for content whose length isn't known up front
    (a feed post, a scrolling list). This is the xviewer shape.

    Always flow-places its children (adds/overwrites placement.mode:"flow" on
    each), and raises if a child already carries placement.mode:"absolute" --
    that's trap 1 from the other direction: an absolute child under a flex
    parent doesn't render where its x/y says, the parent's flex box decides.
    A child with no placement at all (sized by content, xviewer's own `likes`/
    `reposts` style) is left alone.
    """
    children = children or []
    for c in children:
        p = c.get("placement")
        if p is not None:
            if p.get("mode") == "absolute":
                raise ValueError(
                    "stack %r: child %r is absolute-placed -- that's trap 1, "
                    "use canvas() for absolute layout, not stack()"
                    % (id, c.get("id")))
            p["mode"] = "flow"
    n = {
        "type": "container", "id": id,
        "style": {"bgColor": bg, "padding": padding},
        "commonProps": {"scrollable": False, "clickable": clickable},
        "layout": _flow_layout(direction, main_align, cross_align, gap),
        "children": children,
    }
    b = _apply_hidden_binding(bindings, hidden)
    if b:
        n["bindings"] = b
    if click:
        n["events"] = _tap_events(click)
    return n


# ----------------------------------------------------------------- label
def label(id, x, y, w, h, text="", role="body", color=tk.INK, align="center",
          size=None, bindings=None, click=None, hidden=None):
    """A text node. `size` defaults to the role's band floor; an explicit
    size outside the band raises, and anything under the absolute text floor
    (15px) raises regardless of role -- #205 shipped 11px labels that were
    unreadable at arm's length.

    x=None (y must also be None) builds a flow-placed label for use as a
    stack() child instead of a canvas() child.
    """
    if size is None:
        size = tk.default_size(role)
    tk.check_size(role, size)

    if x is None and y is None:
        placement = {"mode": "flow", "width": w, "height": h}
        n = {"type": "label", "id": id, "placement": placement,
             "style": {"textColor": color, "fontSize": size, "textAlign": align},
             "labelProps": {"text": text}}
    else:
        n = {"type": "label", "id": id,
             "placement": {"mode": "absolute", "x": x, "y": y, "width": w, "height": h},
             "layout": NONE_LAYOUT,
             "style": {"textColor": color, "fontSize": size, "textAlign": align},
             "labelProps": {"text": text}}

    b = _apply_hidden_binding(bindings, hidden)
    if b:
        n["bindings"] = b
    if click:
        n["commonProps"] = {"clickable": True}
        n["events"] = _tap_events(click)
    return n


# ---------------------------------------------------------------- button
def button(id, x, y, w, h, text, action, bg=tk.ORANGE, fg=tk.BG, size=None,
           radius=tk.RADIUS, bindings=None, hidden=None):
    """A big tap target: the label fills the box so the whole slab is the
    button. Height must fall in [touch.target_h_min, touch.target_h_max] --
    #205 shipped 50-56px buttons 10px apart that read as one blob.

    There is no code path in this function that can produce a `clicked`
    event or requireValidPress: it always goes through canvas()'s click=,
    which is pressed+released only.
    """
    tk.check_target_height(h)
    if size is None:
        size = tk.default_size("value")
    label_h = size + 8
    return canvas(id, x, y, w, h, bg=bg, radius=radius, click=action,
                  bindings=bindings, hidden=hidden, children=[
                      label(id + "_t", 0, (h - label_h) // 2, w, label_h,
                            text=text, role="value", color=fg, size=size)])


# ------------------------------------------------------------------- row
def row(id, x, y, items, gap=None, h=None):
    """Lay `items` (already-built flow-mode node dicts -- from label()/
    button()/tile() called with x=y=None) out left to right from (x, y),
    computing each item's x from cumulative width + gap. Still absolute
    underneath: row() is a layout-time convenience, not a runtime flex box.

    If any item carries `events` (a tap target) the gap is clamped up to
    touch.target_gap_min (40) for the whole row -- #205's 10px-apart buttons
    read as one blob no matter how the row was assembled.
    """
    if gap is None:
        gap = tk.ROW
    if any("events" in it for it in items):
        gap = max(gap, tk.TARGET_GAP_MIN)

    # Child coordinates are relative to their immediate parent container (see
    # e.g. racing's c_bar / c_brand), so items are placed from a local origin
    # (0, 0) inside the wrapping canvas below -- not from the screen-absolute
    # (x, y) this row itself sits at.
    placed = []
    cx = 0
    for it in items:
        p = it.get("placement", {})
        iw, ih = p.get("width"), p.get("height")
        if iw is None:
            raise ValueError("row %r: item %r has no width to place with" % (id, it.get("id")))
        item_h = h if h is not None else ih
        it["placement"] = {"mode": "absolute", "x": cx, "y": 0, "width": iw, "height": item_h}
        it["layout"] = NONE_LAYOUT
        placed.append(it)
        cx += iw + gap

    # row()'s items are already placed and self-contained; the wrapping
    # canvas is just a bookkeeping id, not another bgColor'd box on top.
    total_w = max(p["placement"]["x"] + p["placement"]["width"] for p in placed)
    total_h = h if h is not None else max(p["placement"]["height"] for p in placed)
    return canvas(id, x, y, total_w, total_h, bg=tk.BG, clickable=False, children=placed)


# --------------------------------------------------------------- stat_bar
def stat_bar(id, x, y, w, stats, value_h=None, caption_h=None):
    """Footer-role captions over value-role numbers -- racing's HUD shape and
    the agent app's heartbeat/processor-count/metrics row. `stats` is a list
    of {"id", "caption", "value", "color"} dicts, laid out in equal columns.
    """
    caption_h = caption_h or (tk.band("footer")[1] + 4)
    value_h = value_h or (tk.default_size("value") + 8)
    n = len(stats)
    gap = tk.ROW
    col_w = (w - gap * (n - 1)) // n
    children = []
    cx = 0  # relative to the wrapping canvas below, not screen-absolute
    for s in stats:
        children.append(label(s["id"] + "_cap", cx, 0, col_w, caption_h,
                               text=s.get("caption", ""), role="footer",
                               color=s.get("cap_color", tk.MUTED)))
        children.append(label(s["id"], cx, caption_h, col_w, value_h,
                               text=str(s.get("value", "")), role="value",
                               color=s.get("color", tk.INK)))
        cx += col_w + gap
    return canvas(id, x, y, w, caption_h + value_h, bg=tk.BG, clickable=False,
                  children=children)


# --------------------------------------------------------------- tool_bar
def tool_bar(id, x, y, w, items, h=None):
    """Bottom bar of big tap targets (#198: LIKE heart, views, comments,
    clear). Tappable items go through button()'s contract (pressed/released
    only, target-height floor) and are spaced >= touch.target_gap_min apart.
    An item flagged compact=True is a pure readout (a count, not a target):
    it's exempt from the height floor, but never from the text floor.

    Each item: {"id", "text", "action"(optional), "image"(optional src),
    "caption"(optional, shown under an image), "compact"(optional bool),
    "w"(optional explicit width), "color"(optional)}.

    An item with "image" is a glyph target: the system font has no heart or
    icon glyphs, so anything pictorial on this panel is a PNG in the app's
    imageSet, not a character. It still gets the full tap contract -- the
    whole slab presses, not just the picture.
    """
    h = h or tk.TARGET_H_MIN
    gap = tk.TARGET_GAP_MIN
    n = len(items)
    default_w = (w - gap * (n - 1)) // n
    children = []
    cx = 0  # relative to the wrapping canvas below, not screen-absolute
    for it in items:
        iw = it.get("w", default_w)
        if it.get("image"):
            cap = it.get("caption")
            img_h = h - 26 if cap else h - 12
            img_w = min(iw - 12, img_h)
            kids = [sprite(it["id"] + "_img", (iw - img_w) // 2, 6, img_w, img_h,
                           it["image"], bindings=it.get("image_bindings"))]
            if cap is not None:
                kids.append(label(it["id"] + "_c", 0, h - 22, iw, 20, text=cap,
                                  role="footer", color=it.get("color", tk.MUTED),
                                  bindings=it.get("caption_bindings")))
            children.append(canvas(it["id"], cx, 0, iw, h,
                                   bg=it.get("bg", tk.DARK), radius=tk.RADIUS,
                                   click=it.get("action"), children=kids,
                                   bindings=it.get("bindings")))
        elif it.get("compact"):
            children.append(label(it["id"], cx, 0, iw, h, text=it.get("text", ""),
                                   role="body", color=it.get("color", tk.MUTED),
                                   bindings=it.get("bindings")))
        else:
            children.append(button(it["id"], cx, 0, iw, h, it.get("text", ""),
                                    it["action"], bg=it.get("bg", tk.ORANGE),
                                    fg=it.get("fg", tk.BG),
                                    bindings=it.get("bindings")))
        cx += iw + gap
    return canvas(id, x, y, w, h, bg=tk.BG, clickable=False, children=children)


# ------------------------------------------------------------------- tile
def tile(id, x, y, w, h, image, title, subtitle, action, title_color=tk.INK,
         subtitle_color=tk.MUTED, bg=tk.DARK, radius=tk.RADIUS, img_pad=None,
         img_w=None, img_h=None, text_gap=None, title_y=None, title_size=None,
         subtitle_size=None, bindings=None, hidden=None):
    """Big image + two-line text tap target -- racing's car-select bars
    generalised (c_a/c_b in home.json). The whole box is the tap target.

    Layout defaults auto-centre the image vertically and stack title over
    subtitle with no gap between them; pass title_y explicitly to pin an
    exact legacy pixel position (used by the racing migration to reproduce
    home.json byte-for-byte).
    """
    img_pad = tk.SPACE["row"] if img_pad is None else img_pad
    img_h = img_h or (h - 2 * img_pad)
    img_w = img_w or img_h
    text_gap = tk.SPACE["row"] + 2 if text_gap is None else text_gap
    text_x = img_pad + img_w + text_gap
    text_w = w - text_x - tk.SPACE["row"]

    title_size = title_size or tk.default_size("value")
    subtitle_size = subtitle_size or tk.default_size("body")
    title_h = title_size + 8
    subtitle_h = subtitle_size + 8
    if title_y is None:
        title_y = (h - title_h - subtitle_h) // 2

    children = [
        sprite(id + "_img", img_pad, (h - img_h) // 2, img_w, img_h, image),
        label(id + "_t", text_x, title_y, text_w, title_h, text=title,
              role="value", color=title_color, align="left", size=title_size),
        label(id + "_s", text_x, title_y + title_h, text_w, subtitle_h,
              text=subtitle, role="body", color=subtitle_color, align="left",
              size=subtitle_size),
    ]
    return canvas(id, x, y, w, h, bg=bg, radius=radius, click=action,
                  bindings=bindings, hidden=hidden, children=children)


# ------------------------------------------------------------- sprite/image
def sprite(id, x, y, w, h, src, align="contain", clickable=None,
           bindings=None, hidden=None):
    """An image node bound to a runtime src key (e.g. "${image.car_corolla}").
    `clickable` is left unset (no commonProps at all) by default, matching a
    purely decorative image inside a tappable parent; pass clickable=False
    explicitly for a sprite whose hidden/position is runtime-bound (racing's
    obstacles/car), which is the shape the runtime binder expects even though
    the node itself never receives a tap.
    """
    n = {"type": "image", "id": id,
         "placement": {"mode": "absolute", "x": x, "y": y, "width": w, "height": h},
         "layout": NONE_LAYOUT}
    if clickable is not None:
        n["commonProps"] = {"clickable": clickable}
    n["imageProps"] = {"src": src, "innerAlign": align}
    b = _apply_hidden_binding(bindings, hidden)
    if b:
        n["bindings"] = b
    return n


# image() is the same node type as sprite(); kept as an alias so call sites
# can say whichever reads better (a still photo vs. a moving game sprite).
image = sprite
