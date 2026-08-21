#!/usr/bin/env bash
# The panel wall: one simulator window per AMOLED app, tiled across the desktop.
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

# name | sim port | backend to proxy | debug port | window x | extra query
WALL=(
  "racing|8097|127.0.0.1:8093|9341|40|&fixture=1&drive=examples/racing-bot.js&claude=1"
  "xviewer|8095|127.0.0.1:8091|9342|440|"
  "agent|8098|127.0.0.1:8094|9343|840|"
  "tminus|8096|127.0.0.1:8092|9344|1240|"
)
WIN_W=388
WIN_H=468
WIN_Y=70

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
    local name dbg x
    name=$(field "$row" 1); dbg=$(field "$row" 4); x=$(field "$row" 5)
    PW_DBG="$dbg" PW_X="$x" PW_W="$WIN_W" PW_H="$WIN_H" PW_Y="$WIN_Y" \
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
      ' 2>/dev/null && echo "  tiled $name at x=$x"
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
