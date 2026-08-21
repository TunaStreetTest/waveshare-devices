# panelkit

UI Developer Kit for JSON-UI screens on the Waveshare ESP32-S3-Touch-AMOLED-1.8
V2 (#208): 368x448 portrait, ESP-Brookesia v0.8 runtime apps whose UI is a
`res/screens/home.json` tree mutated at runtime by a `SystemGui` service.

## Why this exists

"Out of the box claude fails largely on text sizing. A nice framework should
allow us to make use of every pixel and to morph traditional UI patterns into
something useable at this scale." (#208)

Two mistakes cost a flash cycle each, in #205, before this kit existed:

1. A container with `layout.type: "flex"` (or `"grid"`) lays out its own
   children -- it silently overrides any absolute `x`/`y` they carry. A
   screen built this way renders near-blank: every node is really there, LVGL
   just puts them somewhere else.
2. `container` defaults to `scrollable: true`, so a press that drifts a few
   px turns into a scroll and the tap is lost -- "the button wants to slide,
   not take the press." `requireValidPress: true` on a `clicked` event drops
   the same drifted tap for a related reason.

Writing "don't do that" in a comment did not stop a fresh session from doing
it again. So this kit makes both mistakes a `ValueError` at generation time
instead of a rendering bug on the glass:

- `canvas()` (absolute layout) always emits `layout:{"type":"none"}`,
  `scrollable:false`, `pressLock:true`, and raises if a child is flow-placed.
- `stack()` (flex layout) always flow-places its children and raises if a
  child is absolute-placed.
- `button()`/`canvas()`'s tap contract can only ever emit `pressed` +
  `released`. There is no parameter, anywhere in this module, that produces
  `requireValidPress` or turns `scrollable`/`pressLock` back to their
  dangerous defaults.
- `label()` checks its `fontSize` against its role's band in `tokens.json`,
  and against the absolute text floor, unconditionally. `button()` checks its
  height against the tap-target band the same way.

`lint.py` re-checks the same five rules *structurally*, by walking a
`screen.json` tree -- for a screen that didn't go through this module (the
counter-example it's calibrated against, `apps/tunastreet.xviewer`, predates
panelkit and was hand-written). `panelkit.screen()` calls it on the finished
tree before returning, so a screen built with the kit is linted the moment
it's built, not just at flash time.

## Token rationale (tokens.json)

Every number in `tokens.json` was measured on the glass during #205 -- none
of it is invented, and this module never redefines or forks a value; a
number changes in `tokens.json` or nowhere. `tokens.json` has a second
reader — `tools/simulator/lint.js`, the harness's pre-flash check — so it
stays framework-agnostic JSON rather than Python.

- **Text floor 15px.** #205 shipped 11px labels that were unreadable at
  arm's length. At 368x448 viewed the way this device actually gets held,
  desktop-scale text sizing runs at roughly half of what actually works.
  Bands above the floor: `footer` 15-16, `body` 16-22, `value` 24-40,
  `hero` 40-56 -- caption/body copy/big numbers/hero numerals, in that
  order of visual weight.
- **Tap target height 76-88px.** #205 shipped 50-56px buttons 10px apart
  that read as one blob and mis-fired. In-game controls are full-height
  thirds instead -- the token note's phrase for this is "target the outcome,
  not the control": a control that fills its whole hit region needs no gap
  at all, because there's no ambiguous sliver between it and its neighbour.
- **Tap target gap 40px minimum.** The failure mode this guards against is
  two *separate*, similarly-sized controls close enough together that a
  slightly-off tap is ambiguous. It does not apply to controls that already
  tile a region edge-to-edge (racing's three lane zones, 0px apart by
  design) or to a control well above the tap-target band (racing's
  336x92px car-select tiles) -- see `lint.py`'s R4 for the exact gating.

## The two traps, closed at the API

| Trap | Old failure mode | Closed by |
|---|---|---|
| 1: flex overrides absolute | screen renders near-blank | `canvas()` always `layout:none`, rejects flow children; `stack()` always flow, rejects absolute children |
| 2: scroll/requireValidPress eats the tap | button "wants to slide, not take the press" | every tap-capable primitive hardcodes `scrollable:false`, `pressLock:true`, fires `pressed`+`released` only -- no parameter re-opens either door |

## Primitives (`panelkit.py`)

- `screen(id, children, bg=BG)` -- root `viewScreen`.
- `canvas(id, x, y, w, h, ...)` -- absolute container. Trap 1 and 2 closed
  unconditionally.
- `stack(id, children, direction=, gap=, main_align=, cross_align=, ...)` --
  flex/flow container, for content whose length isn't known up front (a feed
  post, a scrolling list). Not used by racing (every racing panel is
  hand-laid-out absolute pixels); it's the shape `tunastreet.xviewer` is
  written in by hand today and the shape a future migration of that app
  would use.
- `label(id, x, y, w, h, text=, role=, color=, align=, size=, ...)` -- `x=None,
  y=None` builds a flow-placed label for a `stack()`/`row()` child instead of
  a `canvas()` child.
- `button(id, x, y, w, h, text, action, ...)` -- height-checked tap target.
- `row(id, x, y, items, gap=None, h=None)` -- lays out already-built
  flow-mode items (from `label()`/`button()`/`tile()` called with
  `x=y=None`) left to right, computing each item's `x` from cumulative
  width + gap; clamps the gap to `touch.target_gap_min` if any item is a tap
  target.
- `stat_bar(id, x, y, w, stats)` -- footer-role captions over value-role
  numbers, equal columns (a metrics/heartbeat row).
- `tool_bar(id, x, y, w, items)` -- bottom bar of big tap targets (#198:
  like/views/comments/clear); an item flagged `compact=True` is a readout, not
  a target -- exempt from the height floor, never from the text floor.
- `tile(id, x, y, w, h, image, title, subtitle, action, ...)` -- big
  image + two lines of text, whole box tappable (racing's car-select bars,
  generalised).
- `sprite(id, x, y, w, h, src, ...)` / `image(...)` (alias) -- an image node
  bound to a runtime `src` key.

`bindings` and `hidden` work the same way on every primitive: `hidden="key"`
adds a `commonProps.hidden` binding to `key`; `bindings={...}` merges in
whatever other runtime bindings the app needs (the app mutates the tree by
binding key at runtime, same as the original racing generator).

## Worked example

```python
import panelkit as pk

hud = pk.stat_bar("hud", 8, 4, 352, [
    {"id": "hb_beat", "caption": "HEARTBEAT", "value": "12s", "color": pk.tk.GREEN},
    {"id": "hb_proc", "caption": "PROCESSORS", "value": "7", "color": pk.tk.INK},
    {"id": "hb_err", "caption": "ERRORS", "value": "0", "color": pk.tk.RED},
])

action_bar = pk.tool_bar("actions", 8, 356, 352, [
    # Pictorial targets are PNGs from the app's imageSet, never characters --
    # the system font (Telex-Regular) has no heart or icon glyphs.
    {"id": "ab_like", "image": "${image.heart_off}", "caption": "0",
     "action": "app.like", "image_bindings": {"imageProps.src": "heartSrc"}},
    {"id": "ab_views", "text": "1.2k", "compact": True},
    {"id": "ab_clear", "text": "CLEAR", "action": "app.clear"},
])

home = pk.screen("home", [hud, action_bar])
```

Try building a label at 11px, or `action_bar`'s CLEAR button at 50px tall, or
dropping an absolute-placed child into a `stack()` -- each raises
immediately instead of shipping to a flash cycle. `selftest.py` exercises
exactly those three cases.

## Lint (`lint.py`)

Standalone: `python3 lint.py <screen.json> [...]`. Five rules, one line per
violation (`file:/node/path RULE message`), non-zero exit on any violation:

- **R1** trap 1 -- a flex/grid container with an absolute-placed child.
- **R2** trap 2 -- `requireValidPress:true` anywhere; a real tap target
  (an event of type `pressed`/`released`/`pressing`/`clicked`) missing
  `pressLock:true` or with `scrollable` not `false`. (A screen-level
  `gesture` listener isn't a tap target and isn't held to this.)
- **R3** text floor -- any label under 15px.
- **R4** target spacing -- two sibling tap targets, each at or under the
  tap-target height band, closer than 40px.
- **R5** off-panel -- any absolute node (whose position isn't itself
  runtime-bound) whose box escapes 368x448.

## Self-test

`python3 selftest.py` checks two things: that the three deliberate
violations above actually raise, and that `lint.py` agrees with both
fixtures --

```
$ python3 lint.py ../apps/tunastreet.xviewer/res/screens/home.json
.../home.json:/bar/nav_prev/nav_prev R2 requireValidPress:true drops a tap the finger drifted through (trap 2)
.../home.json:/bar/nav_prev/nav_prev R2 has events but commonProps.pressLock is not true (trap 2: a drifted press can be lost)
.../home.json:/bar/likebox/likebox R2 requireValidPress:true drops a tap the finger drifted through (trap 2)
.../home.json:/bar/likebox/likebox R2 has events but commonProps.pressLock is not true (trap 2: a drifted press can be lost)
.../home.json:/bar/nav_next/nav_next R2 requireValidPress:true drops a tap the finger drifted through (trap 2)
.../home.json:/bar/nav_next/nav_next R2 has events but commonProps.pressLock is not true (trap 2: a drifted press can be lost)
.../home.json:/brand/brand R3 fontSize 14 is below the text floor (15)
.../home.json:/status/status R3 fontSize 12 is below the text floor (15)
.../home.json:/bar/reposts/reposts R3 fontSize 13 is below the text floor (15)
.../home.json:/bar/views/views R3 fontSize 13 is below the text floor (15)
.../home.json:/bar/pos/pos R3 fontSize 13 is below the text floor (15)

$ python3 lint.py ../apps/tunastreet.racing/res/screens/home.json
(clean, exit 0)
```

Exactly the 3 `requireValidPress` sites (`nav_prev`, `likebox`, `nav_next`)
and the 5 sub-15px labels (`brand`, `status`, `reposts`, `views`, `pos`) --
plus one extra R2 line per site for the paired `pressLock` violation on the
same node, not a new offending node.

## Migrating an existing generator

`gen_racing_screen.py` (DesktopShare `files/racing/`) is racing's generator,
migrated onto this kit: its `label()`/`box()`/`button()` are now panelkit's
`label()`/`canvas()`/`button()`, and its two hand-written car-select bars are
now one `tile()` call each. Regenerating `home.json` from the migrated
script reproduces the previously-committed file byte-for-byte (49331 bytes,
empty diff) -- the primitives really are these functions, generalised, not a
redesign.

One shape doesn't have a primitive yet: racing's three lane-touch zones need
`pressed` + `pressing` + `released` (continuous drive control while held),
which no primitive here emits (tap targets are `pressed`+`released` only, by
design). They're kept as raw dicts in the generator, identical to the
pre-kit version, rather than forced through a primitive that doesn't fit.
