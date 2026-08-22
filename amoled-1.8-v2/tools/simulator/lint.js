#!/usr/bin/env node
/*
 * The pre-flash check (#212), referenced by name in uikit/tokens.json's own
 * comment: "tools/simulator/lint.js (the pre-flash check)". Two passes:
 *
 *   1. Dynamic reachability: boot the package under --fixture, hook every
 *      SystemGui call and fail on any {success:false} (that is how a dead
 *      g_clock path shipped in #205 without anyone noticing), fire every
 *      action the app subscribed to once, and advance the clock past every
 *      registered timer interval so every on_timer branch runs too.
 *   2. Static token/trap lint over res/screens/*.json, thresholds read from
 *      uikit/tokens.json (never hardcoded here) -- rules R1-R7, kept in this
 *      order to match the Python twin (uikit/lint.py) a sibling agent is
 *      writing for the same tokens file.
 *
 * This is structural + reachability, NOT proof the app plays correctly --
 * see README.md's "what --check does not cover".
 *
 *   node lint.js --check tunastreet.xviewer
 *   node lint.js --app tunastreet.racing --check
 *
 * Exit code is the number of findings (capped at 255), 0 = clean.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { resolvePkg, listScreenFiles } = require("./pkg.js");
const { loadFixture, makeFixtureFetch } = require("./fixtures.js");

const TOKENS_PATH = path.resolve(__dirname, "..", "..", "uikit", "tokens.json");

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return (i > -1 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : def;
}

// --check takes the app id either as its own value ("--check tunastreet.x")
// or via --app alongside a bare --check flag ("--app tunastreet.x --check").
let APP = argVal("--app", null);
const checkIdx = process.argv.indexOf("--check");
if (checkIdx > -1) {
    const next = process.argv[checkIdx + 1];
    if (next && next[0] !== "-") { APP = APP || next; }
}
if (!APP) {
    console.error("usage: node lint.js --check <app-id>   (or: --app <app-id> --check)");
    process.exit(2);
}

if (!fs.existsSync(TOKENS_PATH)) {
    console.error("lint.js: missing " + TOKENS_PATH + " -- cannot lint without the design tokens");
    process.exit(2);
}
const TOKENS = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));

const findings = []; // {file, node, rule, message}
function report(file, node, rule, message) {
    findings.push({ file, node, rule, message });
    console.log(file + ":" + node + " " + rule + " " + message);
}

// ---------------------------------------------------------------- dynamic pass
async function dynamicCheck(pkg) {
    require(path.join(__dirname, "shim.js"));
    const { Shim, StateRenderer } = globalThis.PanelKit;

    const map = loadFixture(pkg.id);
    if (!map) { console.log("[lint] WARN: no fixtures/" + pkg.id + ".json - every request synthesizes 200 {}"); }
    const logs = [];
    const httpFetch = makeFixtureFetch(map || {}, (s) => logs.push(s));
    const renderer = new StateRenderer();
    const shim = new Shim({ screen: pkg.screen, renderer, log: (s) => logs.push(s), httpFetch });

    // Hook SystemGui: any {success:false} during boot/action-sweep/timer-sweep
    // is a dynamic-check failure (R0) -- this is how a dead g_clock path
    // shipped in #205 without tripping anything.
    const origGui = shim.gui.bind(shim);
    shim.gui = function (fn, p) {
        const r = origGui(fn, p);
        if (!r.success) {
            report(pkg.screenPath, (p && p.Path) || "(no path)", "R0",
                "SystemGui." + fn + " failed during --check: " + r.error);
        }
        return r;
    };

    shim.install();
    (0, eval)(pkg.appJs);
    shim.start();
    await new Promise((r) => setTimeout(r, 50));

    // Fire every action the app subscribed to, once.
    for (const action in shim.subscribedActions) {
        shim.emit(action, {});
    }
    await new Promise((r) => setTimeout(r, 50));

    // Advance the clock far enough that every currently-registered timer
    // fires at least once (periodic timers with a shorter interval fire
    // several times along the way -- harmless, on_timer is idempotent-safe
    // by contract).
    let maxInterval = 0;
    for (const id in shim.timers) {
        const t = shim.timers[id];
        maxInterval = Math.max(maxInterval, t.every || (t.at - shim.timeMs));
    }
    if (maxInterval > 0) {
        shim.advance(maxInterval + 50);
        await new Promise((r) => setTimeout(r, 50));
    }

    const errLines = logs.filter((l) => /fail|error/i.test(l));
    if (errLines.length) {
        console.log("[lint] " + pkg.id + ": " + errLines.length + " app-log error/fail line(s) during --check (not auto-failed, informational):");
        errLines.slice(0, 5).forEach((l) => console.log("   " + l));
    }
}

// ---------------------------------------------------------------- static pass
function walk(node, parent, fn) {
    fn(node, parent);
    (node.children || []).forEach((c) => walk(c, node, fn));
}

function staticCheck(pkg) {
    const { Doc } = globalThis.PanelKit;
    const files = listScreenFiles(pkg);
    for (const file of files) {
        const screen = JSON.parse(fs.readFileSync(file, "utf8"));
        const doc = new Doc(screen);
        doc.computeGeometry();
        checkScreen(file, doc);
    }
}

function checkScreen(file, doc) {
    const T = TOKENS;
    const rel = path.relative(path.resolve(__dirname, "..", ".."), file);

    walk(doc.root, null, (node, parent) => {
        const layoutType = node.layout && node.layout.type;

        // R1: a flex/grid container with an absolutely-placed child.
        if (layoutType === "flex" || layoutType === "grid") {
            (node.children || []).forEach((c) => {
                if (c.placement && c.placement.mode === "absolute") {
                    report(rel, c._path, "R1",
                        "absolute child under a " + layoutType + " parent (" + node._path + ") -- flex silently overrides x/y");
                }
            });
        }

        // R2a: requireValidPress drops a tap the finger drifted through.
        if (T.traps.forbid_require_valid_press && node.events) {
            node.events.forEach((ev) => {
                (ev.effects || []).forEach((eff) => {
                    if (eff.requireValidPress === true) {
                        report(rel, node._path, "R2", "requireValidPress:true on action \"" + eff.action + "\" (forbidden by uikit/tokens.json traps.forbid_require_valid_press)");
                    }
                });
            });
        }

        // R2b/c: nodes using the "pressed"/"released" tap-cycle (tokens.traps
        // .tap_events) must declare pressLock:true and scrollable:false
        // explicitly, or a drag reads as a scroll / a drifted tap drops.
        // "clicked"-type taps (a single synthesized event, not a press/
        // release pair) aren't subject to this -- see README.md.
        if (node.events && node.events.some((ev) => (T.traps.tap_events || []).includes(ev.type))) {
            const cp = node.commonProps || {};
            if (cp.pressLock !== T.traps.container_press_lock) {
                report(rel, node._path, "R2", "uses " + T.traps.tap_events.join("/") + " events but commonProps.pressLock is not " + T.traps.container_press_lock);
            }
            if (cp.scrollable !== T.traps.container_scrollable) {
                report(rel, node._path, "R2", "uses " + T.traps.tap_events.join("/") + " events but commonProps.scrollable is not " + T.traps.container_scrollable);
            }
        }

        // R3: text floor.
        if (node.type === "label") {
            const fs2 = node.style && node.style.fontSize;
            if (typeof fs2 === "number" && fs2 < T.text.floor) {
                report(rel, node._path, "R3", "fontSize " + fs2 + " is under the " + T.text.floor + "px floor (unreadable at arm's length, #205)");
            }
        }

        // R5: off-panel -- an absolute node escaping the device box. Skip
        // nodes whose placement.x/y are runtime-bound (e.g. racing's
        // off-screen obstacle spawns): their static JSON position is a
        // parking spot, not where they render.
        if (node.placement && node.placement.mode === "absolute") {
            const bound = node.bindings && (node.bindings["placement.x"] || node.bindings["placement.y"]);
            if (!bound) {
                const x = node._cx, y = node._cy;
                const w = node._cw || 0, h = node._ch || 0;
                if (x < 0 || y < 0 || x + w > T.device.width || y + h > T.device.height) {
                    report(rel, node._path, "R5", "escapes the " + T.device.width + "x" + T.device.height + " panel: box=(" + x + "," + y + "," + w + "," + h + ")");
                }
            }
        }

        // R6: an image that doesn't declare `clickable`. The runtime defaults
        // an image node to clickable:true (parser_node.cpp
        // default_clickable_for_node_type), so a decorative picture drawn over
        // a tap zone eats every tap and the zone under it never fires --
        // T-MINUS's launch art, found on the glass 2026-08-21 by the backend
        // never receiving a single /tminus/step.
        if (node.type === "image") {
            const cp = node.commonProps || {};
            if (!Object.prototype.hasOwnProperty.call(cp, "clickable")) {
                report(rel, node._path, "R6", "image does not declare commonProps.clickable -- it defaults to true and will swallow taps meant for whatever is underneath");
            }
        }

        // R7: text outside ASCII. No FreeType on this board, so every label
        // falls back to LVGL's built-in Montserrat and anything above 0x7E
        // renders as a white box (the nav chevrons U+2039/203A and the middle
        // dots in "Go - 4/8" both shipped that way).
        const txt = node.labelProps && node.labelProps.text;
        if (typeof txt === "string") {
            for (const ch of txt) {
                const cp = ch.codePointAt(0);
                if (cp > 126 || (cp < 32 && ch !== "\n")) {
                    report(rel, node._path, "R7", "text " + JSON.stringify(txt) + " contains U+" + cp.toString(16).toUpperCase().padStart(4, "0") + ", outside built-in Montserrat's ASCII range -- renders as a white box");
                    break;
                }
            }
        }
    });

    // R4: two sibling tap targets closer than target_gap_min. Only nodes
    // shaped like an actual discrete button (height within the measured
    // touch.target_h_min/max band) qualify -- racing's in-game lane zones
    // are full-height thirds *by design* ("target the outcome, not the
    // control", uikit/tokens.json's own note), not spaced buttons, so a
    // zero gap between them is correct, not a trap.
    walk(doc.root, null, (parent) => {
        const kids = (parent.children || []).filter((c) => c.events && c.events.length);
        const buttons = kids.filter((c) => {
            const h = c._ch || 0;
            return h >= T.touch.target_h_min && h <= T.touch.target_h_max;
        });
        for (let i = 0; i < buttons.length; i++) {
            for (let j = i + 1; j < buttons.length; j++) {
                const a = buttons[i], b = buttons[j];
                const gap = Math.max(
                    a._cx - (b._cx + (b._cw || 0)),
                    b._cx - (a._cx + (a._cw || 0)),
                    a._cy - (b._cy + (b._ch || 0)),
                    b._cy - (a._cy + (a._ch || 0))
                );
                if (gap < T.touch.target_gap_min) {
                    report(rel, a._path + " / " + b._path, "R4",
                        "tap targets " + gap.toFixed(0) + "px apart, under the " + T.touch.target_gap_min + "px minimum");
                }
            }
        }
    });
}

(async function main() {
    let pkg;
    try {
        pkg = resolvePkg(APP);
    } catch (e) {
        console.error("[lint] " + e.message);
        process.exit(2);
    }
    console.log("[lint] --check " + pkg.id + " (screen: " + pkg.screenId + ")");
    await dynamicCheck(pkg);
    staticCheck(pkg);

    if (findings.length) {
        console.log("[lint] " + pkg.id + ": " + findings.length + " finding(s)");
        process.exit(Math.min(findings.length, 255));
    }
    console.log("[lint] " + pkg.id + ": clean");
    process.exit(0);
})().catch((e) => {
    console.error("[lint] fatal:", e.stack || e);
    process.exit(1);
});
