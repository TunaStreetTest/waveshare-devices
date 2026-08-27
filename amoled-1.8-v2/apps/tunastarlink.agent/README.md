# tunastreet.agent — MicroFi agent monitor (#197)

ESP-Brookesia v0.8 JavaScript runtime app for the Waveshare 1.8" AMOLED
(368×448 portrait). The board watching its own EFM agent: a live heartbeat
sweep, how many of its processors are running, and the metrics it ships off
to EFM.

This replaces reading the native status tile, which showed text and nothing
else. The tile stays where it is; this is the app you open when you want to
know whether the edge agent is actually alive.

## What's on the screen

| Region | Shows |
|---|---|
| Header | `MICROFI AGENT` + state — `ONLINE` / `STALE` (heartbeat > 60 s) / `SILENT` (> 300 s) / whatever EFM reports, coloured green / amber / red |
| Heartbeat sweep | 12 cells with one bright head running across them, one step per second, in the state colour — a monitor trace, drawn with `bgColor` writes only |
| Beat | seconds since the last heartbeat, 56 px, counted forward locally between polls so the number always moves |
| Processors | `running / total` from the agent's own component report, the processor names beneath it, and how many types the agent class publishes |
| Metrics | UPTIME · MEM MB · CPU % · QUEUE — the four numbers the agent actually reports to EFM |
| Footer | agent id, agent type/version, and how long ago the payload landed |

Tap anywhere to force a refresh. The tap zone sits behind everything and
catches whatever isn't its own target — LVGL hit-testing skips non-clickable
objects, so a tap on a label falls through to it.

## Backend contract (`http://192.168.1.121:8094`)

`/home/tunas/amoled-agent` — FastAPI, `bash scripts/run.sh`. Needs the
Windows firewall rule `Allow Agent Port 8094` (inbound TCP, profile Any), the
same shape as the `:8091` / `:8092` / `:8093` rules.

| Endpoint | Shape |
|---|---|
| `GET /health` | `{ok, app, efm, agent}` |
| `GET /agent/status` | `{server_unix, agent_id, device_id, agent_class, agent_type, agent_version, state, last_seen_unix, heartbeat_age_s, first_seen_unix, uptime_s, cpu_pct, mem_bytes, flowfile_queued, controller_running, processors:[{name,running}], running_count, processor_count, catalogue_count, catalogue:[…], flow_published}` |

The panel never talks to EFM. The backend digests exactly one call —
`GET /efm/api/agents/<agent-id>` — into the fields above, because the raw
reply carries manifest hashes, supported-operation descriptors and repository
sub-trees a microcontroller has no business parsing. Same doctrine as the
racing backend. The processor catalogue comes from
`agent-class-manifest-config/AMOLED` → `agent-manifests/<id>` and is cached for
ten minutes; a re-pin is rare.

`server_unix` rides on every payload because QuickJS `Date` on this board can
be epoch-0 — every elapsed time on the screen is counted from it plus local
one-second ticks.

## Screen generation

`res/screens/home.json` is generated, never hand-edited:

```bash
python3 /home/tunas/DesktopShare/files/agent/gen_agent_screen.py
python3 /home/tunas/tuna-starlink-app/backend/.venv/bin/python3 \
    /home/tunas/DesktopShare/files/agent/gen_agent_art.py   # launcher icon
```

Both are built on [`panelkit`](../../uikit/README.md), so the type scale, tap
targets and the two JSON-UI traps come from `tokens.json` rather than from
whatever looked right at the time. The node ids in the generated screen are
the contract with `app/app.js` — that pair is exactly what silently broke in
#205 when a UI rework deleted labels the app kept addressing, so the
simulator's `--check` walks every path the app writes.

## Sandbox notes

Plain global script (QuickJS, `JS_EVAL_TYPE_GLOBAL`): no `fetch`, no `XHR`, no
`setTimeout`. HTTP through the `Http` service (async with a sync
`Http.Request` fallback if event subscription fails), timers through
`SystemTimer`, UI mutation through `SystemGui`. Every log line is prefixed
`[agent]` for serial triage.
