#!/usr/bin/env bash
# The panel wall: one simulator window per AMOLED app, in a 2x2 block on the
# right of the screen with the session terminal beside it on the left.
#
#   ./wall.sh start     bring the whole wall up (idempotent -- skips what's already running)
#   ./wall.sh stop      close every window and server it started
#   ./wall.sh status    what's up right now
#   ./wall.sh tile      re-apply window positions/sizes without restarting anything
#
# Each app gets its own serve.js on its own port, proxying to that app's real
# LAN backend, so the panels show live data rather than fixtures. Racing is the
# exception: it runs on its fixture with the autopilot engaged, because a bot
# playing against the live backend would post real telemetry onto the shared
# leaderboard.
#
# Why the tiling is done over CDP instead of with --window-position: Chromium
# ignores that flag under WSLg, so every window opens stacked at the same spot
# and whichever launched first shows underneath all the others.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="${PANEL_WALL_RUN:-/tmp/panel-wall}"
CHROMIUM="${CHROMIUM:-/snap/bin/chromium}"

# Layout: a 2x2 block of panels on the right of the screen, leaving the left
# half for the session terminal -- the arrangement Steven works this device in,
# so the four panels and the conversation are readable at once.
#
# Quadrants and the two row heights below are HIS, measured off the live
# windows 2026-08-22 and confirmed: racing / xviewer across the TOP in the tall
# row (the two being actively watched), agent / tminus below in the short one.
# The rows are deliberately different heights, which is why there is no single
# WIN_H any more -- `tile` used to flatten both rows to one size and put the
# wrong pair on top, i.e. it stomped this layout every time it ran.
#
# These are REQUESTED bounds, and under WSLg a window reports back +6,+27 from
# what CDP was asked for (the frame offset -- measured on this desk, stable and
# non-cumulative across repeated tiles). The constants below are pre-compensated
# so the block lands where Steven's hand-placed one sat, i.e. reading back at
# 1105,27 / 1517,27 over 1105,615 / 1517,615.
#
# Origin and cell sizes are env-overridable for a different screen:
#   WALL_X0=1099 WALL_Y0=0 WALL_Y1=588 WIN_W=400 WIN_H_TOP=552 WIN_H_BOT=395 ./wall.sh tile
X0="${WALL_X0:-1099}"          # left edge of the block
Y0="${WALL_Y0:-0}"             # top edge of the block
WIN_W="${WIN_W:-400}"          # 368 px of glass plus Chromium's frame
WIN_H_TOP="${WIN_H_TOP:-552}"  # tall row: full glass plus the driver-button row
WIN_H_BOT="${WIN_H_BOT:-395}"  # short row: the panel scales itself down to fit
COL=$((X0 + WIN_W + 12))       # second column
ROW="${WALL_Y1:-588}"          # top edge of the second row
# Since #219 the panel fits itself to whatever the window gives it, so the
# uneven rows cost nothing: the top row renders about 1.1x, the short bottom
# row about 0.82x, and neither clips.

# name | sim port | backend to proxy | debug port | window x:y:w:h | extra query
WALL=(
  "racing|8097|127.0.0.1:8093|9341|$X0:$Y0:$WIN_W:$WIN_H_TOP|&fixture=1&drive=examples/racing-bot.js&claude=1"
  "xviewer|8095|127.0.0.1:8091|9342|$COL:$Y0:$WIN_W:$WIN_H_TOP|"
  "agent|8098|127.0.0.1:8094|9343|$X0:$ROW:$WIN_W:$WIN_H_BOT|"
  "tminus|8096|127.0.0.1:8092|9344|$COL:$ROW:$WIN_W:$WIN_H_BOT|"
)

mkdir -p "$RUN"

field() { echo "$1" | cut -d'|' -f"$2"; }

port_busy() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

start_servers() {
  for row in "${WALL[@]}"; do
    local name port proxy
    name=$(field "$row" 1); port=$(field "$row" 2); proxy=$(field "$row" 3)
    if port_busy "$port"; then
      echo "  server $name already on :$port"
      continue
    fi
    ( cd "$HERE" && setsid nohup node serve.js --port "$port" --proxy "$proxy" \
        > "$RUN/serve-$name.log" 2>&1 < /dev/null & )
    echo "  started server $name on :$port -> $proxy"
  done
  sleep 2
}

start_windows() {
  for row in "${WALL[@]}"; do
    local name port dbg extra
    name=$(field "$row" 1); port=$(field "$row" 2)
    dbg=$(field "$row" 4); extra=$(field "$row" 6)
    if port_busy "$dbg"; then
      echo "  window $name already up (debug :$dbg)"
      continue
    fi
    local url="http://127.0.0.1:$port/?app=tunastreet.$name$extra"
    setsid nohup "$CHROMIUM" \
      --user-data-dir="$RUN/prof-$name" \
      --remote-debugging-port="$dbg" \
      --app="$url" \
      --no-first-run --no-default-browser-check \
      > "$RUN/win-$name.log" 2>&1 < /dev/null &
    echo "  started window $name (debug :$dbg)"
    sleep 3
  done
  sleep 4
}

# Chromium ignores --window-position under WSLg, so bounds are set over CDP
# once the window exists. Node 24 speaks WebSocket natively -- no puppeteer.
tile() {
  for row in "${WALL[@]}"; do
    local name dbg xy x y w h
    name=$(field "$row" 1); dbg=$(field "$row" 4); xy=$(field "$row" 5)
    IFS=: read -r x y w h <<< "$xy"
    PW_DBG="$dbg" PW_X="$x" PW_W="$w" PW_H="$h" PW_Y="$y" \
      node -e '
        const http = require("http");
        const dbg = process.env.PW_DBG;
        http.get(`http://127.0.0.1:${dbg}/json/list`, r => {
          let b = ""; r.on("data", d => b += d);
          r.on("end", async () => {
            const page = JSON.parse(b).find(t => t.type === "page");
            if (!page) { return; }
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            let id = 0; const pend = new Map();
            const send = (m, p = {}) => new Promise(res => {
              const i = ++id; pend.set(i, res);
              ws.send(JSON.stringify({ id: i, method: m, params: p }));
            });
            ws.onmessage = e => {
              const m = JSON.parse(e.data);
              if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
            };
            await new Promise(res => ws.onopen = res);
            const w = await send("Browser.getWindowForTarget", { targetId: page.id });
            await send("Browser.setWindowBounds", { windowId: w.windowId, bounds: {
              left: +process.env.PW_X, top: +process.env.PW_Y,
              width: +process.env.PW_W, height: +process.env.PW_H,
              windowState: "normal" } });
            ws.close();
          });
        }).on("error", () => {});
      ' 2>/dev/null && echo "  tiled $name at ${x},${y} (${w}x${h})"
  done
}

status() {
  for row in "${WALL[@]}"; do
    local name port dbg
    name=$(field "$row" 1); port=$(field "$row" 2); dbg=$(field "$row" 4)
    printf "  %-9s server :%s %-8s window debug :%s %s\n" \
      "$name" "$port" "$(port_busy "$port" && echo up || echo DOWN)" \
      "$dbg" "$(port_busy "$dbg" && echo up || echo DOWN)"
  done
}

stop() {
  for row in "${WALL[@]}"; do
    local name dbg port
    name=$(field "$row" 1); dbg=$(field "$row" 4); port=$(field "$row" 2)
    pkill -f "remote-debugging-port=$dbg" 2>/dev/null && echo "  closed window $name"
    pkill -f "serve.js --port $port" 2>/dev/null && echo "  stopped server $name"
  done
}

case "${1:-start}" in
  start)  echo "servers:"; start_servers; echo "windows:"; start_windows; echo "tiling:"; tile ;;
  stop)   stop ;;
  status) status ;;
  tile)   tile ;;
  *)      sed -n '2,16p' "$0"; exit 2 ;;
esac
