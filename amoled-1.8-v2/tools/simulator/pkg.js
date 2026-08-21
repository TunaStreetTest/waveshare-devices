/*
 * Package resolution for the simulator (#212).
 *
 * Resolves --app <id> to a runnable package the way the device does: read
 * manifest.json for the entry script, res/profile.json for which screen
 * flow mounts (screen_flows[0].screen_flow), res/flows/<name>.json for the
 * flow's initial screen id, and finally res/screens/<id>.json. Nothing here
 * is allowed to hardcode "home" -- xviewer and racing both happen to use
 * that screen id today, but the whole point of walking profile -> flow ->
 * screen is that a future app doesn't have to.
 *
 * Node-only (fs/path built-ins). The browser side (panel.html) re-implements
 * the same four-step walk over fetch() instead of fs, since it has no
 * filesystem -- see panel.html's resolvePkg().
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APPS_ROOT = path.resolve(__dirname, "..", "..", "apps");
const APP_ID_RE = /^[a-zA-Z0-9_.-]+$/;

function readJson(p, what) {
    if (!fs.existsSync(p)) { throw new Error(what + " missing: " + p); }
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
        throw new Error(what + " is not valid JSON (" + p + "): " + e.message);
    }
}

function resolveAppDir(appId) {
    if (!APP_ID_RE.test(appId)) { throw new Error("bad app id: " + appId); }
    const dir = path.resolve(APPS_ROOT, appId);
    if (dir !== APPS_ROOT && !dir.startsWith(APPS_ROOT + path.sep)) {
        throw new Error("app id escapes apps/: " + appId);
    }
    if (!fs.existsSync(dir)) { throw new Error("no such app: " + appId + " (" + dir + ")"); }
    return dir;
}

// Full resolve: manifest -> entry, profile -> flow -> screen. Throws with a
// specific, actionable message on any missing/malformed step.
function resolvePkg(appId) {
    const dir = resolveAppDir(appId);

    const manifest = readJson(path.join(dir, "manifest.json"), appId + ": manifest.json");
    const entryRel = manifest.runtime && manifest.runtime.entry;
    if (!entryRel) { throw new Error(appId + ": manifest.json has no runtime.entry"); }
    const entryPath = path.join(dir, entryRel);
    if (!fs.existsSync(entryPath)) { throw new Error(appId + ": manifest.json's entry (" + entryRel + ") does not exist"); }

    const profile = readJson(path.join(dir, "res", "profile.json"), appId + ": res/profile.json");
    const flowName = profile.screen_flows && profile.screen_flows[0] && profile.screen_flows[0].screen_flow;
    if (!flowName) { throw new Error(appId + ": res/profile.json has no screen_flows[0].screen_flow"); }

    const flowPath = path.join(dir, "res", "flows", flowName + ".json");
    const flow = readJson(flowPath, appId + ": res/flows/" + flowName + ".json");
    const screenId = flow.initial;
    if (!screenId) { throw new Error(appId + ": " + flowName + ".json has no \"initial\" screen id"); }

    const screenPath = path.join(dir, "res", "screens", screenId + ".json");
    const screen = readJson(screenPath, appId + ": res/screens/" + screenId + ".json");

    return {
        id: appId, dir, manifest, entryPath,
        appJs: fs.readFileSync(entryPath, "utf8"),
        profile, flowName, flow, screenId, screenPath, screen,
    };
}

function listScreenFiles(pkg) {
    const dir = path.join(pkg.dir, "res", "screens");
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(dir, f));
}

module.exports = { resolvePkg, resolveAppDir, listScreenFiles, APPS_ROOT, APP_ID_RE };
