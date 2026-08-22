# tunastreet.racing — live Cloudera Racing leaderboard

ESP-Brookesia v0.8 runtime JS package for the Waveshare ESP32-S3-Touch-AMOLED-1.8 V2
(issue [#205](https://github.com/cldr-steven-matison/DesktopShare/issues/205)). Shows the
live leaderboard of the Cloudera Racing game deployed on WindowsDesktop
([#201](https://github.com/cldr-steven-matison/DesktopShare/issues/201)): top-8 drivers,
a "PLAYING NOW" count with the top live racer, and a staleness footer. Styled from the
game's own dashboard: Cloudera orange `#F96702` on true black, gold/silver/bronze ranks,
live green `#22c55e`.

Sibling of `tunastreet.tminus` (whose skeleton this copies verbatim) and `tunastreet.xviewer`.

## Backend contract (LAN)

The panel speaks only to `http://192.168.1.121:8093` (repo `~/amoled-racing` on
WindowsDesktop, FastAPI). The backend reads the game's `/api/leaderboard` and pre-digests
it — the device never parses the raw game JSON.

| Endpoint | Behaviour |
|---|---|
| `GET /health` | `{ok: true, app: "racing", source: "live"\|"fixture"}` |
| `GET /racing/leaderboard` | `{server_unix, source, playing_now, total_games, live: {name, score}\|null, count, rows: [{pos, name, car, score}]}` — ≤8 rows, names ≤12 chars, cars ≤16 chars |

Upstream failure is a `502` with a typed message — the panel renders it as
"backend unreachable - retrying", never a crash.

## Screens (368x448 portrait, panel-scale — nothing at desktop UI sizing)

1. **CAR** — CLOUDERA / RACING wordmark, `DRIVER: TUNA` (the panel knows who it is;
   no name entry), two 320x104 car slabs each showing the car's own sprite, and a
   full-width **START RACING** button.
2. **RACE** — HUD (driver, lives, 30px score, speed level, HERO MODE), three lanes,
   sprite obstacles falling, your car sprite at the bottom. Tap the left or right
   half of the road to change lanes.
3. **RESULT** — achievement rank, 56px score, stats, live top-3, **RACE AGAIN**.

Artwork is real sprites, not coloured blocks: 44x44 obstacles (traffic cone,
barrier, drum, rock, hazard, Databricks chevrons, Snowflake bear, iceberg
power-up) and 56x74 top-down cars, redrawn from the browser game's inline SVGs by
`files/racing/gen_racing_art.py` in DesktopShare. Sprites are swapped at spawn
time with `SystemGui.SetViewSrc`.

**Layout trap:** a parent with `layout.type` flex/grid positions its children and
ignores their absolute x/y — every container here declares `layout: {"type":
"none"}`. Getting this wrong renders a near-blank screen.

## Timing / sandbox notes

- `SystemTimer`: 5s periodic refresh (`rc_refresh` — the backend caches upstream 2s), 1s tick
  (`rc_tick`, drives the staleness footer off `server_unix + ticks`, never device `Date`),
  10s delayed retry (`rc_retry`).
- HTTP via `Http.RequestAsync` + service events, matched by `RequestId`; sync `Http.Request`
  fallback if a subscribe fails (same as tminus).
- `SetText` is diffed against the last value per path — a steady-state refresh with no
  changes issues zero GUI calls.
- Plain global script, no `fetch`/`setTimeout`; every hook try/catch → `true`; all timers
  stopped and the Http handle released in `on_stop`.

## Files

```
manifest.json                 package id/runtime entry
app/app.js                    all logic (~330 lines)
res/profile.json              icon + screen flow mount (AppDefault/Replace)
res/root.json, res/flows/     asset list, single-screen flow
res/screens/home.json         the full layout (generated: header/underline/nowbar/8 rows/status)
res/images/launcher_icon.png  92×92, checkered flag + orange speed stripes
res/images/obs_*.png          44×44 obstacles/villains/power-up (generated)
res/images/car_*.png          56×74 Corolla and 911 (generated)
```

The sprites are the browser game's own inline SVGs rasterised at panel scale, not redraws:
`DesktopShare/files/racing/gen_racing_art.py` lifts them out of the upstream game's
`services/game/index.html`, vendors them to `upstream_sprites.json`, then crops each to its
ink bounds and scales it to fill its slot so the drawn shape matches the 44px hit box.
Re-vendor after an upstream art change with `gen_racing_art.py --refresh`.

Deploy: stage into `esp-brookesia/examples/system/super/littlefs/apps/` (re-stage-or-vanish
rule) and patch `littlefs_data.bin` in place with littlefs-python — never a full littlefs
rebuild (`tunastreet.ember` exists only in the staging tree). Flash `0xaa1000` on COM8.
