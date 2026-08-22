# Brookesia panel simulator (#212)

Runs the **real, unmodified** files any app under `apps/<id>/` ships --
`app/app.js` plus the screen it resolves through `res/profile.json` -> the
named `res/flows/<flow>.json` -> its `initial` screen id -> `res/screens/<id>.json`
-- against a shim that emulates the parts of the Brookesia host bridge those
files call (`SystemGui`, `SystemTimer`, `Http`), at true panel size (368x448).
No board, no flash, in seconds instead of a flash-and-look cycle.

Generalised out of `~/amoled-racing/simulator/` (#205, racing-only) so any
app -- `tunastreet.xviewer`, a future app, whatever's next -- gets the same
harness for free. The core (`shim.js`, `pkg.js`, `serve.js`, `headless.js`,
`lint.js`, `panel.html`) has **zero per-app knowledge**; anything
app-specific (an autopilot, a keymap) is a driver module under `examples/`,
loaded by path via `--drive` / `?drive=`, never hardcoded in the core.

## Files

| File | Responsibility |
|---|---|
| `shim.js` | The host bridge: `Shim` (SystemGui/SystemTimer/Http + `brookesia.*`), `Doc` (the JSON-UI view tree, binding writes, flex/flow `computeGeometry()`), `StateRenderer` (no-DOM state reader). Exported as `PanelKit` (and `RacingShim`, kept as a back-compat alias). |
| `pkg.js` | Resolves `--app <id>` to a package: manifest -> entry, profile -> flow -> screen. Throws a specific, actionable message on any missing/malformed step. Node-only (fs). |
| `fixtures.js` + `fixtures/<app-id>.json` | Canned HTTP responses keyed by `"METHOD /path"` or bare `/path`, matched against the request URL's pathname. A path with no entry synthesizes `200 {}` and logs a WARN -- boot still proceeds. |
| `headless.js` | Node CLI: boots a package under the shim, and if `--drive` is given, calls the driver's `step()` every 40ms tick until `isDone()` or the tick budget runs out, then prints `summary()` (or a generic label dump if the driver has none). |
| `serve.js` | Static server, Node built-ins only (`http`/`fs`/`path`), no app backend needed. `GET /` -> `panel.html`, `GET /sim/<path>` -> anything under this dir (path-contained), `GET /pkg/<app>/<path>` -> `apps/<app>/<path>` (path-contained). Default port `:8095` (8091/8092/8093/8099 are already other things on this host). |
| `panel.html` | Browser renderer, panel-only (no sidebar/legend -- see "UI" below). Builds the tree at true 368x448 and scales the finished glass to the window (see "Panel size" below). Real CSS flex for `layout.type:"flex"` nodes, `position:absolute` for `placement.mode:"absolute"` ones. Synthesizes tap and swipe gestures from pointer events. Loads a driver via `?drive=` as a classic `<script>` (sets `window.PanelDriver`). |
| `drive.js` | Launches a real, visible Chromium over CDP (Node 24's built-in `WebSocket`, no puppeteer), screenshots the run, and **always closes the Chromium it opened** -- normal exit, error, or SIGINT/SIGTERM -- so a run never leaves an orphan window or profile-holding process behind. |
| `lint.js` | `--check <app-id>`: dynamic reachability sweep (boots under `--fixture`, fails on any `{success:false}` from `SystemGui`, fires every subscribed action once, advances the clock past every timer interval) + static R1-R5 token/trap lint over `res/screens/*.json`, thresholds read from `uikit/tokens.json`. |
| `examples/racing-bot.js` | tunastreet.racing's autopilot, moved out of the core. Exports `{create(shim,opts), keymap, onKey}` -- the driver contract below. |


## The panel wall — every app on screen at once

`./wall.sh start` brings up one window per app, each with its own `serve.js`
proxying to that app's real LAN backend so the panels show live data, arranged
as a **2×2 block on the right of the screen** — the session terminal sits down
the left, so the conversation and all four panels are readable at once:

| App | sim port | proxies to | requested x,y | cell |
|---|---|---|---|---|
| racing | 8097 | `:8093` (fixture + autopilot, see below) | 1099, 0 | 400×552 |
| xviewer | 8095 | `:8091` | 1511, 0 | 400×552 |
| agent | 8098 | `:8094` | 1099, 588 | 400×395 |
| tminus | 8096 | `:8092` | 1511, 588 | 400×395 |

**The two rows are deliberately different heights, and the pairing is not
arbitrary.** This is Steven's own arrangement, measured off the live windows
and made reproducible 2026-08-22: the two panels being actively watched
(racing, xviewer) get the tall top row, the two being monitored (agent,
tminus) the short bottom one. Before this, `tile` flattened both rows to one
`WIN_H` and put the wrong pair on top — it stomped the layout every time it
ran. Since #219 the panel fits itself to whatever the window gives it, so the
uneven rows cost nothing: the top row renders at 1.01x, the short bottom row
at 0.82x, and neither clips.

The x,y above are what CDP is **asked** for. Under WSLg a window reports back
`+6,+27` from the request (the frame offset — stable, and not cumulative
across repeated tiles), so the constants are pre-compensated and the block
reads back at 1105,27 / 1517,27 over 1105,615 / 1517,615. On a different
screen, override it: `WALL_X0=… WALL_Y0=… WALL_Y1=… WIN_W=… WIN_H_TOP=…
WIN_H_BOT=… ./wall.sh tile`. `start` is idempotent (it skips whatever is
already up), `stop` closes what it started, `status` prints the current state,
and `tile` re-applies positions without restarting anything.

**A window keeps serving the page it loaded.** After editing `panel.html`, a
screen generator, or an `app.js`, hard-reload the windows (CDP `Page.reload`
with `ignoreCache`, or `stop`/`start` the wall) — otherwise you are reviewing a
build from several versions ago.

**Racing runs on its fixture, deliberately.** The autopilot against the live
backend would POST real telemetry into the pipeline and land bot scores on the
shared leaderboard. The other three are live.

**Why tiling happens over CDP and not `--window-position`:** Chromium ignores
that flag under WSLg. Every window opens stacked at the same spot and whichever
launched first shows underneath all the others — which is exactly what it looks
like when "a panel of the racing game is under every other app".

## Usage

```bash
# headless, no browser -- for CI/regression, always --fixture in a repo test
node headless.js --app tunastreet.racing --fixture --drive examples/racing-bot.js
node headless.js --app tunastreet.xviewer --fixture --seconds 5

# the pre-flash check
node lint.js --check tunastreet.xviewer
node lint.js --app tunastreet.racing --check

# browser, watchable
node serve.js --port 8095 &
node drive.js 30 /tmp/shot "http://127.0.0.1:8095/?app=tunastreet.racing&fixture=1&drive=examples/racing-bot.js&claude=1"
# or just open the URL yourself in any browser once serve.js is up.
```

### `headless.js` flags

| Flag | Meaning |
|---|---|
| `--app <id>` | Required. Resolved under `../../apps/<id>`. |
| `--fixture` | Use `fixtures/<id>.json` instead of a live network `fetch`. **Always use this in a test run** -- see "Never hit a live backend" below. |
| `--drive <path>` | Path to a driver module (see contract below), resolved relative to this dir, then to cwd, then absolute. |
| `--as <name>` | If the app's `app.js` has a `var DRIVER = "...";` line, replace the literal (racing's device-identity convention; harmless no-op, logged, on an app without it). |
| `--seconds N` / `--ticks N` | How long to run (40ms/tick) when the driver has no `isDone()` -- default 60s. `--ticks` overrides `--seconds`. |
| `--pure` | Passed through to `driver.create(shim, {pure:true})`. |
| `--quiet` | Suppress the `[headless] app: ...` preamble line. |

### `lint.js` / `--check`

**What it covers**: every `SystemGui` call the app makes while booting, firing
every action it subscribed to once, and letting every registered timer fire
at least once, actually succeeds (no `{success:false}`) -- that is how a dead
`g_clock` binding path shipped in #205 without anyone noticing. Plus five
static rules over `res/screens/*.json`, thresholds from `uikit/tokens.json`:

- **R0** (dynamic): any `SystemGui.*` call returns `{success:false}` during boot/action-sweep/timer-sweep.
- **R1**: an absolutely-placed child under a `layout.type:"flex"`/`"grid"` parent (flex silently overrides the child's x/y).
- **R2**: `requireValidPress:true` anywhere (drops a tap the finger drifted through); or a node using the `pressed`/`released` tap-cycle (`uikit/tokens.json`'s `traps.tap_events`) without `commonProps.pressLock:true` and `commonProps.scrollable:false` explicit (a drag reads as a scroll). `clicked`-type taps aren't subject to this -- they're a single synthesized event, not a press/release pair, so the drift/drag failure mode doesn't apply.
- **R3**: any label under `text.floor` px (15 -- measured unreadable at arm's length in #205).
- **R4**: two sibling tap targets closer than `touch.target_gap_min` (40px) apart -- restricted to nodes whose height falls inside the measured `touch.target_h_min`/`target_h_max` band (76-88px, an actual button shape). Racing's in-game lane zones are full-height thirds *by design* ("target the outcome, not the control" -- `uikit/tokens.json`'s own note), not spaced buttons, so their zero gap is correct and this filter is what keeps them from false-flagging.
- **R5**: an absolute node whose computed box escapes the 368x448 panel. Skips any node whose `placement.x`/`placement.y` are bound (e.g. racing's off-screen obstacle spawns) -- their static JSON position is a parking spot, not where they render.

Rule IDs are kept in this order (R1-R5) to match `uikit/lint.py`, the Python
twin a sibling agent is writing over the same tokens file.

**What it does NOT cover**: whether the app *plays correctly* -- game
balance, whether a feed actually renders sensible content, whether an image
decodes on real hardware, timing/animation feel, or anything about the real
device's font metrics, JPEG decoder, or touch debounce. It is structural
lint plus reachability, not a play-test. `headless.js --drive` (scored) and
an actual flash are still how you validate behavior.

**Acceptance, measured 2026-08-21**: `--check tunastreet.xviewer` against its
current, hand-written screen reports exactly the 3 `requireValidPress` sites
(`nav_prev`, `likebox`, `nav_next`) and the 5 sub-15px labels (`brand` 14,
`status` 12, `reposts`/`views`/`pos` 13). `--check tunastreet.racing` is clean.

### Driver contract (`--drive` / `?drive=`)

A driver module is loaded two ways -- Node `require()` (headless.js) and a
classic `<script>` tag (panel.html, since it's not an ES module) -- so write
it with the UMD shape `examples/racing-bot.js` uses:

```js
(function (root, factory) {
    if (typeof module === "object" && module.exports) { module.exports = factory(); }
    else { root.PanelDriver = factory(); }        // browser: window.PanelDriver
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    return {
        create(shim, opts) {
            // return an object -- only .step is load-bearing for the core:
            return {
                step() { /* one decision per tick */ },
                boot() { /* optional: fire the actions that start the app's "game" */ },
                isActive() { /* optional: false pauses step() without stopping the clock */ },
                isDone() { /* optional: true ends a headless.js run early */ },
                restart() { /* optional: browser autopilot calls this after isDone() */ },
                summary() { /* optional: printed instead of the generic label dump */ },
            };
        },
        keymap: { ArrowLeft: "app.action.name" },   // optional: panel.html keydown -> shim.emit
        onKey(shim, key) { return false; },          // optional: return true to consume the key yourself
    };
});
```

Only `create` is required. Everything else is feature-detected by the core
(`headless.js`, `panel.html`) -- an app with no natural "done" state (like
xviewer) can ship a driver with just `step`/`keymap` and no `isDone`.

### Fixtures (`--fixture` / `&fixture=1`)

`fixtures/<app-id>.json` maps `"METHOD /path"` (or bare `/path`, any method)
to a canned `{status_code, body}`. `body` may be a string or an object
(stringified automatically). A request whose pathname isn't in the map still
gets a `200 {}` and a logged WARN, so boot proceeds even with a partial
fixture file. This is what makes `--check` (and any CI-style run) able to
boot an app with **no backend process up at all**.

### Never hit a live backend from a test run

Several apps' `BACKEND` constants point at real LAN services (racing's
telemetry lands on the real Kafka pipeline / leaderboard). Every test run in
this harness must pass `--fixture` (or `&fixture=1` in the browser) --
`lint.js --check` does this internally, unconditionally. `headless.js`
without `--fixture` will make real `fetch()` calls if you ask it to; that's
for a deliberate manual live-backend test, never for CI/regression.

### Panel size (#219)

The view tree is **always built at 368x448** -- every coordinate the app
computes and every geometry the renderer writes stays in device pixels -- and
only the finished stage is blown up with a CSS `transform: scale()`. Scaling
the transform rather than the layout is what keeps "what the sim shows"
identical to "what the glass shows": nothing re-flows at a different size, it
is the same pixels, larger. Gesture thresholds are divided back down by the
scale, so a swipe still needs the same *device* travel it would on the board.

Default is fit-to-window: a maximized window on this 1920x1080 desk gives
about 2.1x, a `wall.sh` cell about 1.0x. `&scale=N` pins an exact factor
instead (`&scale=1` for literal device size).

### UI: panel-only

`panel.html` shows the glass and nothing beside it -- no legend, no node
inspector, no app switcher. App/driver/fixture selection is query params
(`?app=`, `&drive=`, `&fixture=1`, `&scale=N`, `&claude=1` to auto-engage the
autopilot). The one piece of on-page chrome that shows by itself is the
**driver button** -- `CLAUDE DRIVES — start` / `— stop`, with `C` as its
keyboard toggle -- which appears whenever a `?drive=` module is loaded: an
autopilot with no on/off switch can only be started from the URL (#219). The
log strip stays behind `&chrome=1`. Neither ever sits beside the panel, only
below it. Click/tap a
node the app wired a `clicked`/`pressed` event to; a short drag on a node
with a `{"type":"gesture"}` handler synthesizes a swipe and logs
`{direction, distance, ms}` so you can sanity-check it against the app's own
nav-cooldown (xviewer's is 350ms).

## Regression gate (the #205 -> #212 move)

Before trusting the move, the racing autopilot was run both ways under an
equivalent decoy backend (never the live `:8093` pipeline -- see "Never hit
a live backend" above) for 30,000 ticks (20 simulated minutes, ~3s wall
clock):

| | before (`~/amoled-racing/simulator/headless.js`) | after (`tools/simulator/headless.js --drive examples/racing-bot.js`) |
|---|---|---|
| result panel reached | false (bot never dies -- iceberg farming, documented in #205) | false (same) |
| score at t=1200s | 43,520 | 44,520-45,010 (run-to-run RNG variance; same bot logic) |
| lives / speed | `***` / Lv.1 · 60 km/h | `***` / Lv.1 · 60 km/h |
| app errors | none | none |

Same qualitative behavior, same never-scratched-at-Lv.1 signature the #205
bot produced. Absolute score differs run to run in both versions (obstacle
spawn lane/type is `Math.random()`, not seeded) -- that's expected, not a
regression.

## amoled-racing is left in place, but partly redundant now

`~/amoled-racing/backend/server.py`'s simulator routes (`GET /`, `GET
/sim/*.js`, `GET /pkg/*`) and `~/amoled-racing/scripts/test.sh`'s "simulator
serves" check do the same job `serve.js` now does generically. Nothing there
was deleted or edited -- that's a separate git repo and its racing backend
is live on `:8093` right now -- but whoever next touches that repo should
know `tools/simulator/serve.js` is the generalised replacement.
