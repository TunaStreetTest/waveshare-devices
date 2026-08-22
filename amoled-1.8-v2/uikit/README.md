# panelkit

A UI developer kit for JSON-UI screens on the Waveshare ESP32-S3-Touch-AMOLED-1.8
V2: 368x448 portrait, ESP-Brookesia v0.8 runtime apps whose UI is a
`res/screens/home.json` tree mutated at runtime by a `SystemGui` service.

Generating a screen through this module makes the panel's constraints
unrepresentable: an illegal size, layout or tap contract raises a `ValueError`
at generation time instead of rendering wrong on the glass.

## The constraints it encodes

| Constraint | Mechanism | Enforced by |
|---|---|---|
| A container with `layout.type: "flex"` or `"grid"` positions its own children and overrides their absolute `x`/`y`. | LVGL flex layout ignores the child's declared position; every node exists but renders elsewhere. | `canvas()` is always `layout:none` and rejects flow children; `stack()` is always flow and rejects absolute children; lint **R1** |
| `container` defaults to `scrollable: true`, and `requireValidPress: true` discards a press that moved. | A press that drifts a few px becomes a scroll, or is dropped as invalid, and the tap never fires. | every tap-capable primitive hardcodes `scrollable:false`, `pressLock:true`, `pressed`+`released`; no parameter re-opens either; lint **R2** |
| An `image` node defaults to `clickable: true`. | A decorative image drawn over a tap zone consumes every tap that lands on it. | `sprite()` declares `clickable` explicitly; lint **R6** |
| `CONFIG_LV_USE_FREETYPE` and `CONFIG_LV_USE_TINY_TTF` are both off, so every glyph comes from a compiled-in LVGL Montserrat, which is ASCII-only. | Any codepoint above 0x7E renders as a filled box. | `label()`/`button()` refuse non-ASCII; lint **R7**; runtime text passes through `ascii.js` |
| For the same reason, a `fontSize` is never scaled. `get_builtin_font()` (`gui/brookesia_gui_lvgl/src/style_font.cpp`) returns an exact match or the closest **smaller** compiled face. | An off-ladder size renders smaller than the number in the source, with no warning. | `check_size()` raises; lint **R8** |
| The glass is a rounded rectangle. | Near the top and bottom edges the usable width is less than 368, so edge-anchored text sits inside the corner arc. | `screen()` lints the assembled tree, where absolute position is known; lint **R10** |

## Files

| File | What |
|---|---|
| `tokens.json` | Every measured number. The only file in the kit that contains a value. |
| `tokens.py` | Python view of `tokens.json`, plus the threshold checks (`check_size`, `check_line_height`, `check_target_height`, `corner_inset`). |
| `panelkit.py` | The primitives. Import this to build a screen. |
| `lint.py` | Structural lint, R1–R10. `screen()` runs it on every tree it builds. |
| `ascii.js` | The canonical runtime text sanitiser, inlined into each app by `tools/sync-ascii.py`. |
| `selftest.py` | Asserts the traps raise, the fixtures flag the expected nodes, and the two linters implement the same rules. |

## Tokens

`tokens.json` is the single source for every threshold. No module here redefines
or forks a value — a number changes there or nowhere. It has a second reader,
`tools/simulator/lint.js`, which is why it is framework-agnostic JSON rather
than Python.

**Text floor: 16px.** Roles above it: `footer` 16, `body` 16–20, `value` 24–40,
`hero` 40–48 — caption, body copy, large numbers, hero numerals. At 368x448 at
typical holding distance, desktop-scale text sizing runs at roughly half of
what is legible.

**Font ladder: 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48.** The only sizes this
board can draw, and the reason the floor is 16 rather than 15 — 15 has no
compiled face and is drawn at 12. Snap every size to a rung.

**Line heights are read, not derived.** `text.line_height` holds the real
`.line_height` from each `lv_font_montserrat_<n>.c`. The ratio is ~1.1x the
nominal size. Assuming the ~1.3x common on desktop is wrong in both directions:
it flags boxes that are fine and clears boxes that clip descenders.

**Tap targets: 76–88px tall, 40px minimum gap.** The gap rule applies to
discrete, similarly-sized controls, where a slightly-off tap is ambiguous
between two of them. It does not apply to controls that tile a region
edge-to-edge with no gap at all, or to a control well above the tap-target band
— `lint.py`'s R4 gates on both.

**Corner inset is computed.** The inset a corner of radius R demands at distance
d from the edge is `R − √(R² − (R−d)²)` — about 38px at d=2. `corner_radius` is
an **estimate**: it appears in no board yaml, datasheet or driver in this tree,
and nothing on the device reports it. 52 is deliberately generous. To calibrate,
change that one number; `tokens.corner_inset()` and lint R10 both read it.

## Primitives

- `screen(id, children, bg=BG)` — root `viewScreen`. Lints the assembled tree
  and raises before returning, so a failing screen cannot reach disk.
- `canvas(id, x, y, w, h, ...)` — absolute container.
- `stack(id, children, direction=, gap=, ...)` — flex/flow container, for
  content whose length is not known up front.
- `label(id, x, y, w, h, text=, role=, ...)` — checks size against the role
  band, the floor and the ladder, and `h` against the face's line height.
  `x=None, y=None` builds a flow-placed label for a `stack()`/`row()` child.
- `button(id, x, y, w, h, text, action, ...)` — height-checked tap target.
- `row(id, x, y, items, gap=None, h=None)` — lays already-built flow items left
  to right, computing each `x` from cumulative width + gap; clamps the gap to
  `touch.target_gap_min` when any item is a tap target.
- `stat_bar(id, x, y, w, stats)` — footer-role captions over value-role numbers,
  equal columns.
- `tool_bar(id, x, y, w, items)` — bottom bar of tap targets; an item flagged
  `compact=True` is a readout, exempt from the height floor but not the text
  floor.
- `tile(id, x, y, w, h, image, title, subtitle, action, ...)` — image plus two
  lines of text, whole box tappable.
- `sprite(id, x, y, w, h, src, ...)` / `image(...)` — image node bound to a
  runtime `src` key, with `clickable` always declared.

`hidden="key"` adds a `commonProps.hidden` binding on any primitive;
`bindings={...}` merges in any other runtime bindings the app needs.

## Example

```python
import panelkit as pk

hud = pk.stat_bar("hud", 8, 4, 352, [
    {"id": "hb_beat", "caption": "HEARTBEAT", "value": "12s", "color": pk.tk.GREEN},
    {"id": "hb_proc", "caption": "PROCESSORS", "value": "7", "color": pk.tk.INK},
    {"id": "hb_err", "caption": "ERRORS", "value": "0", "color": pk.tk.RED},
])

action_bar = pk.tool_bar("actions", 8, 356, 352, [
    # Pictorial targets are PNGs from the app's imageSet, not characters:
    # the compiled Montserrat has no icon glyphs.
    {"id": "ab_like", "image": "${image.heart_off}", "caption": "0",
     "action": "app.like", "image_bindings": {"imageProps.src": "heartSrc"}},
    {"id": "ab_views", "text": "1.2k", "compact": True},
    {"id": "ab_clear", "text": "CLEAR", "action": "app.clear"},
])

home = pk.screen("home", [hud, action_bar])
```

An 11px label, an 18px one, a 16px label in a 14px box, `CLEAR` at 50px tall, an
absolute child in a `stack()`, or a left-aligned label at `x=16, y=2` each raise
immediately. `selftest.py` covers all of them.

## Lint

```
python3 lint.py <screen.json> [...]     # one line per violation, non-zero exit
python3 lint.py --rules                 # the rule inventory
```

| Rule | Catches |
|---|---|
| R1 | a flex/grid container with an absolute-placed child |
| R2 | `requireValidPress`, or a tap target without `pressLock`/`scrollable:false` |
| R3 | text below the readable floor |
| R4 | two sibling tap targets closer than the minimum gap |
| R5 | an absolute node whose box escapes the panel |
| R6 | an image that does not declare `clickable` |
| R7 | text outside ASCII |
| R8 | a `fontSize` that is not on the compiled Montserrat ladder |
| R9 | a label box shorter than the font's real line height |
| R10 | edge-anchored text inside the rounded corner |

**Two linters, one rule set.** `lint.py` gates generation;
`tools/simulator/lint.js` gates the flash and additionally runs R0, a dynamic
reachability check requiring a booted app. Both read `tokens.json`; neither
hardcodes a threshold. `selftest.py` asserts the rule IDs match — divergence
means a generator passes its own gate and fails at flash time, or passes both
and fails on the glass.

**Limit.** R5 and R10 need a node's absolute position, which `lint.py` computes
only when the node and every ancestor are absolute-placed. A flow-placed node's
position is decided by its parent's flex layout at runtime, and this linter does
not estimate it; `lint.js` has a layout pass that does. Screens built with
`canvas()` are fully covered.

## Self-test

`python3 selftest.py` covers the deliberate violations, the frozen fixtures, and
every app under `apps/` against the full rule set.

`fixtures/dirty-screen.json` is a hand-written screen that predates the kit,
kept frozen as the counter-example — a lint whose only negative proof is a file
someone is about to fix has no negative proof:

```
$ python3 lint.py fixtures/dirty-screen.json
.../nav_prev  R2 requireValidPress:true drops a tap the finger drifted through
.../likebox   R2 requireValidPress:true drops a tap the finger drifted through
.../nav_next  R2 requireValidPress:true drops a tap the finger drifted through
.../brand     R3 fontSize 14 is below the text floor (16)
.../status    R3 fontSize 12 is below the text floor (16)
.../nav_prev  R7 text contains U+00AB, outside built-in Montserrat's ASCII range
.../brand     R8 fontSize 14 is not a compiled Montserrat size -- it will render at 12px
.../nav_prev  R8 fontSize 26 is not a compiled Montserrat size -- it will render at 24px
```

Six of those labels are sizes the board cannot draw, so each rendered smaller
again than the number in the file.

## Runtime text

`panelkit` refuses non-ASCII in a **generated** screen, which covers only text
baked in at generation time. Runtime text — a post body, a launch name, a
processor name — goes straight to `SetText`. Sampled against a live feed, a
single fetch carried 24 non-ASCII characters across 15 codepoints, each a filled
box on the glass.

`ascii.js` is the canonical sanitiser. The Brookesia JS runtime has no module
loader (an app is one global script), so each `apps/<id>/app/app.js` carries an
inlined copy between `BEGIN`/`END` sentinels. Edit `ascii.js`, then run
`python3 tools/sync-ascii.py`; both `--check` and `tools/simulator/selftest.js`
fail on a stale copy. The policy is to transliterate what has an ASCII spelling
and drop what does not — a dropped character leaves a gap, a kept one leaves a
box that reads as a broken font.

## Migrating a generator

Racing's generator was migrated onto the kit: its `label()`/`box()`/`button()`
became `label()`/`canvas()`/`button()`, and two hand-written car-select bars
became one `tile()` call each. It regenerates `home.json` byte-for-byte. So do
the other three generators after every rule above was added — the primitives are
those functions generalised, not a redesign.

One shape has no primitive: racing's lane-touch zones need
`pressed` + `pressing` + `released` for continuous control while held, and tap
targets here are `pressed`+`released` by design. They stay raw dicts in the
generator rather than being forced through a primitive that does not fit.

## Retargeting to another panel

`tokens.json` is the only file with a number in it, so a different panel is a
new tokens file rather than a fork:

1. `device.width` / `device.height`.
2. `text.font_ladder` — the faces actually linked into *that* build — and
   `text.line_height` read from the same `lv_font_*.c` files. With FreeType or
   TinyTTF enabled the ladder constraint does not apply and R8 should be dropped.
3. `text.floor` and the role bands, measured at the distance the device is held.
4. `touch.*`, measured with a finger.
5. `safe_area.corner_radius` — `0` for a square panel, which disables R10.

## Licence

Apache-2.0. See `LICENSE` at the repository root.
