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

## Screen (368×448 portrait, one glanceable instrument)

- Header **CLOUDERA RACING** ("RACING" orange) over a 3px orange underline — tap = force refresh (`racing.refresh`).
- `PLAYING NOW: n` left, top live racer (`> name score`, green) right.
- 8 fixed rows: rank (row 1–3 hardcoded gold/silver/bronze, rest muted), name, car (small, muted), score (orange, right).
- Footer: `live · just now` / `live · Ns ago` (10s buckets) or the retry message.

No horizontal navigation — there is nothing to page. No gesture subscription at all, so
the system swipe-up-home is untouched.

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
```

Deploy: stage into `esp-brookesia/examples/system/super/littlefs/apps/` (re-stage-or-vanish
rule) and patch `littlefs_data.bin` in place with littlefs-python — never a full littlefs
rebuild (`tunastreet.ember` exists only in the staging tree). Flash `0xaa1000` on COM8.
