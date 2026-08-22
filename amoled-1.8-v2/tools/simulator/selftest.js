/*
 * Simulator selftest -- behavioural regressions the static lint cannot see.
 *
 * Sibling of uikit/selftest.py: that one proves the generators refuse to emit a
 * bad screen, this one proves a shipped app.js behaves under a synthesised
 * touch sequence. Boots each app's REAL app/app.js under the shim, drives it,
 * and asserts on what the view tree ends up showing.
 *
 *   node selftest.js
 *
 * Runs on real wall-clock on purpose: the shim does not virtualise Date.now(),
 * and Date.now() is exactly what the apps' swipe guards read. Nothing here
 * touches a backend -- every app boots on its fixture.
 */
"use strict";

const path = require("path");
const { resolvePkg } = require("./pkg.js");
const { loadFixture, makeFixtureFetch } = require("./fixtures.js");

require(path.join(__dirname, "shim.js"));
const { Shim, StateRenderer } = globalThis.PanelKit;

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  -- " + detail : ""));
    if (!ok) { failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* "n/N" is 1-based and wraps, so 3 -> 1 on a 3-card feed is one step forward. */
function steppedOnce(before, after, count) {
    return count > 0 && after === (before % count) + 1;
}

/* Let pending fixture fetches resolve and their render land. */
async function settle(shim) {
    for (let i = 0; i < 10; i++) {
        await sleep(20);
        shim.advance(0);
    }
}

/* Boot an app package under the shim on its fixture, with a clean global. */
function boot(appId) {
    const pkg = resolvePkg(appId);
    const renderer = new StateRenderer();
    const logs = [];
    const requests = [];
    const map = loadFixture(appId) || {};
    const fixtureFetch = makeFixtureFetch(map, (s) => logs.push(s));
    const shim = new Shim({
        screen: pkg.screen,
        renderer,
        log: (s) => logs.push(s),
        // Record what the app actually put on the wire. For an app whose
        // navigation is server-side, the request count IS the observable --
        // the rendered index only moves when a response comes back.
        httpFetch: (request) => {
            requests.push(((request.method || "Get") + " " + request.url).toUpperCase());
            return fixtureFetch(request);
        },
    });
    shim.install();
    (0, eval)(pkg.appJs);
    shim.start();
    return { shim, renderer, logs, pkg, requests };
}

/*
 * One continuous drag must move exactly one card.
 *
 * IMPORTANT: a real swipe on the glass produces BOTH kinds of event, and a test
 * that only sends one of them is testing half a swipe. The prev/next tap zones
 * cover the halves of the media card -- the very area you drag across -- and
 * panelkit fires their action on `pressed` AND `released`; meanwhile the touch
 * layer emits gesture events for as long as the finger moves. So this drives:
 *
 *     pressed(tap zone) -> gesture x N -> released(tap zone)
 *
 * The first version of this test emitted only the gesture events. It passed,
 * shipped, and the panel then stepped SIX cards on one swipe, because taps and
 * swipes had been given independent debounce clocks and each scored the same
 * finger movement separately. Do not simplify this back to gesture-only.
 */
async function swipeBurst(appId, action, tapAction, readIndex, readCount) {
    console.log("\n" + appId + " -- swipe burst latch (tap zone + gesture, as on the glass)");
    const { shim } = boot(appId);
    await settle(shim);

    const before = readIndex(shim);
    shim.emit(tapAction, {});                    // finger down on the nav zone
    for (let i = 0; i < 15; i++) {               // ~600ms of continuous drag
        shim.emit(action, { direction: "left", distance: 20 * i, ms: 40 * i });
        await sleep(40);
    }
    shim.emit(tapAction, {});                    // finger up, same zone
    const count = readCount(shim);
    const afterDrag = readIndex(shim);
    check(appId + ": one 600ms drag over a tap zone steps exactly once",
          steppedOnce(before, afterDrag, count),
          "index " + before + " -> " + afterDrag + " of " + count);

    await sleep(500);
    const beforeSecond = readIndex(shim);
    shim.emit(tapAction, {});
    shim.emit(action, { direction: "left", distance: 20, ms: 40 });
    shim.emit(tapAction, {});
    check(appId + ": a second swipe after the quiet window steps exactly once",
          steppedOnce(beforeSecond, readIndex(shim), count),
          "index " + beforeSecond + " -> " + readIndex(shim) + " of " + count);

    await sleep(500);
    const beforeTap = readIndex(shim);
    shim.emit(tapAction, {});                    // a clean tap (no drag) still works
    check(appId + ": a plain tap on the nav zone still steps once",
          steppedOnce(beforeTap, readIndex(shim), count),
          "index " + beforeTap + " -> " + readIndex(shim) + " of " + count);

    await sleep(500);
    const beforeV = readIndex(shim);
    shim.emit(action, { direction: "up", distance: 120, ms: 100 });
    check(appId + ": vertical gesture is ignored (system home gesture)",
          readIndex(shim) === beforeV);
}

/*
 * Every label a shipped screen can show must be drawable. There is no FreeType
 * and no TinyTTF on this build, so glyphs come from a compiled-in Montserrat
 * that carries ASCII and nothing else -- a non-ASCII character is a white tofu
 * box on the glass. panelkit refuses these at generation time; this catches the
 * other half, a literal baked into app.js and written with SetText at runtime.
 */
function asciiOnly(appId) {
    console.log("\n" + appId + " -- no non-ASCII reaches a label");
    const { shim, renderer } = boot(appId);
    shim.advance(5000);
    const labels = renderer.dumpLabels ? renderer.dumpLabels() : {};
    const bad = [];
    for (const p of Object.keys(labels)) {
        const text = String(labels[p] === null || labels[p] === undefined ? "" : labels[p]);
        for (const ch of text) {
            const cp = ch.codePointAt(0);
            if (cp > 126 || (cp < 32 && ch !== "\n")) {
                bad.push(p + " = " + JSON.stringify(text) + " (U+" +
                         cp.toString(16).toUpperCase().padStart(4, "0") + ")");
                break;
            }
        }
    }
    check(appId + ": every rendered label is ASCII", bad.length === 0, bad.join("; "));
}

/*
 * Same latch, asserted on the wire.
 *
 * tminus navigates server-side: a swipe POSTs /tminus/step and the backend
 * decides which card is next, so with a static fixture the rendered index
 * cannot move. What CAN be observed -- and what actually matters -- is how many
 * step requests one continuous drag put on the wire. Exactly one.
 */
async function swipeStepRequests(appId, action, pathFragment) {
    console.log("\n" + appId + " -- swipe burst latch (requests on the wire)");
    const { shim, requests } = boot(appId);
    await settle(shim);

    const before = requests.filter((r) => r.includes(pathFragment)).length;
    shim.emit("tminus.next", {});                // finger down on the nav zone
    for (let i = 0; i < 15; i++) {
        shim.emit(action, { direction: "left", distance: 20 * i, ms: 40 * i });
        await sleep(40);
    }
    shim.emit("tminus.next", {});                // finger up
    await settle(shim);
    const issued = requests.filter((r) => r.includes(pathFragment)).length - before;
    check(appId + ": one 600ms drag issues exactly one step request",
          issued === 1, "issued " + issued);

    await sleep(300);
    const mark = requests.filter((r) => r.includes(pathFragment)).length;
    shim.emit(action, { direction: "left", distance: 20, ms: 40 });
    await settle(shim);
    check(appId + ": a second swipe after the quiet window still steps",
          requests.filter((r) => r.includes(pathFragment)).length === mark + 1);

    await sleep(300);
    const mark2 = requests.filter((r) => r.includes(pathFragment)).length;
    shim.emit(action, { direction: "up", distance: 120, ms: 100 });
    await settle(shim);
    check(appId + ": vertical gesture is ignored (system home gesture)",
          requests.filter((r) => r.includes(pathFragment)).length === mark2);
}

(async function main() {
    const APPS = ["tunastreet.agent", "tunastreet.tminus", "tunastreet.xviewer", "tunastreet.racing"];

    await swipeBurst("tunastreet.xviewer", "xviewer.gesture", "xviewer.next",
                     (s) => Number((s.renderer.text("/home/topbar/pos") || "1/1").split("/")[0]),
                     (s) => Number((s.renderer.text("/home/topbar/pos") || "1/1").split("/")[1]));
    await swipeStepRequests("tunastreet.tminus", "tminus.gesture", "/TMINUS/STEP");

    for (const a of APPS) { asciiOnly(a); }

    console.log("\n" + (failures ? failures + " FAILURE(S)" : "all checks passed"));
    process.exit(failures ? 1 : 0);
})();
