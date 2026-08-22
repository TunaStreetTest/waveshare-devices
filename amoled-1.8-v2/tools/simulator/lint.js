#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 Steven Matison
 *
 * SPDX-License-Identifier: Apache-2.0
 */
/*
 * The pre-flash check, referenced by name in uikit/tokens.json's own
 * comment: "tools/simulator/lint.js (the pre-flash check)". Two passes:
 *
 *   1. Dynamic reachability: boot the package under --fixture, hook every
 *      SystemGui call and fail on any {success:false} (that is how a dead
 *      binding path can ship unnoticed), fire every
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
    // can otherwise ship without tripping anything.
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
const LADDER = (T.text && T.text.font_ladder) || [];
const LINE_H = (T.text && T.text.line_height) || {};
const CORNER_R = (T.safe_area && T.safe_area.corner_radius) || 0;
// The same set as uikit/lint.py's TAP_EVENT_TYPES: every event that makes a
// node a touch TARGET, as opposed to a gesture listener. tokens.traps
// .tap_events is the press/release pair R2 polices; R11 also counts the
// single-shot forms, because they fire under a drag just the same.
const TAP_EVENT_TYPES = (T.traps.tap_events || []).concat(["pressing", "clicked"])
    .filter((v, i, a) => a.indexOf(v) === i);
// Horizontal inset the rounded glass demands at `d` px from the top/bottom edge.
function cornerInset(d) {
    if (!CORNER_R || d >= CORNER_R || d < 0) { return 0; }
    return Math.ceil(CORNER_R - Math.sqrt(Math.max(0, CORNER_R * CORNER_R - (CORNER_R - d) * (CORNER_R - d))));
}
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
                report(rel, node._path, "R3", "fontSize " + fs2 + " is under the " + T.text.floor + "px floor (unreadable at typical holding distance)");
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
        // a tap zone consumes every tap and the zone under it never fires.
        // The symptom is a control that looks correct and issues no requests.
        if (node.type === "image") {
            const cp = node.commonProps || {};
            if (!Object.prototype.hasOwnProperty.call(cp, "clickable")) {
                report(rel, node._path, "R6", "image does not declare commonProps.clickable -- it defaults to true and will swallow taps meant for whatever is underneath");
            }
        }

        // R8: a fontSize that is not on the compiled Montserrat ladder.
        // There is no FreeType and no TinyTTF in this build, so a size is not
        // scaled to order -- get_builtin_font() (gui/brookesia_gui_lvgl/src/
        // style_font.cpp) returns an exact match or else the closest SMALLER
        // compiled face. An off-ladder size therefore renders silently smaller
        // than it reads here: the shell's 11sp clock was drawn at 8px, and a
        // 56px "hero" is really 48px. Rungs come from tokens.json text.font_ladder.
        const fs = node.style && node.style.fontSize;
        if (typeof fs === "number" && LADDER.indexOf(fs) === -1) {
            let drawn = null;
            for (const rung of LADDER) { if (rung <= fs) { drawn = rung; } }
            report(rel, node._path, "R8", "fontSize " + fs + " is not a compiled Montserrat size -- it will render at " +
                   (drawn === null ? "the LVGL default (no smaller face exists)" : drawn + "px") +
                   ". Use one of: " + LADDER.join(", "));
        }

        // R9: a label box shorter than the font's real line height, which
        // clips descenders. Heights come from tokens.json text.line_height --
        // the actual .line_height in each lv_font_montserrat_<n>.c, since the
        // desktop habit of assuming ~1.3x the nominal size is wrong here (the
        // real ratio is ~1.1x) and both over- and under-reports.
        {
            const lfs = node.style && node.style.fontSize;
            const declaredH = node.placement && node.placement.height;
            const need = LINE_H[String(lfs)];
            if (node.type === "label" && typeof need === "number" &&
                typeof declaredH === "number" && declaredH < need) {
                report(rel, node._path, "R9", "label box is " + declaredH + "px tall but Montserrat " + lfs +
                       " has a line height of " + need + "px -- descenders will be clipped");
            }
        }

        // R10: edge-anchored text sitting inside a rounded corner.
        // The glass is a rounded rectangle, so near the top and bottom edges the
        // usable width is less than the panel width. Text at the normal 16px
        // edge inset but only a few pixels down is inside the arc and reads as
        // jammed into the curve -- reported twice on x-viewer's "n/N" counter,
        // which sat at x=16,y=2 and needs 38px of inset there.
        //
        // Only LEFT- and RIGHT-aligned text is at risk: a centred label's box may
        // span the full width while its glyphs sit safely in the middle.
        if (node.type === "label" && CORNER_R) {
            const align = (node.style && node.style.textAlign) || "left";
            const bx = node._cx || 0, by = node._cy || 0;
            const bw = node._cw || 0, bh = node._ch || 0;
            const dTop = by, dBottom = T.device.height - (by + bh);
            const d = Math.min(dTop < 0 ? 0 : dTop, dBottom < 0 ? 0 : dBottom);
            const need = cornerInset(d);
            if (need > 0 && align !== "center") {
                if (align === "left" && bx < need) {
                    report(rel, node._path, "R10", "left-aligned text starts at x=" + bx + " but the rounded corner needs x>=" +
                           need + " this close to the edge (" + d + "px). Move it down or in.");
                } else if (align === "right" && (T.device.width - (bx + bw)) < need) {
                    report(rel, node._path, "R10", "right-aligned text ends at x=" + (bx + bw) + " but the rounded corner needs it to end by x<=" +
                           (T.device.width - need) + " this close to the edge (" + d + "px). Move it down or in.");
                }
            }
        }

        // R11: trap 5 -- a big tap target inside a swipe surface.
        //
        // LVGL sends exactly ONE gesture per finger-down/up (indev->pointer
        // .gesture_sent latches after the first), so the swipe is never what
        // fires twice. A tap target under the same finger is: panelkit emits
        // its action on `pressed` AND on `released` deliberately. One drag
        // across a half-panel nav zone scored three navigations -- two from
        // the zone, one from the gesture -- and the zone's two went in
        // whichever direction the drag STARTED. That is #220's "tap and swipe
        // collision". A small control inside a swipe surface is fine; past
        // traps.gesture_target_ratio of the surface in BOTH axes, the
        // "control" is the drag surface.
        if (T.traps.forbid_target_over_gesture && T.traps.gesture_target_ratio && node.events) {
            const isTarget = node.events.some((ev) => TAP_EVENT_TYPES.indexOf(ev.type) > -1);
            if (isTarget) {
                let anc = node._parent, surface = null;
                while (anc) {
                    if ((anc.events || []).some((ev) => ev.type === "gesture")) { surface = anc; break; }
                    anc = anc._parent;
                }
                if (surface) {
                    // A screen root carries no box of its own -- it is the panel.
                    const sw = surface._cw || T.device.width, sh = surface._ch || T.device.height;
                    const w = node._cw || 0, h = node._ch || 0;
                    const r = T.traps.gesture_target_ratio;
                    if (sw > 0 && sh > 0 && w >= sw * r && h >= sh * r) {
                        report(rel, node._path, "R11", w + "x" + h + " tap target covers " +
                               Math.round(100 * w / sw) + "%x" + Math.round(100 * h / sh) +
                               "% of the swipe surface " + surface._path + " -- a drag starting on it fires this " +
                               "action on pressed AND released as well as the gesture. Make it small or drop the tap.");
                    }
                }
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
