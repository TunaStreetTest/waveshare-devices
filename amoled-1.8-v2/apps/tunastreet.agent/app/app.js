/*
 * AGENT - ESP-Brookesia v0.8 JavaScript runtime app (issue #197).
 *
 * What the board's own MicroFi EFM agent is doing, on the board's own glass:
 * a live heartbeat sweep, how many of the agent class's processors are
 * running, and the metrics the device ships off to EFM (uptime, memory, CPU,
 * queued FlowFiles).
 *
 * The panel never talks to EFM. The LAN backend (http://192.168.1.121:8094)
 * digests one EFM agent call into exactly the fields rendered here and sends a
 * server clock with every payload - QuickJS Date on this board can be epoch-0,
 * so all elapsed time is counted from server_unix plus local ticks.
 *
 * Sandbox rules (same as tunastreet.tminus/racing/xviewer): plain global
 * script (QuickJS, JS_EVAL_TYPE_GLOBAL), no fetch/XHR/setTimeout; HTTP via the
 * "Http" service, timers via "SystemTimer", UI mutation via "SystemGui".
 *
 * Serial triage: every log line is prefixed with [agent].
 */

(function () {
    "use strict";

    var BACKEND = "http://192.168.1.121:8094";
    var SCREEN = "/home";

    var TICK_MS = 1000;      // heartbeat sweep + "updated Ns ago"
    var REFRESH_MS = 5000;   // backend digest (it caches 3s upstream)
    var RETRY_MS = 10000;
    var HTTP_TIMEOUT_MS = 8000;
    // Ticks to wait before deciding an Http callback is never coming. Must clear
    // HTTP_TIMEOUT_MS with room to spare; counted in ag_tick ticks rather than
    // wall clock because QuickJS Date here can be epoch-0.
    var STUCK_TICKS = 12;

    var CELLS = 12;          // heartbeat sweep cells, ids hb0..hb11
    var STALE_S = 60;        // heartbeat older than this is not "live"
    var DEAD_S = 300;

    var GREEN = "#22c55e";
    var AMBER = "#f59e0b";
    var RED = "#ef4444";
    var ORANGE = "#F96702";
    var MUTED = "#888888";
    var INK = "#f0f0f0";
    var DIM = "#1a1a1a";

    var snap = null;         // last digest from the backend
    var bootUnix = 0;        // server_unix of that digest
    var ticks = 0;           // seconds since it landed
    var sweep = 0;
    var sweepColor = null;    // last colour painted, so a tick can repaint 2 cells not 12
    var sweepBeating = null;
    var inFlight = false;
    var inFlightTicks = 0;   // ag_tick ticks the current request has been outstanding
    var pendingHttp = {};
    var httpServiceHandle = null;
    var httpEventsOk = false;
    var tickTimerId = null;
    var refreshTimerId = null;
    var retryTimerId = null;

    function log() {
        try {
            var parts = ["[agent]"];
            for (var i = 0; i < arguments.length; i++) {
                var a = arguments[i];
                parts.push(typeof a === "string" ? a : JSON.stringify(a));
            }
            brookesia.print(parts.join(" "));
        } catch (e) { /* even logging is defensive */ }
    }

    function svcCall(service, fn, params, timeoutMs) {
        try {
            var raw;
            if (timeoutMs) {
                raw = brookesia.call_service_function(service, fn, JSON.stringify(params || {}), timeoutMs);
            } else {
                raw = brookesia.call_service_function(service, fn, JSON.stringify(params || {}));
            }
            return JSON.parse(raw);
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    function guiCall(fn, params) {
        var result = svcCall("SystemGui", fn, params);
        if (!result.success) {
            log("SystemGui." + fn + " failed:", result.error || "unknown");
        }
        return result;
    }

/* --- BEGIN toAscii (canonical: uikit/ascii.js -- do not edit in place) --- */
    // Characters with a real ASCII spelling. Anything not here and not ASCII
    // is dropped.
    var ASCII_MAP = {
        "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
        "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
        "–": "-", "—": "-", "―": "-", "‑": "-", "−": "-",
        "…": "...", "•": "*", "·": "*", "°": " deg",
        " ": " ", " ": " ", " ": " ", " ": " ", "​": "",
        "×": "x", "÷": "/", "±": "+/-", "→": "->", "←": "<-",
        "≤": "<=", "≥": ">=", "≠": "!=", "½": "1/2", "¼": "1/4",
        "€": "EUR", "£": "GBP", "¥": "JPY", "¢": "c",
        "™": "(TM)", "®": "(R)", "©": "(C)", "№": "No.",
        "ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
        // Stroked/barred letters: the stroke is part of the letter, not a
        // combining mark, so NFKD does not decompose these and the generated
        // FOLD table below cannot catch them.
        "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "Ø": "O", "ø": "o",
        "Ħ": "H", "ħ": "h", "Ŧ": "T", "ŧ": "t", "ı": "i", "Ð": "D",
        "ð": "d", "Þ": "Th", "þ": "th", "Ŋ": "N", "ŋ": "n"
    };
    // Accented Latin folded to its base letter, index-for-index.
    var FOLD_FROM =
        "ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛ" +
        "ÜÝàáâãäåçèéêëìíîïñòóôõöù" +
        "úûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔ" +
        "ĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮ" +
        "įİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐő" +
        "ŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭ" +
        "ŮůŰűŲųŴŵŶŷŸŹźŻżŽžſƠơƯưǍǎ" +
        "ǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫ" +
        "ǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎ" +
        "ȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮ" +
        "ȯȰȱȲȳḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒ" +
        "ḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪ" +
        "ḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂ" +
        "ṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚ" +
        "ṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲ" +
        "ṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊ" +
        "ẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẛẠạẢảẤấẦầ" +
        "ẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾế" +
        "ỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗ" +
        "ỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữ" +
        "ỰựỲỳỴỵỶỷỸỹ";
    var FOLD_TO =
        "AAAAAACEEEEIIIINOOOOOUUU" +
        "UYaaaaaaceeeeiiiinooooou" +
        "uuuyyAaAaAaCcCcCcCcDdEeE" +
        "eEeEeEeGgGgGgGgHhIiIiIiI" +
        "iIJjKkLlLlLlNnNnNnOoOoOo" +
        "RrRrRrSsSsSsSsTtTtUuUuUu" +
        "UuUuUuWwYyYZzZzZzsOoUuAa" +
        "IiOoUuUuUuUuUuAaAaGgKkOo" +
        "OojGgNnAaAaAaEeEeIiIiOoO" +
        "oRrRrUuUuSsTtHhAaEeOoOoO" +
        "oOoYyAaBbBbBbCcDdDdDdDdD" +
        "dEeEeEeEeEeFfGgHhHhHhHhH" +
        "hIiIiKkKkKkLlLlLlLlMmMmM" +
        "mNnNnNnNnOoOoOoOoPpPpRrR" +
        "rRrRrSsSsSsSsSsTtTtTtTtU" +
        "uUuUuUuUuVvVvWwWwWwWwWwX" +
        "xXxYyZzZzZzhtwysAaAaAaAa" +
        "AaAaAaAaAaAaAaAaEeEeEeEe" +
        "EeEeEeEeIiIiOoOoOoOoOoOo" +
        "OoOoOoOoOoOoUuUuUuUuUuUu" +
        "UuYyYyYyYy";

    /**
     * Fold `value` to something an ASCII-only font can actually draw.
     * Returns a plain ASCII string; never null or undefined.
     */
    function toAscii(value) {
        var s = (value === null || value === undefined) ? "" : String(value);
        var i, code;
        // Fast path: almost every string is already clean, so scan first and
        // return the original rather than rebuilding it character by character.
        var dirty = false;
        for (i = 0; i < s.length; i++) {
            code = s.charCodeAt(i);
            if (code > 126 || (code < 32 && code !== 10)) { dirty = true; break; }
        }
        if (!dirty) { return s; }

        var out = "";
        for (i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            code = s.charCodeAt(i);
            if (code === 10 || (code >= 32 && code <= 126)) { out += ch; continue; }
            // An astral codepoint (most emoji) is a surrogate PAIR in UTF-16;
            // consume both units so the trailing half is never left behind as
            // a lone surrogate.
            if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
                var lo = s.charCodeAt(i + 1);
                if (lo >= 0xDC00 && lo <= 0xDFFF) { i++; continue; }
            }
            var mapped = ASCII_MAP[ch];
            if (mapped !== undefined) { out += mapped; continue; }
            var f = FOLD_FROM.indexOf(ch);
            if (f >= 0) { out += FOLD_TO.charAt(f); continue; }
            // Everything else -- BMP emoji, CJK, variation selectors, symbols
            // -- is dropped. A gap reads as a gap; a box reads as a bug.
        }
        return out;
    }
/* --- END toAscii --- */

    function setText(path, text) {
        guiCall("SetText", { Path: SCREEN + path, Text: toAscii(text) });
    }

    function setBinding(path, key, value) {
        guiCall("SetBinding", { Path: SCREEN + path, Key: key, Value: String(value) });
    }

    // ---- formatting -------------------------------------------------------

    function pad2(n) {
        return (n < 10 ? "0" : "") + n;
    }

    function nowUnix() {
        if (bootUnix) {
            return bootUnix + ticks;
        }
        return Math.floor(Date.now() / 1000);
    }

    function shortDur(s) {
        if (s < 0) { return "--"; }
        if (s < 60) { return s + "s"; }
        if (s < 3600) { return Math.floor(s / 60) + "m " + pad2(s % 60) + "s"; }
        if (s < 86400) { return Math.floor(s / 3600) + "h " + pad2(Math.floor((s % 3600) / 60)) + "m"; }
        return Math.floor(s / 86400) + "d " + pad2(Math.floor((s % 86400) / 3600)) + "h";
    }

    // The metrics row gives each value a 92px cell at 28px type, which "1h 44m"
    // overflows into a clipped second line (caught in the simulator before this
    // ever reached the glass). Same information, no spaces, four chars max.
    function tightDur(s) {
        if (s < 0) { return "--"; }
        if (s < 60) { return s + "s"; }
        if (s < 3600) { return Math.floor(s / 60) + "m"; }
        if (s < 86400) {
            var h = Math.floor(s / 3600);
            return h + "h" + pad2(Math.floor((s % 3600) / 60));
        }
        return Math.floor(s / 86400) + "d" + pad2(Math.floor((s % 86400) / 3600));
    }

    function mib(bytes) {
        if (!bytes) { return "0"; }
        return (bytes / 1048576).toFixed(1);
    }

    // Heartbeat age counted forward locally, so the number moves every second
    // instead of freezing between backend polls.
    function beatAge() {
        if (!snap || snap.heartbeat_age_s < 0) { return -1; }
        return snap.heartbeat_age_s + ticks;
    }

    function liveColor() {
        var age = beatAge();
        if (age < 0 || !snap) { return MUTED; }
        if (String(snap.state) !== "ONLINE") { return RED; }
        if (age > DEAD_S) { return RED; }
        if (age > STALE_S) { return AMBER; }
        return GREEN;
    }

    function stateWord() {
        if (!snap) { return "..."; }
        var age = beatAge();
        if (String(snap.state) !== "ONLINE") { return String(snap.state); }
        if (age > DEAD_S) { return "SILENT"; }
        if (age > STALE_S) { return "STALE"; }
        return "ONLINE";
    }

    // ---- render -----------------------------------------------------------

    // The sweep is a row of cells with one bright head running left to right -
    // a monitor trace, done with bgColor writes only, which is the one style
    // mutation this runtime does cheaply.
    //
    // Only the two cells that changed are written: at one step per second that
    // is 2 service calls instead of 12. A full repaint happens once, when the
    // colour or the beating/not-beating state actually changes.
    function paintCell(i, color) {
        setBinding("/hb/hb" + i, "hb" + i + "Bg", color);
    }

    function renderSweep(full) {
        var head = sweep % CELLS;
        var color = liveColor();
        var beating = !!(snap && beatAge() >= 0 && beatAge() <= DEAD_S);
        var changed = full || color !== sweepColor || beating !== sweepBeating;

        if (changed) {
            for (var i = 0; i < CELLS; i++) {
                paintCell(i, beating && i === head ? color : DIM);
            }
        } else if (beating) {
            paintCell((head + CELLS - 1) % CELLS, DIM);
            paintCell(head, color);
        }
        sweepColor = color;
        sweepBeating = beating;
    }

    function renderClock() {
        var age = beatAge();
        setText("/beat/beat_v", age < 0 ? "--" : shortDur(age));
        setBinding("/beat/beat_v", "beatColor", liveColor());
        setText("/foot/foot_age", snap ? "updated " + ticks + "s ago" : "connecting...");
    }

    function render() {
        if (!snap) {
            setText("/head/head_state", "...");
            setBinding("/head/head_state", "stateColor", MUTED);
            setText("/proc/proc_v", "--");
            return;
        }

        setText("/head/head_state", stateWord());
        setBinding("/head/head_state", "stateColor", liveColor());

        setText("/proc/proc_v", snap.running_count + "/" + snap.processor_count);
        setBinding("/proc/proc_v", "procColor", snap.running_count === snap.processor_count && snap.processor_count > 0 ? ORANGE : AMBER);

        var names = [];
        for (var i = 0; i < (snap.processors || []).length; i++) {
            var p = snap.processors[i];
            names.push((p.running ? "" : "!") + p.name);
        }
        setText("/proc/proc_list", names.length ? names.join("  ") : "no flow published");
        setText("/proc/proc_cat", snap.catalogue_count + " types in class " + snap.agent_class);

        setText("/mx/mx_uptime_v", tightDur(snap.uptime_s));
        setText("/mx/mx_mem_v", mib(snap.mem_bytes));
        setText("/mx/mx_beats_v", String(snap.heartbeat_count || 0));
        setText("/mx/mx_queue_v", String(snap.flowfile_queued));

        setText("/foot/foot_id", snap.agent_id + "  " + snap.agent_type + " " + snap.agent_version);

        renderSweep(true);
        renderClock();
    }

    // ---- http -------------------------------------------------------------

    function httpRequest(request, cb) {
        if (httpEventsOk) {
            var result = svcCall("Http", "RequestAsync", { Request: request });
            if (!result.success || typeof result.data !== "number") {
                log("RequestAsync submit failed:", result.error || result);
                cb({ error: "SubmitFailed", error_message: String(result.error || "RequestAsync failed"), status_code: 0 });
                return;
            }
            pendingHttp[String(result.data)] = cb;
            return;
        }
        var syncResult = svcCall("Http", "Request", { Request: request }, (request.timeout_ms || 10000) + 10000);
        if (!syncResult.success || !syncResult.data) {
            cb({ error: "RequestFailed", error_message: String(syncResult.error || "Http.Request failed"), status_code: 0 });
            return;
        }
        cb(syncResult.data);
    }

    function handleHttpEvent(eventName, itemsJson) {
        var items;
        try {
            items = JSON.parse(itemsJson);
        } catch (e) {
            log("bad Http event payload:", String(e));
            return;
        }
        var id = String(items.RequestId);
        var cb = pendingHttp[id];
        if (!cb) {
            return;
        }
        delete pendingHttp[id];
        var response = items.Response || {};
        if (eventName === "RequestFailed" && !response.error) {
            response.error = "RequestFailed";
        }
        if (eventName === "RequestCanceled") {
            response.error = "Canceled";
        }
        try {
            cb(response);
        } catch (e) {
            log("http callback threw:", String(e));
        }
    }

    function httpOk(response) {
        return response && (!response.error || response.error === "Ok") && response.status_code === 200;
    }

    function startRetry() {
        if (retryTimerId !== null) {
            return;
        }
        var result = svcCall("SystemTimer", "StartDelayed", { Name: "ag_retry", DelayMs: RETRY_MS });
        if (result.success) {
            retryTimerId = result.data;
        }
    }

    function fetchStatus() {
        if (inFlight) {
            return;
        }
        inFlight = true;
        inFlightTicks = 0;
        httpRequest({
            url: BACKEND + "/agent/status",
            // "Get", NOT "GET". The Http service deserialises Request.method with
            // describe_from_json, which for a described enum uses the STRICT
            // describe_string_to_enum -- the enumerator is `Get`, so "GET" fails
            // to parse, the request struct never deserialises, and the fetch
            // never leaves the device. This app had it wrong from the day it was
            // written, which is why its backend was never once reached while
            // tminus/xviewer/racing (all "Get"/"Post") always worked.
            method: "Get",
            timeout_ms: HTTP_TIMEOUT_MS
        }, function (response) {
            inFlight = false;
            inFlightTicks = 0;
            if (!httpOk(response)) {
                log("status failed:", response.error_message || response.error || response.status_code);
                setText("/foot/foot_age", "backend unreachable - retrying");
                startRetry();
                return;
            }
            var payload;
            try {
                payload = JSON.parse(response.body || "{}");
            } catch (e) {
                log("bad status json:", String(e));
                startRetry();
                return;
            }
            snap = payload;
            bootUnix = payload.server_unix || 0;
            ticks = 0;
            render();
        });
    }

    // ---- lifecycle --------------------------------------------------------

    globalThis.brookesia_app = {
        on_start: function () {
            log("starting");
            try {
                try {
                    httpServiceHandle = brookesia.start_service("Http");
                } catch (e) {
                    log("start_service(Http) failed (may already run):", String(e));
                }

                httpEventsOk = true;
                var events = ["RequestCompleted", "RequestFailed", "RequestCanceled"];
                for (var i = 0; i < events.length; i++) {
                    try {
                        brookesia.subscribe_service_event("Http", events[i]);
                    } catch (e) {
                        httpEventsOk = false;
                        log("subscribe Http." + events[i] + " failed, falling back to sync Http.Request:", String(e));
                        break;
                    }
                }

                var actions = ["agent.refresh"];
                for (var j = 0; j < actions.length; j++) {
                    var subResult = svcCall("SystemGui", "SubscribeAction", { Action: actions[j] });
                    if (!subResult.success) {
                        log("SubscribeAction " + actions[j] + " failed:", subResult.error || "unknown");
                    }
                }

                var tickResult = svcCall("SystemTimer", "StartPeriodic", { Name: "ag_tick", IntervalMs: TICK_MS });
                if (tickResult.success) {
                    tickTimerId = tickResult.data;
                }
                var refreshResult = svcCall("SystemTimer", "StartPeriodic", { Name: "ag_refresh", IntervalMs: REFRESH_MS });
                if (refreshResult.success) {
                    refreshTimerId = refreshResult.data;
                }

                render();
                fetchStatus();
            } catch (e) {
                log("on_start error:", String(e));
            }
            return true;
        },

        on_action: function (action) {
            try {
                if (action === "agent.refresh") {
                    fetchStatus();
                }
            } catch (e) {
                log("on_action error:", String(e));
            }
            return true;
        },

        on_event: function (serviceName, eventName, itemsJson) {
            try {
                if (serviceName === "Http") {
                    handleHttpEvent(eventName, itemsJson);
                }
            } catch (e) {
                log("on_event error:", String(e));
            }
            return true;
        },

        on_timer: function (timerId, name) {
            try {
                if (name === "ag_tick") {
                    ticks++;
                    sweep++;
                    renderSweep();
                    renderClock();
                    // A submitted RequestAsync whose completion event never arrives would
                    // otherwise latch inFlight true forever, and every later fetchStatus()
                    // returns without issuing anything -- the panel sits on its last text
                    // and sends nothing. Abandon the request and let the next one through.
                    if (inFlight && ++inFlightTicks > STUCK_TICKS) {
                        log("no Http callback after " + inFlightTicks + " ticks - abandoning request");
                        pendingHttp = {};
                        inFlight = false;
                        inFlightTicks = 0;
                        setText("/foot/foot_age", "backend unreachable - retrying");
                        fetchStatus();
                    }
                } else if (name === "ag_refresh") {
                    fetchStatus();
                } else if (name === "ag_retry") {
                    retryTimerId = null;
                    fetchStatus();
                }
            } catch (e) {
                log("on_timer error:", String(e));
            }
            return true;
        },

        on_stop: function () {
            log("stopping");
            try {
                var timers = [tickTimerId, refreshTimerId, retryTimerId];
                for (var i = 0; i < timers.length; i++) {
                    if (timers[i] !== null) {
                        svcCall("SystemTimer", "Stop", { TimerId: timers[i] });
                    }
                }
                tickTimerId = null;
                refreshTimerId = null;
                retryTimerId = null;
                if (httpServiceHandle !== null) {
                    try {
                        brookesia.stop_service(httpServiceHandle);
                    } catch (e) { /* core releases leftovers anyway */ }
                    httpServiceHandle = null;
                }
                pendingHttp = {};
            } catch (e) {
                log("on_stop error:", String(e));
            }
            return true;
        }
    };
})();
