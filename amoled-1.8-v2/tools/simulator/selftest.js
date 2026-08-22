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
 * One drag is one card, and the NEXT drag is the next card.
 *
 * This test used to drive `pressed(tap zone) -> gesture x N -> released(tap
 * zone)` and assert a debounce swallowed the extras. Both halves of that model
 * were wrong, which is why the panel kept mis-stepping while the harness stayed
 * green (#220):
 *
 *   * The touch layer does NOT emit gesture after gesture. LVGL latches
 *     indev->pointer.gesture_sent on the first gesture of a press, so a drag of
 *     any length produces exactly ONE (lv_indev.c, indev_gesture()).
 *   * The extra steps came from the tap zones, which covered the very area the
 *     finger drags across and fire on `pressed` AND `released`. One drag =
 *     2 taps + 1 gesture = 3 cards, and the 2 taps went in whichever direction
 *     the drag STARTED.
 *
 * So the fix was structural, not a longer cooldown: neither app has a tap
 * target under the swipe any more (uikit lint R11 now refuses to let one back
 * in), and the debounce is gone. Which makes the second assertion here the
 * important one -- with a cooldown, two real swipes in quick succession scored
 * one card, and that is exactly what "it takes a touch and a swipe to move
 * forward more than once" was.
 */
async function swipeBurst(appId, action, readIndex, readCount) {
    console.log("\n" + appId + " -- one drag, one card (no tap target under the swipe)");
    const { shim, pkg } = boot(appId);
    await settle(shim);

    const screen = pkg.screen;
    check(appId + ": nothing under the swipe surface is a tap target",
          !hasTapTarget(screen), tapTargetPaths(screen).join(", "));

    const before = readIndex(shim);
    shim.emit(action, { direction: "left", distance: 180, ms: 600 });   // one drag
    const count = readCount(shim);
    const afterDrag = readIndex(shim);
    check(appId + ": one drag steps exactly once",
          steppedOnce(before, afterDrag, count),
          "index " + before + " -> " + afterDrag + " of " + count);

    // No quiet window: a second swipe right behind the first must land. The
    // 350ms cooldown this replaced ate it.
    const beforeSecond = readIndex(shim);
    shim.emit(action, { direction: "left", distance: 180, ms: 600 });
    check(appId + ": a second swipe immediately after steps again",
          steppedOnce(beforeSecond, readIndex(shim), count),
          "index " + beforeSecond + " -> " + readIndex(shim) + " of " + count);

    const beforeV = readIndex(shim);
    shim.emit(action, { direction: "up", distance: 120, ms: 100 });
    check(appId + ": vertical gesture is ignored (system home gesture)",
          readIndex(shim) === beforeV);
}

// The structural half of the same guarantee, asserted on the shipped screen
// rather than on behaviour: a `gesture` surface with a tap target inside it is
// uikit lint R11, and this is the runtime-side reminder of why.
const TAP_EVENTS = ["pressed", "released", "pressing", "clicked"];
function tapTargetPaths(node, path, out) {
    out = out || [];
    path = (path || "") + "/" + (node.id || "?");
    if ((node.events || []).some((ev) => TAP_EVENTS.indexOf(ev.type) > -1)) { out.push(path); }
    (node.children || []).forEach((c) => tapTargetPaths(c, path, out));
    return out;
}
function hasTapTarget(screen) {
    // The toolbar's LIKE button is a legitimate target away from the drag, so
    // this asks only about the region the finger sweeps: the media/art band.
    return tapTargetPaths(screen).some((p) => /media|nav_prev|nav_next|art/.test(p));
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
 * Same guarantee, asserted on the wire.
 *
 * tminus navigates server-side: a swipe POSTs /tminus/step and the backend
 * decides which card is next, so with a static fixture the rendered index
 * cannot move. What CAN be observed -- and what actually matters -- is how many
 * step requests one drag put on the wire. Exactly one, and the next drag puts
 * the next one.
 */
async function swipeStepRequests(appId, action, pathFragment) {
    console.log("\n" + appId + " -- one drag, one step request");
    const { shim, requests, pkg } = boot(appId);
    await settle(shim);

    const screen = pkg.screen;
    check(appId + ": nothing under the swipe surface is a tap target",
          !hasTapTarget(screen), tapTargetPaths(screen).join(", "));

    const before = requests.filter((r) => r.includes(pathFragment)).length;
    shim.emit(action, { direction: "left", distance: 180, ms: 600 });   // one drag
    await settle(shim);
    const issued = requests.filter((r) => r.includes(pathFragment)).length - before;
    check(appId + ": one drag issues exactly one step request",
          issued === 1, "issued " + issued);

    const mark = requests.filter((r) => r.includes(pathFragment)).length;
    shim.emit(action, { direction: "left", distance: 180, ms: 600 });
    await settle(shim);
    check(appId + ": a second swipe immediately after still steps",
          requests.filter((r) => r.includes(pathFragment)).length === mark + 1,
          "issued " + (requests.filter((r) => r.includes(pathFragment)).length - mark));

    const mark2 = requests.filter((r) => r.includes(pathFragment)).length;
    shim.emit(action, { direction: "up", distance: 120, ms: 100 });
    await settle(shim);
    check(appId + ": vertical gesture is ignored (system home gesture)",
          requests.filter((r) => r.includes(pathFragment)).length === mark2);
}

(async function main() {
    const APPS = ["tunastreet.agent", "tunastreet.tminus", "tunastreet.xviewer", "tunastreet.racing"];

    await swipeBurst("tunastreet.xviewer", "xviewer.gesture",
                     (s) => Number((s.renderer.text("/home/topbar/pos") || "1/1").split("/")[0]),
                     (s) => Number((s.renderer.text("/home/topbar/pos") || "1/1").split("/")[1]));
    await swipeStepRequests("tunastreet.tminus", "tminus.gesture", "/TMINUS/STEP");

    for (const a of APPS) { asciiOnly(a); }

    console.log("\n" + (failures ? failures + " FAILURE(S)" : "all checks passed"));
    process.exit(failures ? 1 : 0);
})();
