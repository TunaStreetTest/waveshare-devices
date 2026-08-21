/*
 * Per-app canned HTTP responses for the simulator's --fixture mode (#212).
 *
 * Generalises the #205 RACING_FIXTURE / backend/fixture.json pattern: a
 * check (--check, or any --fixture run) needs no live backend up. Keyed by
 * "METHOD /path" (preferred, exact) or bare "/path" (any method); matched
 * against the request URL's pathname, so the LAN host:port in an app's
 * BACKEND constant never matters here. A path with no fixture entry gets a
 * synthesized `200 {}` and a WARN log line -- boot must still proceed, since
 * most apps don't gate their UI on every possible response shape.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");

function loadFixture(appId) {
    const p = path.join(FIXTURES_DIR, appId + ".json");
    if (!fs.existsSync(p)) { return null; }
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function lookup(map, request) {
    let pathname = request.url;
    try { pathname = new URL(request.url).pathname; } catch (e) { /* leave as-is */ }
    const method = (request.method || "Get").toUpperCase();
    const keyed = method + " " + pathname;
    if (Object.prototype.hasOwnProperty.call(map, keyed)) { return map[keyed]; }
    if (Object.prototype.hasOwnProperty.call(map, pathname)) { return map[pathname]; }
    return null;
}

// Returns an httpFetch(request) -> Promise(response) matching Shim's contract.
function makeFixtureFetch(map, log) {
    const logFn = log || function () {};
    return async function (request) {
        const hit = map ? lookup(map, request) : null;
        if (!hit) {
            logFn("WARN: no fixture for " + (request.method || "Get") + " " + request.url + " - synthesizing 200 {}");
            return { status_code: 200, body: "{}", error: "Ok" };
        }
        const body = (typeof hit.body === "string") ? hit.body : JSON.stringify(hit.body);
        return { status_code: hit.status_code || 200, body: body, error: hit.error || "Ok" };
    };
}

module.exports = { loadFixture, makeFixtureFetch, FIXTURES_DIR };
