#!/usr/bin/env node
/*
 * Generic headless runner (#205, generalised for #212) -- plays the REAL
 * app/app.js for any Brookesia runtime app in node, no board, no DOM.
 *
 * The core here has zero per-app knowledge: it resolves the package, boots
 * it under the shim, and (if --drive is given) calls a driver's step() every
 * tick until the driver says it's done or time runs out. Everything racing-
 * specific (or xviewer-specific, or any future app's) lives in the driver
 * module passed to --drive, never here.
 *
 *   node headless.js --app tunastreet.racing --fixture --drive examples/racing-bot.js
 *   node headless.js --app tunastreet.xviewer --fixture --seconds 5
 *
 * See README.md for the full flag list and the driver contract.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { resolvePkg } = require("./pkg.js");
const { loadFixture, makeFixtureFetch } = require("./fixtures.js");

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return (i > -1 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes(name); }

const APP = argVal("--app", null);
if (!APP) {
    console.error("usage: node headless.js --app <id> [--fixture] [--drive <path>] [--as <name>]" +
        " [--seconds N | --ticks N] [--pure] [--quiet]");
    process.exit(2);
}
const USE_FIXTURE = flag("--fixture");
const DRIVE = argVal("--drive", null);
const AS = argVal("--as", null);
const QUIET = flag("--quiet");
const TICK_MS = 40;
const TICKS = argVal("--ticks", null) !== null
    ? Number(argVal("--ticks"))
    : Math.round(Number(argVal("--seconds", "60")) * 1000 / TICK_MS);

function resolveDriverPath(p) {
    if (path.isAbsolute(p)) { return p; }
    const nearSim = path.join(__dirname, p);
    if (fs.existsSync(nearSim)) { return nearSim; }
    return path.resolve(process.cwd(), p);
}

function settle(ms) {
    return new Promise((r) => setTimeout(r, ms || 0));
}

(async function main() {
    let pkg;
    try {
        pkg = resolvePkg(APP);
    } catch (e) {
        console.error("[headless] " + e.message);
        process.exit(1);
    }
    if (!QUIET) { console.log("[headless] app:", pkg.id, "screen:", pkg.screenId, "(" + pkg.flowName + ")"); }

    require(path.join(__dirname, "shim.js"));
    const { Shim, StateRenderer } = globalThis.PanelKit;

    let appSrc = pkg.appJs;
    if (AS) {
        const re = /var DRIVER = "[^"]*";/;
        if (re.test(appSrc)) {
            appSrc = appSrc.replace(re, 'var DRIVER = "' + AS.replace(/"/g, "") + '";');
        } else {
            console.log("[headless] --as given but no `var DRIVER = \"...\";` found in " + pkg.id + "/app/app.js - ignoring");
        }
    }

    // App log lines (brookesia.print) are captured but only surfaced at the
    // end as an error/fail grep, same as #205's headless.js -- the summary
    // (driver.summary(), or the generic label dump) is the thing to read.
    const logs = [];
    const log = (s) => { logs.push(s); };
    const renderer = new StateRenderer();

    let httpFetch;
    if (USE_FIXTURE) {
        const map = loadFixture(APP);
        if (!map) { console.log("[headless] WARN: no fixtures/" + APP + ".json - every request will synthesize 200 {}"); }
        httpFetch = makeFixtureFetch(map || {}, log);
    } else {
        httpFetch = async (request) => {
            const backend = process.env.PANEL_SIM_BACKEND;
            const url = backend ? request.url.replace(/^https?:\/\/[^/]+/, backend) : request.url;
            const r = await fetch(url, {
                method: (request.method || "Get").toUpperCase(),
                headers: request.headers || {},
                body: request.body,
            });
            return { status_code: r.status, body: await r.text(), error: "Ok" };
        };
    }

    const shim = new Shim({ screen: pkg.screen, renderer, log, httpFetch });
    shim.install();
    (0, eval)(appSrc);
    shim.start();

    if (DRIVE) {
        const driverPath = resolveDriverPath(DRIVE);
        const mod = require(driverPath);
        const driver = mod.create(shim, { pure: flag("--pure") });

        if (driver.boot) { driver.boot(); }
        await settle(50);

        let ticks = 0;
        while (ticks < TICKS) {
            const active = driver.isActive ? driver.isActive() : true;
            const done = driver.isDone ? driver.isDone() : false;
            if (done) { break; }
            if (active && driver.step) { driver.step(); }
            shim.advance(TICK_MS);
            ticks++;
            if (ticks % 25 === 0) { await settle(0); }
        }
        await settle(1500);
        console.log(driver.summary ? driver.summary() : JSON.stringify(renderer.dumpLabels(), null, 2));
        console.log("== survived", (shim.timeMs / 1000).toFixed(1), "s over", ticks, "ticks");
    } else {
        shim.advance(TICKS * TICK_MS);
        await settle(200);
        console.log("[headless] booted", pkg.id, "- no --drive given, dumping visible label state:");
        console.log(JSON.stringify(renderer.dumpLabels(), null, 2));
    }

    const errs = logs.filter((l) => /fail|error/i.test(l));
    console.log(errs.length ? "!! app errors:\n" + errs.slice(0, 10).join("\n") : "== no app errors");
    process.exit(0);
})().catch((e) => {
    console.error("[headless] fatal:", e.stack || e);
    process.exit(1);
});
