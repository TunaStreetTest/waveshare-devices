/*
 * "Claude drives" tunastreet.racing (#205, moved out of the core for #212).
 *
 * Reads the same view state the screen shows (obstacle sprites and
 * positions, the car's lane) and picks a lane, exactly as a player would
 * from looking at the panel. Shared by the browser simulator (watchable,
 * via ?drive=examples/racing-bot.js) and headless.js --drive (scoreable),
 * so what you watch is what scores.
 *
 * Driver contract (tools/simulator/README.md): a module loaded via --drive
 * exports { create(shim, opts) -> {step, keymap?, boot?, isActive?, isDone?,
 * restart?, summary?} }. Only step and keymap are load-bearing for the core;
 * boot/isActive/isDone/restart/summary are this app's own hooks so headless.js
 * can run a full race and print a score-comparable summary without knowing
 * anything about racing itself.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) { module.exports = factory(); }
    // Browser load path (panel.html injects this as a classic <script>, not
    // an ES module): every driver assigns the same well-known global so the
    // core never needs to know the driver's file name, only its --drive path.
    else { root.PanelDriver = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    var CAR_Y = 300;
    var CAR_LANE_X = [61 - 28, 184 - 28, 307 - 28];
    var OBS_LANE_X = [61 - 22, 184 - 22, 307 - 22];

    function nearest(xs, x) {
        var best = 0, bd = 1e9;
        for (var i = 0; i < xs.length; i++) {
            var d = Math.abs(xs[i] - x);
            if (d < bd) { bd = d; best = i; }
        }
        return best;
    }

    function Bot(shim, opts) {
        this.shim = shim;
        // Iceberg farming is a degenerate strategy: each pickup drops the speed
        // level, so a bot that grabs every one pins difficulty at Lv.1 forever
        // (measured: 20 min / 44,860 pts, never scratched). "pure" mode dodges
        // them too, so the run is an honest test of the difficulty curve.
        this.pure = !!(opts && opts.pure);
        this.node = function (p) { return shim.doc.byPath[p]; };
    }

    Bot.prototype.carLane = function () {
        return nearest(CAR_LANE_X, this.node("/home/panel_game/g_car")._x);
    };

    Bot.prototype.threats = function () {
        var out = [];
        for (var i = 0; i < 6; i++) {
            var o = this.node("/home/panel_game/g_obs" + i);
            if (!o || o._hidden) { continue; }
            out.push({
                lane: nearest(OBS_LANE_X, o._x),
                y: o._y,
                iceberg: (o._src || "").indexOf("iceberg") >= 0
            });
        }
        return out;
    };

    // Score each lane: imminent villains repel hard, icebergs attract, and
    // staying put beats jittering between equally-safe lanes.
    Bot.prototype.chooseLane = function () {
        var mine = this.carLane();
        var danger = [0, 0, 0], want = [0, 0, 0];
        var t = this.threats();
        for (var i = 0; i < t.length; i++) {
            var o = t[i];
            if (o.y > CAR_Y + 60 || o.y < -80) { continue; }
            var closeness = Math.max(0, 400 - (CAR_Y - o.y));
            if (o.iceberg && !this.pure) { want[o.lane] += closeness; }
            else { danger[o.lane] += closeness; }
        }
        var best = mine, bestScore = -1e9;
        for (var l = 0; l < 3; l++) {
            var s = want[l] - danger[l] * 2;
            if (Math.abs(l - mine) > 1) { s -= 50; }
            if (l === mine) { s += 20; }
            if (s > bestScore) { bestScore = s; best = l; }
        }
        return best;
    };

    // One decision per frame; returns the lane it steered to, or null.
    Bot.prototype.step = function () {
        var want = this.chooseLane();
        if (want === this.carLane()) { return null; }
        this.shim.emit("racing.lane" + want);
        return want;
    };

    Bot.prototype.panelVisible = function (id) {
        var n = this.node("/home/" + id);
        return !!n && !n._hidden;
    };

    Bot.prototype.text = function (path) { var n = this.node(path); return n ? n._text : null; };

    Bot.prototype.boot = function () {
        this.shim.emit("racing.car_b");
        this.shim.emit("racing.go");
    };

    Bot.prototype.isActive = function () { return this.panelVisible("panel_game"); };
    Bot.prototype.isDone = function () { return this.panelVisible("panel_over"); };
    Bot.prototype.restart = function () { this.shim.emit("racing.again"); this.shim.emit("racing.go"); };

    Bot.prototype.summary = function () {
        var t = this.text.bind(this);
        var lines = [];
        lines.push("== start screen: " + t("/home/panel_car/c_greet") + " | " + t("/home/panel_car/c_go/c_go_t"));
        lines.push("== result panel: " + this.isDone());
        if (this.isDone()) {
            lines.push("   rank : " + t("/home/panel_over/o_rank"));
            lines.push("   score: " + t("/home/panel_over/o_score"));
            lines.push("   stats: " + t("/home/panel_over/o_stats"));
            lines.push("   board: " + t("/home/panel_over/o_b1") + " | " + t("/home/panel_over/o_b2"));
            lines.push("   status: " + t("/home/panel_over/o_status"));
        } else {
            // Ran out of ticks before the bot died (expected in default mode --
            // iceberg farming keeps the bot alive for a very long time, #205's
            // measured "20 min / 44,860 pts, never scratched"). Report the live
            // in-race state instead of blank result-panel fields.
            lines.push("   still racing - score: " + t("/home/panel_game/g_score") +
                " lives: " + t("/home/panel_game/g_lives") + " " + t("/home/panel_game/g_speed"));
        }
        return lines.join("\n");
    };

    return {
        create: function (shim, opts) { return new Bot(shim, opts); },
        // Browser keyboard bindings (panel.html reads this to wire keydown ->
        // action; unrelated to headless.js, which drives via .step()).
        keymap: {
            ArrowLeft: "racing.lane0", ArrowDown: "racing.lane1", ArrowRight: "racing.lane2",
            "1": "racing.car_a", "2": "racing.car_b"
        },
        // Racing also wants Enter to start/restart -- panel.html checks for
        // this optional hook before falling back to keymap-only handling.
        onKey: function (shim, key) {
            if (key === "Enter") { shim.emit("racing.go"); shim.emit("racing.again"); return true; }
            return false;
        }
    };
});
