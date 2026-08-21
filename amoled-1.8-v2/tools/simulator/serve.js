#!/usr/bin/env node
/*
 * Standalone static server for the simulator (#212) -- Node built-ins only
 * (http/fs/path), no app backend required. Serves the panel + its scripts,
 * and the package files themselves so the simulator runs the shipped files
 * unmodified, exactly like amoled-racing/backend/server.py did for racing
 * alone, but for any app under apps/.
 *
 *   node serve.js [--port 8095]
 *   -> http://127.0.0.1:8095/?app=tunastreet.xviewer
 *   -> http://127.0.0.1:8095/?app=tunastreet.racing&drive=examples/racing-bot.js
 *
 * Ports already in use on this host as of #212: 8091 (xviewer backend),
 * 8092 (ember backend), 8093 (racing backend), 8099 (unrelated). Default
 * here is 8095.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { resolveAppDir, APP_ID_RE } = require("./pkg.js");

const SIM_DIR = __dirname;
const APPS_ROOT = path.resolve(__dirname, "..", "..", "apps");

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return (i > -1 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : def;
}
const PORT = Number(argVal("--port", process.env.PANEL_SIM_PORT || 8095));

// --proxy 127.0.0.1:8091 forwards any non-simulator path to that app's real
// backend, so the panel can be watched against live data instead of fixtures.
const PROXY = (() => {
    const v = argVal("--proxy", process.env.PANEL_SIM_PROXY || "");
    if (!v) { return null; }
    const [host, port] = v.replace(/^https?:\/\//, "").split(":");
    return { host: host || "127.0.0.1", port: Number(port || 80) };
})();

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".css": "text/css; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
};

function send(res, status, body, headers) {
    // This is a dev harness serving files that change between every test run
    // -- never let the browser (or an intermediate proxy) cache a stale copy.
    res.writeHead(status, Object.assign(
        { "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }, headers || {}));
    res.end(body);
}

function serveFile(res, filePath) {
    fs.readFile(filePath, (err, data) => {
        if (err) { send(res, 404, "not found: " + filePath, { "Content-Type": "text/plain" }); return; }
        const ext = path.extname(filePath).toLowerCase();
        send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream" });
    });
}

// Same containment discipline as amoled-racing/backend/server.py's
// pkg_file()/sim_js(): resolve, then require the resolved path to still be
// inside the root it's supposed to come from.
function safeJoin(root, rel) {
    const target = path.resolve(root, "." + path.sep + rel);
    if (target !== root && !target.startsWith(root + path.sep)) { return null; }
    return target;
}

const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch (e) { send(res, 400, "bad url", {}); return; }
    const p = decodeURIComponent(url.pathname);

    if (p === "/") {
        serveFile(res, path.join(SIM_DIR, "panel.html"));
        return;
    }

    if (p.startsWith("/sim/")) {
        const target = safeJoin(SIM_DIR, p.slice("/sim/".length));
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
            send(res, 404, "no such simulator file", { "Content-Type": "text/plain" });
            return;
        }
        serveFile(res, target);
        return;
    }

    if (p.startsWith("/pkg/")) {
        const rest = p.slice("/pkg/".length); // "<app-id>/sub/path"
        const slash = rest.indexOf("/");
        const appId = slash === -1 ? rest : rest.slice(0, slash);
        const sub = slash === -1 ? "" : rest.slice(slash + 1);
        if (!APP_ID_RE.test(appId)) { send(res, 400, "bad app id", { "Content-Type": "text/plain" }); return; }
        let appDir;
        try { appDir = resolveAppDir(appId); } catch (e) { send(res, 404, e.message, { "Content-Type": "text/plain" }); return; }
        const target = safeJoin(appDir, sub);
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
            send(res, 404, "not in package", { "Content-Type": "text/plain" });
            return;
        }
        serveFile(res, target);
        return;
    }

    // Anything else is the app's own backend call. panel.html rewrites the
    // app's LAN base to this page's origin (cross-origin requests land but
    // CORS blocks reading the reply -- the #205 "leaderboard unreachable"
    // trap), so with --proxy the harness forwards them to the real backend
    // and the panel shows live data. Without --proxy, use ?fixture=1.
    if (PROXY) {
        proxyTo(req, res, p + url.search);
        return;
    }

    send(res, 404, "not found (no --proxy given; use ?fixture=1 for canned data)",
         { "Content-Type": "text/plain" });
});

function proxyTo(req, res, pathWithQuery) {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = Object.assign({}, req.headers, { host: PROXY.host + ":" + PROXY.port });
        if (body.length) { headers["content-length"] = String(body.length); }
        const up = http.request({
            host: PROXY.host, port: PROXY.port, method: req.method,
            path: pathWithQuery, headers,
        }, (r) => {
            res.writeHead(r.statusCode || 502, r.headers);
            r.pipe(res);
        });
        up.on("error", (e) => {
            send(res, 502, "proxy to " + PROXY.host + ":" + PROXY.port + " failed: " + e.message,
                 { "Content-Type": "text/plain" });
        });
        if (body.length) { up.write(body); }
        up.end();
    });
}

server.listen(PORT, () => {
    console.log("[serve] simulator on http://127.0.0.1:" + PORT + "/  (apps root: " + APPS_ROOT + ")");
    console.log("[serve] e.g. http://127.0.0.1:" + PORT + "/?app=tunastreet.xviewer");
});
