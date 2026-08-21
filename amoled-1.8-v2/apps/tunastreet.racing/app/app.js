/*
 * RACING - ESP-Brookesia v0.8 JavaScript runtime app (issue #205).
 *
 * The Cloudera Racing game itself, playable on the 368x448 AMOLED: enter your
 * name, pick a car, dodge villains across three lanes. Same rules as the
 * browser game (3 Datahero lives, speed level every 15s, Hero Mode at 2:00,
 * iceberg power-up past 3000) and the same telemetry - every heartbeat,
 * collision and game_over is POSTed through the LAN backend into the real
 * pipeline (nginx -> NiFi ListenHTTP -> Kafka), so a run played on the panel
 * lands on the same leaderboard as a run played in the browser.
 *
 * Sandbox rules (same as tunastreet.tminus/xviewer): plain global script
 * (QuickJS, JS_EVAL_TYPE_GLOBAL), no fetch/XHR/setTimeout; HTTP via the "Http"
 * service, timers via "SystemTimer", UI mutation via "SystemGui".
 *
 * Serial triage: every log line is prefixed with [racing].
 */

(function () {
    "use strict";

    var BACKEND = "http://192.168.1.121:8093";
    var SCREEN = "/home";

    var LANES = [61, 184, 307];
    var LANE_NAMES = ["Left", "Center", "Right"];
    var CAR_W = 52;
    var OBS = 6;
    var OBS_SZ = 38;
    var CAR_Y = 320;
    var ROAD_TOP = 52;
    var ROAD_BOTTOM = 448;

    var TICK_MS = 60;
    var SEC_MS = 1000;
    var MAX_LIVES = 3;
    var BOOST_SEC = 15;
    var HERO_SEC = 120;
    var ICEBERG_MIN = 3000;

    var ORANGE = "#F96702";
    var GREEN = "#22c55e";
    var MUTED = "#888888";
    var WHITE = "#f0f0f0";
    var CAR_COLORS = { corolla: "#f2f2f2", porsche: "#c8c8cc" };
    var VILLAINS = [
        { c: "#FF3621", t: "databricks" },
        { c: "#29B5E8", t: "snowflake" },
        { c: "#f5a623", t: "normal" },
        { c: "#e5484d", t: "normal" },
        { c: "#8a8f98", t: "normal" }
    ];
    var ICEBERG_COLOR = "#e8f4f8";

    var ACH = [
        { s: 0, t: "Just Getting Started", d: "Every legend has a first lap." },
        { s: 500, t: "Street Racer", d: "Getting the hang of dodging." },
        { s: 1500, t: "Data Engineer", d: "Fast reflexes, clean data." },
        { s: 3000, t: "Iceberg Survivor", d: "You unlocked Iceberg power-ups." },
        { s: 5000, t: "Cloudera Champion", d: "You outran every villain." },
        { s: 8000, t: "Hero Mode Veteran", d: "Two minutes in and still flying." },
        { s: 12000, t: "Data Hero", d: "Kafka is streaming your legend." }
    ];

    // state
    var phase = "start";
    var username = "";
    var userId = "";
    var carType = "porsche";
    var lane = 1;
    var score = 0, collisions = 0, elapsed = 0;
    var speedLevel = 1, baseKmh = 60, boostCd = BOOST_SEC;
    var heroMode = false, lastKmh = 60;
    var obs = [];
    var spawnT = 0;
    var toastTicks = 0;

    var pendingHttp = {};
    var httpServiceHandle = null;
    var httpEventsOk = false;
    var tickTimerId = null, secTimerId = null;
    var lastText = {}, lastBind = {};

    function log() {
        try {
            var parts = ["[racing]"];
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

    function setText(path, text) {
        var s = String(text);
        if (lastText[path] === s) { return; }
        lastText[path] = s;
        guiCall("SetText", { Path: SCREEN + path, Text: s });
    }

    // Batched binding writes: one game tick moves up to 6 obstacles plus the
    // car, and SetBindings merges them into a single binding flush.
    var pendingBinds = [];

    function bind(path, key, value) {
        var s = String(value);
        var k = path + "|" + key;
        if (lastBind[k] === s) { return; }
        lastBind[k] = s;
        pendingBinds.push({ Path: SCREEN + path, Key: key, Value: s });
    }

    function flushBinds() {
        if (!pendingBinds.length) { return; }
        var updates = pendingBinds;
        pendingBinds = [];
        guiCall("SetBindings", { Updates: updates });
    }

    function showPhase(p) {
        phase = p;
        bind("/panel_start", "startHidden", p === "start" ? "false" : "true");
        bind("/panel_game", "gameHidden", p === "game" ? "false" : "true");
        bind("/panel_over", "overHidden", p === "over" ? "false" : "true");
        bind("/panel_start/s_kb", "kbHidden", p === "start" ? "false" : "true");
        flushBinds();
    }

    function rnd(n) {
        return Math.floor(Math.random() * n);
    }

    function uuid() {
        var hex = "0123456789abcdef";
        var out = "";
        for (var i = 0; i < 32; i++) {
            out += hex.charAt(rnd(16));
            if (i === 7 || i === 11 || i === 15 || i === 19) { out += "-"; }
        }
        return out;
    }

    // ---- HTTP ------------------------------------------------------------
    function httpRequest(request, cb) {
        if (httpEventsOk) {
            var result = svcCall("Http", "RequestAsync", { Request: request });
            if (!result.success || typeof result.data !== "number") {
                if (cb) { cb({ error: "SubmitFailed", status_code: 0 }); }
                return;
            }
            if (cb) { pendingHttp[String(result.data)] = cb; }
            return;
        }
        var sync = svcCall("Http", "Request", { Request: request }, (request.timeout_ms || 5000) + 10000);
        if (cb) {
            cb((sync.success && sync.data) ? sync.data : { error: "RequestFailed", status_code: 0 });
        }
    }

    function handleHttpEvent(eventName, itemsJson) {
        var items;
        try {
            items = JSON.parse(itemsJson);
        } catch (e) { return; }
        var id = String(items.RequestId);
        var cb = pendingHttp[id];
        if (!cb) { return; }
        delete pendingHttp[id];
        var response = items.Response || {};
        if (eventName === "RequestFailed" && !response.error) { response.error = "RequestFailed"; }
        if (eventName === "RequestCanceled") { response.error = "Canceled"; }
        try {
            cb(response);
        } catch (e) {
            log("http callback threw:", String(e));
        }
    }

    function httpOk(r) {
        return r && (!r.error || r.error === "Ok") && r.status_code === 200;
    }

    function carName() {
        return carType === "corolla" ? "Toyota Corolla S" : "Porsche 911";
    }

    function sendTelemetry(eventType) {
        lastKmh = Math.round(baseKmh + score / 8);
        var payload = {
            topic: "game_metrics",
            timestamp: "",
            user_id: userId,
            username: username,
            car: carName(),
            score: score,
            speed_kmh: lastKmh,
            speed_level: speedLevel,
            collisions: collisions,
            lane: LANE_NAMES[lane],
            elapsed_sec: elapsed,
            hero_mode: heroMode,
            event_type: eventType || "heartbeat"
        };
        httpRequest({
            url: BACKEND + "/racing/metrics",
            method: "Post",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout_ms: 4000,
            max_response_size: 1024
        }, null);
    }

    function fetchBoard() {
        httpRequest({
            url: BACKEND + "/racing/leaderboard",
            method: "Get",
            timeout_ms: 6000,
            max_response_size: 4096
        }, function (response) {
            if (!httpOk(response)) {
                setText("/panel_over/o_status", "leaderboard unreachable");
                return;
            }
            var d;
            try {
                d = JSON.parse(response.body);
            } catch (e) { return; }
            var rows = d.rows || [];
            for (var i = 0; i < 3; i++) {
                var r = rows[i];
                setText("/panel_over/o_b" + (i + 1), r ? (r.pos + "  " + r.name + "   " + r.score) : "");
            }
            setText("/panel_over/o_status", "on the board with " + (d.count || 0) + " drivers");
        });
    }

    // ---- game ------------------------------------------------------------
    function toast(msg) {
        setText("/panel_game/g_toast", msg);
        toastTicks = Math.floor(2400 / TICK_MS);
    }

    function livesText() {
        var left = MAX_LIVES - collisions;
        var s = "";
        for (var i = 0; i < MAX_LIVES; i++) { s += (i < left) ? "*" : "-"; }
        return s;
    }

    function renderHud() {
        setText("/panel_game/g_name", username);
        setText("/panel_game/g_score", String(score));
        setText("/panel_game/g_lives", livesText());
        bind("/panel_game/g_lives", "livesColor", collisions >= 2 ? "#e5484d" : GREEN);
        var mm = Math.floor(elapsed / 60);
        var ss = elapsed % 60;
        setText("/panel_game/g_clock", mm + ":" + (ss < 10 ? "0" : "") + ss);
        setText("/panel_game/g_speed", "Lv." + speedLevel + " · " + baseKmh + " km/h");
        setText("/panel_game/g_mode", heroMode ? "HERO MODE" : "");
        flushBinds();
    }

    function placeCar() {
        bind("/panel_game/g_car", "carX", LANES[lane] - CAR_W / 2);
        bind("/panel_game/g_car", "carColor", CAR_COLORS[carType]);
        setText("/panel_game/g_car_t", carType === "corolla" ? "TOY" : "911");
    }

    function hideObs(i) {
        obs[i].alive = false;
        bind("/panel_game/g_obs" + i, "obs" + i + "H", "true");
    }

    function spawnObs() {
        for (var i = 0; i < OBS; i++) {
            if (obs[i].alive) { continue; }
            var l = rnd(3);
            var type, color;
            if (score >= ICEBERG_MIN && Math.random() < 0.18) {
                type = "iceberg";
                color = ICEBERG_COLOR;
            } else {
                var pick = heroMode ? VILLAINS[rnd(2)] : VILLAINS[2 + rnd(3)];
                type = pick.t;
                color = pick.c;
            }
            obs[i].alive = true;
            obs[i].lane = l;
            obs[i].y = ROAD_TOP - OBS_SZ;
            obs[i].type = type;
            bind("/panel_game/g_obs" + i, "obs" + i + "X", LANES[l] - OBS_SZ / 2);
            bind("/panel_game/g_obs" + i, "obs" + i + "Y", obs[i].y);
            bind("/panel_game/g_obs" + i, "obs" + i + "C", color);
            bind("/panel_game/g_obs" + i, "obs" + i + "H", "false");
            return;
        }
    }

    function hitIceberg() {
        if (speedLevel > 1) {
            speedLevel--;
            baseKmh = Math.max(60, baseKmh - 20);
        }
        boostCd = BOOST_SEC;
        score += 200;
        toast("ICEBERG! +200");
        sendTelemetry("powerup_iceberg");
    }

    function hitVillain() {
        collisions++;
        if (collisions >= MAX_LIVES) {
            endGame();
            return;
        }
        toast("VILLAIN HIT!");
        sendTelemetry("collision");
    }

    function tick() {
        if (phase !== "game") { return; }
        spawnT++;
        if (spawnT > Math.max(5, 16 - speedLevel)) {
            spawnT = 0;
            spawnObs();
        }
        var step = 6 + speedLevel * 2;
        for (var i = 0; i < OBS; i++) {
            var o = obs[i];
            if (!o.alive) { continue; }
            o.y += step;
            if (o.y > ROAD_BOTTOM) {
                hideObs(i);
                score += 10;
                continue;
            }
            if (o.lane === lane && o.y > CAR_Y - OBS_SZ && o.y < CAR_Y + 52) {
                hideObs(i);
                if (o.type === "iceberg") { hitIceberg(); } else { hitVillain(); }
                if (phase !== "game") { return; }
                continue;
            }
            bind("/panel_game/g_obs" + i, "obs" + i + "Y", o.y);
        }
        if (toastTicks > 0) {
            toastTicks--;
            if (toastTicks === 0) { setText("/panel_game/g_toast", ""); }
        }
        setText("/panel_game/g_score", String(score));
        flushBinds();
    }

    function everySecond() {
        if (phase !== "game") { return; }
        elapsed++;
        boostCd--;
        if (boostCd <= 0) {
            speedLevel++;
            baseKmh += 20;
            boostCd = BOOST_SEC;
            toast("SPEED LEVEL " + speedLevel + "!");
        }
        if (elapsed >= HERO_SEC && !heroMode) {
            heroMode = true;
            toast("CLOUDERA HERO MODE");
        }
        renderHud();
        sendTelemetry("heartbeat");
    }

    function resetGame() {
        score = 0; collisions = 0; elapsed = 0;
        speedLevel = 1; baseKmh = 60; boostCd = BOOST_SEC;
        heroMode = false; lastKmh = 60; spawnT = 0; lane = 1;
        obs = [];
        for (var i = 0; i < OBS; i++) {
            obs.push({ alive: false, lane: 0, y: 0, type: "normal" });
            hideObs(i);
        }
        setText("/panel_game/g_toast", "");
        placeCar();
        renderHud();
    }

    function startGame() {
        var got = svcCall("SystemGui", "GetBinding", { Path: SCREEN + "/panel_start/s_name", Key: "textInputProps.text" });
        var typed = (got && got.success && got.data) ? String(got.data.Value || got.data) : "";
        typed = typed.replace(/^\s+|\s+$/g, "");
        username = typed || "Driver";
        if (!userId) { userId = uuid(); }
        resetGame();
        showPhase("game");
        toast("GO, " + username + "!");
        sendTelemetry("heartbeat");
        log("game started", username, carName());
    }

    function achFor(s) {
        var a = ACH[0];
        for (var i = 0; i < ACH.length; i++) {
            if (s >= ACH[i].s) { a = ACH[i]; }
        }
        return a;
    }

    function endGame() {
        sendTelemetry("game_over");
        var a = achFor(score);
        var mm = Math.floor(elapsed / 60);
        var ss = elapsed % 60;
        setText("/panel_over/o_rank", a.t);
        setText("/panel_over/o_sub", a.d + (heroMode ? " Survived Hero Mode." : ""));
        setText("/panel_over/o_score", String(score));
        setText("/panel_over/o_stats", lastKmh + " km/h  ·  " + mm + ":" + (ss < 10 ? "0" : "") + ss + "  ·  " + carName());
        setText("/panel_over/o_status", "sending to Kafka...");
        showPhase("over");
        fetchBoard();
        log("game over", score);
    }

    function steer(dir) {
        if (phase !== "game") { return; }
        var next = lane + dir;
        if (next < 0 || next > 2) { return; }
        lane = next;
        placeCar();
        flushBinds();
    }

    function selectCar(which) {
        carType = which;
        bind("/panel_start/s_car_a", "carAColor", which === "corolla" ? ORANGE : "#333333");
        bind("/panel_start/s_car_b", "carBColor", which === "porsche" ? ORANGE : "#333333");
        flushBinds();
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
                        log("subscribe Http." + events[i] + " failed, using sync Http.Request:", String(e));
                        break;
                    }
                }

                var actions = ["racing.go", "racing.left", "racing.right",
                               "racing.car_a", "racing.car_b", "racing.again"];
                for (var j = 0; j < actions.length; j++) {
                    var sub = svcCall("SystemGui", "SubscribeAction", { Action: actions[j] });
                    if (!sub.success) {
                        log("SubscribeAction " + actions[j] + " failed:", sub.error || "unknown");
                    }
                }

                var t1 = svcCall("SystemTimer", "StartPeriodic", { Name: "rc_tick", IntervalMs: TICK_MS });
                if (t1.success) { tickTimerId = t1.data; } else { log("tick timer failed:", t1.error); }
                var t2 = svcCall("SystemTimer", "StartPeriodic", { Name: "rc_sec", IntervalMs: SEC_MS });
                if (t2.success) { secTimerId = t2.data; } else { log("second timer failed:", t2.error); }

                selectCar("porsche");
                showPhase("start");
                setText("/panel_start/s_status", "");
            } catch (e) {
                log("on_start error:", String(e));
            }
            return true;
        },

        on_action: function (action) {
            try {
                if (action === "racing.go") {
                    startGame();
                } else if (action === "racing.left") {
                    steer(-1);
                } else if (action === "racing.right") {
                    steer(1);
                } else if (action === "racing.car_a") {
                    selectCar("corolla");
                } else if (action === "racing.car_b") {
                    selectCar("porsche");
                } else if (action === "racing.again") {
                    resetGame();
                    showPhase("game");
                    toast("GO, " + username + "!");
                    sendTelemetry("heartbeat");
                }
            } catch (e) {
                log("on_action error:", String(e));
            }
            return true;
        },

        on_event: function (serviceName, eventName, itemsJson) {
            try {
                if (serviceName === "Http") { handleHttpEvent(eventName, itemsJson); }
            } catch (e) {
                log("on_event error:", String(e));
            }
            return true;
        },

        on_timer: function (timerId, name) {
            try {
                if (name === "rc_tick") { tick(); } else if (name === "rc_sec") { everySecond(); }
            } catch (e) {
                log("on_timer error:", String(e));
            }
            return true;
        },

        on_stop: function () {
            log("stopping");
            try {
                if (tickTimerId !== null) {
                    svcCall("SystemTimer", "Stop", { TimerId: tickTimerId });
                    tickTimerId = null;
                }
                if (secTimerId !== null) {
                    svcCall("SystemTimer", "Stop", { TimerId: secTimerId });
                    secTimerId = null;
                }
                if (httpServiceHandle !== null) {
                    try {
                        brookesia.stop_service(httpServiceHandle);
                    } catch (e) { /* core releases leftovers anyway */ }
                    httpServiceHandle = null;
                }
                pendingHttp = {};
                lastText = {};
                lastBind = {};
                pendingBinds = [];
            } catch (e) {
                log("on_stop error:", String(e));
            }
            return true;
        }
    };
})();
