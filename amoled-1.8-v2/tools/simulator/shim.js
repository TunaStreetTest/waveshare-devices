/*
 * Brookesia host-bridge shim (#205, generalised for #212).
 *
 * Runs a REAL Brookesia runtime app's app/app.js — unmodified — outside the
 * board, by emulating the parts of the sandbox it uses: the global
 * `brookesia` object, the SystemGui / SystemTimer / Http services, and the
 * JSON-UI document built from a res/screens/<id>.json.
 *
 * This module is app-agnostic: it knows nothing about racing, xviewer, or
 * any other package. Per-app driving logic lives in tools/simulator/examples/
 * and is loaded via --drive / ?drive=, never in here.
 *
 * Two renderers share one core so the same run happens in both places:
 *   - DomRenderer   : real pixels in a browser at 368x448 (panel.html)
 *   - StateRenderer : no DOM, just the view tree's state (headless.js / lint.js)
 *
 * This exists because "flash it and ask Steven to play" is a terrible test
 * loop: a layout bug that renders a near-blank screen, or a press a drag
 * could swallow, is caught here in seconds instead.
 */
(function (root) {
    "use strict";

    function deepGet(obj, path) {
        var parts = path.split(".");
        var cur = obj;
        for (var i = 0; i < parts.length; i++) {
            if (cur === undefined || cur === null) { return undefined; }
            cur = cur[parts[i]];
        }
        return cur;
    }

    // ---- the view tree -----------------------------------------------------
    function Doc(screenJson) {
        this.byPath = {};
        this.root = screenJson;
        this.index(screenJson, "/" + screenJson.id, null);
    }

    Doc.prototype.index = function (node, path, parent) {
        node._path = path;
        node._parent = parent;
        node._text = (node.labelProps && node.labelProps.text) || "";
        node._src = (node.imageProps && node.imageProps.src) || "";
        node._hidden = !!(node.commonProps && node.commonProps.hidden);
        // Parent-relative offset (mode:"absolute" only; flex/flow children are
        // positioned by computeGeometry(), not by placement.x/y).
        node._x = (node.placement && node.placement.x) || 0;
        node._y = (node.placement && node.placement.y) || 0;
        node._bg = (node.style && node.style.bgColor) || "";
        this.byPath[path] = node;
        var kids = node.children || [];
        for (var i = 0; i < kids.length; i++) {
            this.index(kids[i], path + "/" + kids[i].id, node);
        }
    };

    // A binding key is declared on a node as {"placement.x": "carX"}; a write
    // names the node path + key, exactly like the device.
    Doc.prototype.applyBinding = function (path, key, value) {
        var node = this.byPath[path];
        if (!node) { return { success: false, error: "no such path " + path }; }
        var field = null;
        var b = node.bindings || {};
        for (var f in b) {
            if (b[f] === key) { field = f; break; }
        }
        if (!field) { return { success: false, error: "no binding " + key + " on " + path }; }
        if (field === "placement.x") { node._x = Number(value); }
        else if (field === "placement.y") { node._y = Number(value); }
        else if (field === "commonProps.hidden") { node._hidden = (value === "true"); }
        else if (field === "style.bgColor") { node._bg = value; }
        else if (field === "style.textColor") { node._color = value; }
        else if (field === "style.fontSize") { node._size = Number(value); }
        node._dirty = true;
        return { success: true };
    };

    // ---- computed geometry --------------------------------------------------
    // A minimal flexbox-ish layout pass so headless/lint code (no DOM) can
    // still ask "where is this node, really" for a flex/flow-laid-out screen
    // (tunastreet.xviewer is the first app whose whole tree is flow+flex).
    // The DOM renderer does NOT use this -- it hands flex containers real CSS
    // and lets the browser do exact layout; this pass exists for the state
    // renderer and the static lint, which have no browser to ask.
    function estimateSize(node) {
        if (node.type === "label") {
            var fs = (node.style && node.style.fontSize) || 14;
            var text = (node.labelProps && node.labelProps.text) || "";
            var w = Math.max(fs, Math.round(text.length * fs * 0.62) + 8);
            var h = Math.round(fs * 1.35);
            return { w: w, h: h };
        }
        if (node.type === "image") {
            return { w: 24, h: 24 };
        }
        return { w: 24, h: 24 }; // generic container fallback when nothing is declared
    }

    function ownSize(node, fallbackW, fallbackH) {
        var p = node.placement || {};
        var w = (typeof p.width === "number") ? p.width : null;
        var h = (typeof p.height === "number") ? p.height : null;
        if (w === null || h === null) {
            var est = estimateSize(node);
            if (w === null) { w = (fallbackW !== undefined) ? fallbackW : est.w; }
            if (h === null) { h = (fallbackH !== undefined) ? fallbackH : est.h; }
        }
        return { w: w, h: h };
    }

    Doc.prototype.computeGeometry = function () {
        var self = this;

        function layoutFlexChildren(parent, kids, cx, cy, cw, ch) {
            var flow = (parent.layout && parent.layout.flexFlow) || "row";
            var row = flow === "row";
            var mainAlign = (parent.layout && parent.layout.mainAlign) || "start";
            var crossAlign = (parent.layout && parent.layout.crossAlign) || "start";
            var gap = (parent.layout && parent.layout.gap) || 0;
            var mainKey = row ? "w" : "h";
            var crossKey = row ? "h" : "w";
            var mainAvail = row ? cw : ch;
            var crossAvail = row ? ch : cw;

            var sizes = kids.map(function (c) {
                var s = ownSize(c);
                s.grow = (c.placement && c.placement.flexGrow) || 0;
                return s;
            });

            var mainTotal = 0, growSum = 0;
            sizes.forEach(function (s) { mainTotal += s[mainKey]; growSum += s.grow; });
            var gapTotal = gap * Math.max(0, kids.length - 1);
            var free = mainAvail - mainTotal - gapTotal;
            if (growSum > 0 && free > 0) {
                sizes.forEach(function (s) { if (s.grow > 0) { s[mainKey] += free * (s.grow / growSum); } });
                free = 0;
            }

            var used = gapTotal;
            sizes.forEach(function (s) { used += s[mainKey]; });
            var startMain = 0, between = gap;
            if (mainAlign === "center") { startMain = Math.max(0, (mainAvail - used) / 2); }
            else if (mainAlign === "end") { startMain = Math.max(0, mainAvail - used); }
            else if (mainAlign === "spaceBetween" && kids.length > 1) {
                between = Math.max(gap, (mainAvail - mainTotal) / (kids.length - 1));
            } else if (mainAlign === "spaceAround" && kids.length > 0) {
                var extra = Math.max(0, mainAvail - mainTotal) / kids.length;
                startMain = extra / 2;
                between = extra + gap;
            }

            var mainPos = startMain;
            for (var i = 0; i < kids.length; i++) {
                var c = kids[i], s = sizes[i];
                var crossPos = 0;
                if (crossAlign === "center") { crossPos = Math.max(0, (crossAvail - s[crossKey]) / 2); }
                else if (crossAlign === "end") { crossPos = Math.max(0, crossAvail - s[crossKey]); }
                var childX = row ? (cx + mainPos) : (cx + crossPos);
                var childY = row ? (cy + crossPos) : (cy + mainPos);
                c._cw = s.w; c._ch = s.h;
                layout(c, childX, childY);
                mainPos += s[mainKey] + between;
            }
        }

        function layout(node, originX, originY) {
            node._cx = originX;
            node._cy = originY;
            var kids = node.children || [];
            if (!kids.length) { return; }
            var pad = (node.style && node.style.padding) || 0;
            var contentX = originX + pad, contentY = originY + pad;
            var contentW = Math.max(0, (node._cw || 0) - pad * 2);
            var contentH = Math.max(0, (node._ch || 0) - pad * 2);
            var layoutType = node.layout && node.layout.type;
            if (layoutType === "flex" || layoutType === "grid") {
                // Grid is approximated as flex-row-wrap-free (no app here uses
                // grid yet); revisit if one does.
                layoutFlexChildren(node, kids, contentX, contentY, contentW, contentH);
            } else {
                for (var i = 0; i < kids.length; i++) {
                    var c = kids[i];
                    var size = ownSize(c, contentW, contentH);
                    c._cw = size.w; c._ch = size.h;
                    var cx = (c.placement && typeof c.placement.x === "number") ? c.placement.x : 0;
                    var cy = (c.placement && typeof c.placement.y === "number") ? c.placement.y : 0;
                    layout(c, contentX + cx, contentY + cy);
                }
            }
        }

        this.root._cw = 368;
        this.root._ch = 448;
        layout(this.root, 0, 0);
    };

    // ---- the shim -----------------------------------------------------------
    function Shim(opts) {
        this.doc = new Doc(opts.screen);
        this.renderer = opts.renderer;
        this.httpFetch = opts.httpFetch;              // (request) -> Promise(response)
        this.log = opts.log || function () {};
        this.timers = {};
        this.nextTimerId = 1;
        this.nextReqId = 1;
        this.subscribedActions = {};
        this.subscribedEvents = {};
        this.app = null;
        this.timeMs = 0;
        this.renderer.attach(this.doc);
    }

    Shim.prototype.gui = function (fn, p) {
        var self = this;
        if (fn === "SetText") {
            var n = this.doc.byPath[p.Path];
            if (!n) { return { success: false, error: "no path " + p.Path }; }
            n._text = p.Text; n._dirty = true;
            return { success: true };
        }
        if (fn === "SetBinding") {
            return this.doc.applyBinding(p.Path, p.Key, p.Value);
        }
        if (fn === "SetBindings") {
            var updates = p.Updates || [];
            for (var i = 0; i < updates.length; i++) {
                var r = this.doc.applyBinding(updates[i].Path, updates[i].Key, updates[i].Value);
                if (!r.success) { return r; }
            }
            return { success: true };
        }
        if (fn === "SetViewSrc") {
            var v = this.doc.byPath[p.Path];
            if (!v) { return { success: false, error: "no path " + p.Path }; }
            var src = p.Src;
            v._src = (typeof src === "string" && src.indexOf("${") !== 0) ? "${image." + src + "}" : src;
            v._dirty = true;
            return { success: true };
        }
        if (fn === "GetBinding") {
            var g = this.doc.byPath[p.Path];
            if (!g) { return { success: false, error: "no path " + p.Path }; }
            return { success: true, data: { Value: deepGet(g, p.Key) || "" } };
        }
        if (fn === "SubscribeAction") {
            this.subscribedActions[p.Action] = true;
            return { success: true };
        }
        return { success: false, error: "unimplemented SystemGui." + fn };
    };

    Shim.prototype.timer = function (fn, p) {
        if (fn === "StartPeriodic" || fn === "StartDelayed") {
            var id = this.nextTimerId++;
            this.timers[id] = {
                id: id, name: p.Name,
                every: fn === "StartPeriodic" ? p.IntervalMs : null,
                at: this.timeMs + (fn === "StartPeriodic" ? p.IntervalMs : p.DelayMs)
            };
            return { success: true, data: id };
        }
        if (fn === "Stop") {
            delete this.timers[p.TimerId];
            return { success: true };
        }
        return { success: false, error: "unimplemented SystemTimer." + fn };
    };

    Shim.prototype.http = function (fn, p) {
        var self = this;
        if (fn !== "RequestAsync" && fn !== "Request") {
            return { success: false, error: "unimplemented Http." + fn };
        }
        var id = this.nextReqId++;
        var promise = Promise.resolve().then(function () { return self.httpFetch(p.Request); });
        if (fn === "Request") {
            // Synchronous fallback path: the real bridge blocks the JS thread;
            // callers here just get {success:false} back if it never settles
            // in-process (nothing in this shim actually blocks the event loop).
            return { success: false, error: "unimplemented Http.Request (sync) - use RequestAsync in the simulator" };
        }
        promise.then(function (resp) {
            if (self.app && self.app.on_event) {
                self.app.on_event("Http", resp.status_code === 200 ? "RequestCompleted" : "RequestFailed",
                    JSON.stringify({ RequestId: id, Response: resp }));
            }
        }).catch(function (e) {
            if (self.app && self.app.on_event) {
                self.app.on_event("Http", "RequestFailed", JSON.stringify({
                    RequestId: id, Response: { status_code: 0, error: "RequestFailed", error_message: String(e) }
                }));
            }
        });
        return { success: true, data: id };
    };

    Shim.prototype.install = function () {
        var self = this;
        root.brookesia = {
            call_service_function: function (service, fn, jsonParams) {
                var p = {};
                try { p = JSON.parse(jsonParams || "{}"); } catch (e) { /* as on device */ }
                var out;
                if (service === "SystemGui") { out = self.gui(fn, p); }
                else if (service === "SystemTimer") { out = self.timer(fn, p); }
                else if (service === "Http") { out = self.http(fn, p); }
                else { out = { success: false, error: "no service " + service }; }
                return JSON.stringify(out);
            },
            start_service: function () { return 1; },
            stop_service: function () { return true; },
            subscribe_service_event: function (svc, ev) { self.subscribedEvents[svc + "." + ev] = true; },
            print: function (s) { self.log(s); }
        };
    };

    // The app assigns globalThis.brookesia_app; call after loading app.js.
    Shim.prototype.start = function () {
        this.app = root.brookesia_app;
        if (!this.app) { throw new Error("app.js did not set brookesia_app"); }
        this.app.on_start();
        this.renderer.render();
    };

    // payload is a plain object (e.g. {direction:"left", distance:120, ms:180}
    // for a synthesised swipe); default {} for a plain tap/press.
    Shim.prototype.emit = function (action, payload) {
        if (!this.subscribedActions[action]) { return false; }
        this.app.on_action(action, "", JSON.stringify(payload || {}));
        this.renderer.render();
        return true;
    };

    // Advance emulated time; fires timers exactly like SystemTimer would.
    Shim.prototype.advance = function (ms) {
        var end = this.timeMs + ms;
        var guard = 0;
        while (guard++ < 100000) {
            var next = null;
            for (var id in this.timers) {
                var t = this.timers[id];
                if (next === null || t.at < next.at) { next = t; }
            }
            if (!next || next.at > end) { break; }
            this.timeMs = next.at;
            if (next.every) { next.at = this.timeMs + next.every; } else { delete this.timers[next.id]; }
            this.app.on_timer(next.id, next.name);
        }
        this.timeMs = end;
        this.renderer.render();
    };

    // ---- renderers -----------------------------------------------------------
    function StateRenderer() { this.doc = null; }
    StateRenderer.prototype.attach = function (doc) { this.doc = doc; };
    StateRenderer.prototype.render = function () { /* state lives on the nodes */ };
    StateRenderer.prototype.text = function (path) {
        var n = this.doc.byPath[path];
        return n ? n._text : null;
    };
    StateRenderer.prototype.visible = function (path) {
        var n = this.doc.byPath[path];
        while (n) {
            if (n._hidden) { return false; }
            n = n._parent;
        }
        return true;
    };
    // Generic dump of every visible label's text, keyed by path -- used by the
    // app-agnostic core (headless.js) so a regression diff has *something*
    // concrete to compare without knowing what any given app's labels mean.
    StateRenderer.prototype.dumpLabels = function () {
        var out = {};
        var doc = this.doc;
        for (var path in doc.byPath) {
            var n = doc.byPath[path];
            if (n.type === "label" && this.visible(path)) { out[path] = n._text; }
        }
        return out;
    };

    root.PanelKit = { Shim: Shim, Doc: Doc, StateRenderer: StateRenderer };
    // Back-compat alias: the #205 racing simulator and anything still pointed
    // at it (backend/server.py's routes) referenced globalThis.RacingShim.
    root.RacingShim = root.PanelKit;
})(typeof globalThis !== "undefined" ? globalThis : this);
