/*
 * T-MINUS - ESP-Brookesia v0.8 JavaScript runtime app (issue #184).
 *
 * True-black launch clock on the 368x448 AMOLED. T-0 from the LAN backend
 * (http://192.168.1.121:8092), Launch Library 2. Tap the right half of
 * the middle band for the next launch, the left half for the previous one;
 * swipe left/right does the same. Vertical swipe stays home.
 *
 * Same sandbox rules as tunastreet.xviewer: plain global script (QuickJS,
 * JS_EVAL_TYPE_GLOBAL), no fetch/XHR/setTimeout; HTTP via the "Http"
 * service, timers via "SystemTimer", UI mutation via "SystemGui".
 *
 * Serial triage: every log line is prefixed with [tminus].
 */

(function () {
    "use strict";

    var BACKEND = "http://192.168.1.121:8092";
    var SCREEN = "/home";
    var RETRY_MS = 10000;
    var TICK_MS = 1000;
    var REFRESH_MS = 60000;
    var HTTP_TIMEOUT_MS = 20000;
    var AMBER = "#ffb000";
    var HOLD = "#ff5a1f";
    // The touch layer emits several gesture events per continuous drag, so an
    // undebounced handler steps three or four launches on one swipe -- which
    // reads as "the swipe is broken" rather than "the swipe is too eager".
    // Same 350 ms cooldown the X viewer landed on in #193. Taps are immediate.
    var NAV_COOLDOWN_MS = 350;

    var event = null;
    var bootUnix = 0;
    var ticks = 0;
    var navSeq = 0;
    var lastNavMs = 0;
    var pendingHttp = {};
    var inFlight = false;
    var retryTimerId = null;
    var tickTimerId = null;
    var refreshTimerId = null;
    var httpServiceHandle = null;
    var httpEventsOk = false;

    function log() {
        try {
            var parts = ["[tminus]"];
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

    function setStatus(msg) {
        setText("/status", msg || "");
    }

    /**
     * True at most once per cooldown window -- for taps as well as swipes. A
     * tap target emits its action on BOTH `pressed` and `released` (panelkit
     * fires both on purpose, since a lone `released` can be swallowed), so
     * one tap on a nav zone would otherwise step two launches.
     */
    function navAllowed() {
        var t = Date.now();
        // t < lastNavMs means the clock stepped backward (SNTP); never let
        // that lock navigation out.
        if (t < lastNavMs || t - lastNavMs >= NAV_COOLDOWN_MS) {
            lastNavMs = t;
            return true;
        }
        return false;
    }

    /**
     * True at most once per continuous drag -- the swipe half of the guard.
     *
     * Shares lastNavMs with navAllowed() ON PURPOSE. One finger movement across
     * the card produces BOTH kinds of event: the prev/next tap zones cover the
     * halves of the media card and fire on `pressed` AND `released`, and the
     * touch layer emits gesture events for as long as the finger moves. Give
     * swipes their own clock and those become two independent budgets, so one
     * swipe scores once as a tap and again as a gesture -- which is exactly how
     * a "fix" for over-swiping turned 3 cards per drag into 6.
     *
     * The difference from navAllowed() is not the clock, it is the stamping:
     * navAllowed() is leading-edge and stamps only when it lets something
     * through, which is right for a tap (two events, ~0 ms apart). This stamps
     * on EVERY gesture event, accepted or rejected, so a long drag keeps pushing
     * the window out and settles to exactly one step however slow it is.
     */
    function gestureAllowed() {
        var t = Date.now();
        var gap = t - lastNavMs;
        lastNavMs = t;                  // ALWAYS extend, accepted or not
        return gap < 0 || gap >= NAV_COOLDOWN_MS;
    }

    function pad2(n) {
        return (n < 10 ? "0" : "") + n;
    }

    function clockHms(abs) {
        var h = Math.floor(abs / 3600);
        var m = Math.floor((abs % 3600) / 60);
        var s = abs % 60;
        return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
    }

    function nowUnix() {
        // QuickJS Date may be epoch-0; count seconds from the last payload's server_unix.
        if (bootUnix) {
            return bootUnix + ticks;
        }
        return Math.floor(Date.now() / 1000);
    }

    function formatClock(ev) {
        var st = String((ev && ev.status) || "");
        if (/hold/i.test(st) && !/in flight/i.test(st)) {
            return { prefix: "HOLD", clock: "--:--:--", hold: true };
        }
        var delta = Math.floor((ev.t0_unix || 0) - nowUnix());
        var sign = delta >= 0 ? "T-" : "T+";
        var abs = Math.abs(delta);
        if (/in flight/i.test(st)) {
            return { prefix: "T+", clock: clockHms(abs), hold: false };
        }
        if (abs >= 86400) {
            var d = Math.floor(abs / 86400);
            abs = abs % 86400;
            var h = Math.floor(abs / 3600);
            var m = Math.floor((abs % 3600) / 60);
            return { prefix: sign, clock: d + "d " + pad2(h) + ":" + pad2(m), hold: false };
        }
        return { prefix: sign, clock: clockHms(abs), hold: false };
    }

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

    function httpWhy(response) {
        if (!response) { return "no response"; }
        return response.error_message || response.error || ("HTTP " + response.status_code);
    }

    function renderClock() {
        if (!event) {
            return;
        }
        var f = formatClock(event);
        setText("/prefix", f.prefix);
        setText("/clock", f.clock);
        setBinding("/clock", "clockColor", f.hold ? HOLD : AMBER);
        setBinding("/clock", "clockSize", f.hold ? "42" : "48");
    }

    function render() {
        if (!event) {
            setText("/vehicle", "");
            setText("/mission", "tap >");
            setText("/pad", "");
            setText("/meta", "");
            return;
        }
        setText("/vehicle", String(event.vehicle || "").toUpperCase());
        setText("/mission", String(event.mission || ""));
        setText("/pad", String(event.pad || ""));
        setText("/meta", String(event.status || "") + "   " + (event.idx + 1) + "/" + event.count);
        renderClock();
    }

    function applyEvent(data, seqAtRequest) {
        if (!data || !data.id || typeof data.t0_unix !== "number") {
            if (navSeq === seqAtRequest) {
                setStatus("empty window - retrying");
                scheduleRetry();
            }
            return;
        }
        event = data;
        if (typeof data.server_unix === "number") {
            bootUnix = data.server_unix;
            ticks = 0;
        }
        if (navSeq !== seqAtRequest) {
            return;
        }
        setStatus("");
        render();
    }

    function fetchNow() {
        if (inFlight) {
            return;
        }
        inFlight = true;
        var seqAtRequest = navSeq;
        log("fetching now");
        httpRequest({
            url: BACKEND + "/tminus/now",
            method: "Get",
            timeout_ms: HTTP_TIMEOUT_MS,
            max_response_size: 8192
        }, function (response) {
            inFlight = false;
            if (!httpOk(response)) {
                log("now failed:", httpWhy(response));
                if (navSeq === seqAtRequest) {
                    setStatus("backend unreachable - retrying");
                    scheduleRetry();
                }
                return;
            }
            var data;
            try {
                data = JSON.parse(response.body);
            } catch (e) {
                log("now parse failed:", String(e));
                if (navSeq === seqAtRequest) {
                    setStatus("bad payload - retrying");
                    scheduleRetry();
                }
                return;
            }
            applyEvent(data, seqAtRequest);
        });
    }

    function step(dir) {
        if (inFlight) {
            return;
        }
        inFlight = true;
        navSeq++;
        var seqAtRequest = navSeq;
        log("step", dir);
        httpRequest({
            url: BACKEND + "/tminus/step",
            method: "Post",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: dir }),
            timeout_ms: HTTP_TIMEOUT_MS,
            max_response_size: 8192
        }, function (response) {
            inFlight = false;
            if (!httpOk(response)) {
                log("step failed:", httpWhy(response));
                if (navSeq === seqAtRequest) {
                    setStatus("backend unreachable - retrying");
                    scheduleRetry();
                }
                return;
            }
            var data;
            try {
                data = JSON.parse(response.body);
            } catch (e) {
                log("step parse failed:", String(e));
                return;
            }
            applyEvent(data, seqAtRequest);
        });
    }

    function scheduleRetry() {
        var result = svcCall("SystemTimer", "StartDelayed", { Name: "tm_retry", DelayMs: RETRY_MS });
        if (result.success) {
            retryTimerId = result.data;
        } else {
            log("retry timer failed:", result.error || "unknown");
        }
    }

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

                var actions = ["tminus.gesture", "tminus.prev", "tminus.next"];
                for (var j = 0; j < actions.length; j++) {
                    var subResult = svcCall("SystemGui", "SubscribeAction", { Action: actions[j] });
                    if (!subResult.success) {
                        log("SubscribeAction " + actions[j] + " failed:", subResult.error || "unknown");
                    }
                }

                var tickResult = svcCall("SystemTimer", "StartPeriodic", { Name: "tm_tick", IntervalMs: TICK_MS });
                if (tickResult.success) {
                    tickTimerId = tickResult.data;
                } else {
                    log("tick timer failed:", tickResult.error || "unknown");
                }

                var refreshResult = svcCall("SystemTimer", "StartPeriodic", { Name: "tm_refresh", IntervalMs: REFRESH_MS });
                if (refreshResult.success) {
                    refreshTimerId = refreshResult.data;
                } else {
                    log("refresh timer failed:", refreshResult.error || "unknown");
                }

                render();
                fetchNow();
            } catch (e) {
                log("on_start error:", String(e));
            }
            return true;
        },

        on_action: function (action, path, payloadJson) {
            try {
                if (action === "tminus.gesture") {
                    var payload = {};
                    try {
                        payload = JSON.parse(payloadJson || "{}");
                    } catch (e) { /* ignore */ }
                    // Horizontal only: vertical directions are left alone so
                    // the system swipe-up home gesture is never interfered
                    // with.
                    if (payload.direction === "left" || payload.direction === "right") {
                        if (gestureAllowed()) {
                            step(payload.direction === "left" ? 1 : -1);
                        }
                    }
                } else if (action === "tminus.next") {
                    if (navAllowed()) { step(1); }
                } else if (action === "tminus.prev") {
                    if (navAllowed()) { step(-1); }
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
                if (name === "tm_tick") {
                    ticks++;
                    renderClock();
                } else if (name === "tm_refresh") {
                    fetchNow();
                } else if (name === "tm_retry") {
                    fetchNow();
                }
            } catch (e) {
                log("on_timer error:", String(e));
            }
            return true;
        },

        on_stop: function () {
            log("stopping");
            try {
                if (retryTimerId !== null) {
                    svcCall("SystemTimer", "Stop", { TimerId: retryTimerId });
                    retryTimerId = null;
                }
                if (tickTimerId !== null) {
                    svcCall("SystemTimer", "Stop", { TimerId: tickTimerId });
                    tickTimerId = null;
                }
                if (refreshTimerId !== null) {
                    svcCall("SystemTimer", "Stop", { TimerId: refreshTimerId });
                    refreshTimerId = null;
                }
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
