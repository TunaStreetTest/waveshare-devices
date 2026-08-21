/*
 * "Claude drives" (#205, generalised for #212) -- control a real Chromium
 * window over CDP, for any app the simulator can run.
 *
 * Launches a visible browser on the desktop, opens the panel simulator
 * (serve.js must already be running), engages the autopilot if a driver is
 * loaded, and screenshots the run. Node 24's built-in WebSocket speaks CDP
 * directly, so this needs no puppeteer/playwright install.
 *
 * Always closes the Chromium it opened -- on normal completion, on error, and
 * on SIGINT/SIGTERM -- so a run never leaves an orphan window (or a stray
 * process still holding its --user-data-dir) on the desk.
 *
 *   node serve.js &
 *   node drive.js [seconds] [outPrefix] [url]
 *   PANEL_SIM_URL="http://127.0.0.1:8095/?app=tunastreet.xviewer&claude=1" node drive.js 30
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SECONDS = Number(process.argv[2] || 60);
const OUT = process.argv[3] || "/tmp/claude-panel-sim";
const TARGET_URL = process.argv[4] || process.env.PANEL_SIM_URL ||
    "http://127.0.0.1:8095/?app=tunastreet.racing&drive=examples/racing-bot.js&claude=1";
const PORT = 9333;
const PROFILE_DIR = process.env.PANEL_SIM_CHROME_PROFILE || "/tmp/claude-panel-sim-chrome-profile";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function cdpTargets() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return r.json();
}

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.onmessage = (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id && pending.has(msg.id)) {
                const { resolve: res, reject: rej } = pending.get(msg.id);
                pending.delete(msg.id);
                msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
            }
        };
        ws.onerror = (e) => reject(new Error("ws error " + (e.message || "")));
        ws.onopen = () => resolve({
            send(method, params) {
                const mid = ++id;
                return new Promise((res, rej) => {
                    pending.set(mid, { resolve: res, reject: rej });
                    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
                });
            },
            close() { ws.close(); },
        });
    });
}

let chrome = null;
let closing = false;

// Kills the whole process group chromium spawned (it forks a zygote, GPU,
// renderer, utility processes -- killing just the top PID leaves the rest).
// Idempotent and safe to call more than once (exit handler + normal path
// both call it).
function closeChrome() {
    if (closing || !chrome || chrome.exitCode !== null || chrome.killed) { return; }
    closing = true;
    try { process.kill(-chrome.pid, "SIGTERM"); } catch (e) { /* already gone */ }
    setTimeout(() => {
        try { process.kill(-chrome.pid, "SIGKILL"); } catch (e) { /* already gone */ }
    }, 2000).unref();
}

process.on("SIGINT", () => { closeChrome(); process.exit(130); });
process.on("SIGTERM", () => { closeChrome(); process.exit(143); });

(async function main() {
    const port = new URL(TARGET_URL).port || "8095";
    chrome = spawn("/snap/bin/chromium", [
        // Its own profile matters: launching chromium while the user's instance
        // is running otherwise just opens a tab over there and the debug port
        // never binds, so nothing is controllable. detached:true so
        // process.kill(-chrome.pid, ...) below can reap chromium's whole
        // process group (zygote/GPU/renderer), not just the top PID.
        `--remote-debugging-port=${PORT}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run", "--no-default-browser-check",
        `--app=${TARGET_URL}`,
        "--window-size=420,610",
        "--window-position=80,80",
    ], { detached: true, stdio: "ignore" });
    console.log("[drive] chromium launched:", TARGET_URL);

    let cdp = null;
    try {
        // wait for the debugger and the page
        let target = null;
        for (let i = 0; i < 60 && !target; i++) {
            await sleep(500);
            try {
                const list = await cdpTargets();
                target = list.find((t) => t.type === "page" && t.url.indexOf(":" + port) >= 0);
            } catch (e) { /* not up yet */ }
        }
        if (!target) { throw new Error("could not find the simulator tab -- is serve.js running?"); }

        cdp = await connect(target.webSocketDebuggerUrl);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        console.log("[drive] attached to", target.url);
        await sleep(2500);   // app boot + first fetch

        // make sure the autopilot is engaged even if ?claude= raced the load
        await cdp.send("Runtime.evaluate", {
            expression: `(() => { const b = document.getElementById("auto");
                if (b && !b.disabled && b.textContent.indexOf("DRIVING") < 0) b.click();
                return b ? b.textContent : "no button"; })()`,
        });

        const shots = [];
        const EVERY = Math.max(1, Math.floor(SECONDS / 6));
        for (let s = 0; s < SECONDS; s++) {
            await sleep(1000);
            if (s % EVERY === 0 || s === SECONDS - 1) {
                const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
                const f = `${OUT}-${String(shots.length).padStart(2, "0")}.png`;
                fs.writeFileSync(f, Buffer.from(data, "base64"));
                shots.push(f);
                // Generic status: prefer the driver's own summary() if it has
                // one, else fall back to a plain label dump -- this file has
                // no per-app knowledge, unlike the #205 version it replaces.
                const st = await cdp.send("Runtime.evaluate", {
                    expression: `(() => { try {
                        if (window.driver && window.driver.summary) return window.driver.summary();
                        return JSON.stringify(window.sim.renderer.dumpLabels());
                    } catch (e) { return "status eval failed: " + e; } })()`,
                    returnByValue: true,
                });
                console.log(`[drive] t=${s}s`, st.result.value, "->", path.basename(f));
            }
        }
        const final = await cdp.send("Runtime.evaluate", {
            expression: `(() => { try {
                if (window.driver && window.driver.summary) return window.driver.summary();
                return JSON.stringify(window.sim.renderer.dumpLabels());
            } catch (e) { return "status eval failed: " + e; } })()`,
            returnByValue: true,
        });
        console.log("[drive] final:", final.result.value);
        console.log("[drive] shots:", shots.join(" "));
    } finally {
        if (cdp) { try { cdp.close(); } catch (e) { /* ignore */ } }
        closeChrome();
    }
    process.exit(0);
})().catch((e) => {
    console.error("[drive] fatal:", e.message || e);
    closeChrome();
    process.exit(1);
});
