/*
 * X Viewer - ESP-Brookesia v0.8 JavaScript runtime app (issue #183, #198).
 *
 * One post card at a time on the 368x448 AMOLED, fed by the LAN backend
 * (http://192.168.1.121:8091). Swipe left/right (plus tap-to-navigate on the
 * left/right halves of the media card, a guaranteed-path fallback) to move
 * through posts, tap the heart to like/unlike with optimistic toggle.
 *
 * #198 rebuilt res/screens/home.json on the panelkit design system
 * (uikit/gen_xviewer_screen.py in DesktopShare's files/xviewer/) -- bigger
 * text, a real bottom "tools" bar (LIKE/VIEWS/COMMENTS/CLEAR), and prev/next
 * moved onto the media card itself as two big tap zones instead of a 40x36
 * corner glyph. This file's node paths were updated to match; every
 * setText/setBinding/SetViewSrc path below must resolve in that generated
 * screen (see files/xviewer/verify_xviewer_paths.py).
 *
 * Plain global script (no import/export) so the JS backend evaluates it
 * with JS_EVAL_TYPE_GLOBAL. All host access goes through the global
 * `brookesia` object (system_core host_bridge). There is no fetch/XHR/
 * setTimeout in this sandbox: HTTP goes through the "Http" service,
 * timers through "SystemTimer", UI mutation through "SystemGui".
 *
 * Serial triage: every log line is prefixed with [xviewer].
 */

(function () {
    "use strict";

    // ---------------------------------------------------------------- config
    var BACKEND = "http://192.168.1.121:8091";
    var FEED_PATH = "/xviewer/feed";
    var FEED_REFRESH_PATH = "/xviewer/feed?refresh=1"; // CLEAR: bypass the backend cache
    var ACTION_PATH = "/xviewer/action";
    var SCREEN = "/home";
    var FEED_REFRESH_MS = 60000;
    var RETRY_MS = 10000;
    var MAX_TEXT_CHARS = 420;
    var NAV_COOLDOWN_MS = 350;  // one continuous drag emits many gesture events
    var IMG_SLOTS = 3; // at most 3 JPEGs on flash, rotating fixed names
    var COLOR_MUTED = "#71767b";
    var COLOR_LIKED = "#f91880";

    // ---------------------------------------------------------------- state
    var posts = [];
    var idx = 0;
    var navSeq = 0;             // bumps on every render; stale downloads ignored
    var pendingHttp = {};       // request_id (string) -> callback(response)
    var slotOwner = [null, null, null]; // image URL whose JPEG currently occupies slot
    var slotCursor = 0;
    var shownSlot = -1;         // slot whose file the image view currently displays
    var likeInFlight = false;
    var lastNavMs = 0;          // gesture debounce clock (Date.now deltas)
    var feedInFlight = false;
    var forceFirstOnFeed = false; // CLEAR: jump to card 0 instead of keeping place
    var refreshTimerId = null;
    var retryTimerId = null;
    var httpServiceHandle = null;
    var httpEventsOk = false;   // async path available (RequestAsync + events)

    // ---------------------------------------------------------------- utils
    function log() {
        try {
            var parts = ["[xviewer]"];
            for (var i = 0; i < arguments.length; i++) {
                var a = arguments[i];
                parts.push(typeof a === "string" ? a : JSON.stringify(a));
            }
            brookesia.print(parts.join(" "));
        } catch (e) {
            /* even logging is defensive */
        }
    }

    /**
     * Call a service function through the host bridge.
     * Params must be JSON-stringified (the bridge only passes primitives);
     * the return value is a JSON string {"success":bool,"error"?,"data"?}.
     * Returns the parsed result object, or {success:false,error:...} on throw.
     */
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

    function setViewSrc(path, src) {
        return guiCall("SetViewSrc", { Path: SCREEN + path, Src: src });
    }

    function cacheMarker(fileName) {
        // Resolved by host_bridge.cpp resolve_storage_path_markers() to
        // <volume>/apps/tunastreet.xviewer/cache/<fileName>
        return { "$brookesiaStoragePath": { "kind": "AppCache", "relative_path": fileName } };
    }

    function kFormat(n) {
        n = Number(n) || 0;
        if (n >= 1000000) { return (Math.round(n / 100000) / 10) + "M"; }
        if (n >= 1000) { return (Math.round(n / 100) / 10) + "k"; }
        return String(n);
    }

    function setStatus(msg) {
        setText("/topbar/status", msg || "");
    }

    /**
     * True at most once per cooldown window. Guards every navigation, tap and
     * swipe alike: a tap target fires its action on BOTH `pressed` and
     * `released` (panelkit's deliberate belt-and-braces, since a lone
     * `released` can be swallowed), so an undebounced tap moved two cards at
     * once -- and a single drag emits a whole burst of gesture events.
     */
    function navAllowed() {
        var t = Date.now();
        // t < lastNavMs = clock stepped backward (SNTP); never lock nav out.
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

    // ---------------------------------------------------------------- HTTP
    /**
     * Issue an HTTP request. Preferred path: Http.RequestAsync (returns a
     * request id immediately; the response arrives as a RequestCompleted /
     * RequestFailed / RequestCanceled service event handled in on_event).
     * Fallback path (httpEventsOk === false): Http.Request, which blocks the
     * JS thread until the response is in (call_service_function_async is no
     * help here: Http functions are require_scheduler=false, so the "async"
     * bridge form still executes them inline).
     * cb receives the Response object {status_code, body, file_path, error,
     * error_message, ...} or a synthesized {error:"...", ...} on failure.
     */
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
        // Sync fallback. Bridge timeout > internal wait (timeout_ms * (retries+1)).
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
            return; // not ours (service events are global across apps)
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

    // ---------------------------------------------------------------- feed
    function fetchFeed(refresh) {
        if (feedInFlight) {
            return;
        }
        feedInFlight = true;
        if (refresh) {
            forceFirstOnFeed = true;
        }
        log("fetching feed", refresh ? "(refresh)" : "");
        httpRequest({
            url: BACKEND + (refresh ? FEED_REFRESH_PATH : FEED_PATH),
            method: "Get",
            timeout_ms: 8000,
            max_response_size: 262144
        }, onFeedResponse);
    }

    function onFeedResponse(response) {
        feedInFlight = false;
        if (!response || (response.error && response.error !== "Ok") || response.status_code !== 200) {
            var why = response ? (response.error_message || response.error || ("HTTP " + response.status_code)) : "no response";
            log("feed fetch failed:", why);
            setStatus("backend unreachable - retrying");
            scheduleRetry();
            return;
        }
        var body;
        try {
            body = JSON.parse(response.body);
        } catch (e) {
            log("feed parse failed:", String(e));
            setStatus("bad feed payload - retrying");
            scheduleRetry();
            return;
        }
        // Live backend wraps posts in {posts:[...]}; accept a bare array too.
        var list = Array.isArray(body) ? body : (Array.isArray(body.posts) ? body.posts : null);
        if (!list || list.length === 0) {
            log("feed empty");
            setStatus("feed is empty - retrying");
            scheduleRetry();
            return;
        }
        var currentId = posts[idx] ? posts[idx].id : null;
        posts = list;
        if (forceFirstOnFeed) {
            // CLEAR: always land on the first card, don't try to keep place.
            forceFirstOnFeed = false;
            idx = 0;
        } else if (currentId !== null) {
            // keep the user's place across refreshes when the post is still there
            for (var i = 0; i < posts.length; i++) {
                if (posts[i].id === currentId) {
                    idx = i;
                    break;
                }
            }
        }
        if (idx >= posts.length) {
            idx = 0;
        }
        setStatus("");
        log("feed ok:", posts.length, "posts");
        render();
    }

    function scheduleRetry() {
        var result = svcCall("SystemTimer", "StartDelayed", { Name: "xv_retry", DelayMs: RETRY_MS });
        if (result.success) {
            retryTimerId = result.data;
        } else {
            log("retry timer failed:", result.error || "unknown");
        }
    }

    // ---------------------------------------------------------------- render
    function render() {
        navSeq++;
        var p = posts[idx];
        if (!p) {
            return;
        }
        var text = String(p.text || "");
        if (text.length > MAX_TEXT_CHARS) {
            text = text.slice(0, MAX_TEXT_CHARS - 3) + "...";
        }
        setText("/post_text", text);
        renderMetrics(p);
        setText("/topbar/pos", (idx + 1) + "/" + posts.length);
        renderImage(p);
    }

    function renderMetrics(p) {
        var m = p.metrics || {};
        // replies is new on the backend (#198) -- a stale/un-restarted
        // process won't send it yet, so a missing value reads as 0.
        var replies = typeof m.replies === "number" ? m.replies : 0;
        setText("/toolbar/t_like/t_like_c", kFormat(m.likes));
        setText("/toolbar/t_views/t_views_v", kFormat(m.views));
        setText("/toolbar/t_comments/t_comments_v", kFormat(replies));
        setViewSrc("/toolbar/t_like/t_like_img", p.liked ? "heart_on" : "heart_off");
        setBinding("/toolbar/t_like/t_like_c", "likeColor", p.liked ? COLOR_LIKED : COLOR_MUTED);
    }

    function imageUrlFor(p) {
        if (!p.img) {
            return null;
        }
        if (p.img === true) {
            return BACKEND + "/xviewer/img/" + p.id + ".jpg";
        }
        var s = String(p.img);
        if (s.indexOf("http://") === 0 || s.indexOf("https://") === 0) {
            return s;
        }
        return BACKEND + (s.charAt(0) === "/" ? s : "/" + s);
    }

    function hideImage() {
        setBinding("/media/card_img", "imgHidden", "true");
    }

    function showImageFromSlot(slot) {
        // SetViewSrc accepts a raw filesystem path (marker-resolved by the
        // host bridge before the service sees it); the LVGL backend preloads
        // the JPEG bytes from that path.
        var result = guiCall("SetViewSrc", {
            Path: SCREEN + "/media/card_img",
            Src: cacheMarker("img_" + slot + ".jpg")
        });
        if (result.success) {
            shownSlot = slot;
            setBinding("/media/card_img", "imgHidden", "false");
        } else {
            hideImage();
        }
    }

    function pickSlot(url) {
        for (var i = 0; i < IMG_SLOTS; i++) {
            if (slotOwner[i] === url) {
                return i; // JPEG already on flash for this URL
            }
        }
        // never overwrite the file the image view is currently showing
        for (var j = 0; j < IMG_SLOTS; j++) {
            slotCursor = (slotCursor + 1) % IMG_SLOTS;
            if (slotCursor !== shownSlot) {
                return slotCursor;
            }
        }
        return (shownSlot + 1) % IMG_SLOTS;
    }

    function renderImage(p) {
        var url = imageUrlFor(p);
        if (!url) {
            hideImage();
            return;
        }
        var cachedSlot = -1;
        for (var i = 0; i < IMG_SLOTS; i++) {
            if (slotOwner[i] === url) {
                cachedSlot = i;
                break;
            }
        }
        if (cachedSlot >= 0) {
            showImageFromSlot(cachedSlot);
            return;
        }
        // Keyed by URL, not post id: every text post carries the same avatar
        // URL, so all of them share one cached slot and one download.
        hideImage(); // black for the moment the download takes
        var slot = pickSlot(url);
        var seqAtRequest = navSeq;
        slotOwner[slot] = null; // file about to be overwritten
        httpRequest({
            url: url,
            method: "Get",
            timeout_ms: 10000,
            download_path: cacheMarker("img_" + slot + ".jpg"),
            max_file_size: 262144
        }, function (response) {
            if (navSeq !== seqAtRequest) {
                // user moved on; keep the bytes, remember the owner for reuse
                if (response && response.status_code === 200 && (!response.error || response.error === "Ok")) {
                    slotOwner[slot] = url;
                }
                return;
            }
            if (!response || (response.error && response.error !== "Ok") || response.status_code !== 200) {
                log("image fetch failed for", p.id, response ? (response.error_message || response.error) : "no response");
                hideImage();
                return;
            }
            slotOwner[slot] = url;
            showImageFromSlot(slot);
        });
    }

    // ---------------------------------------------------------------- nav / like
    function goTo(newIdx) {
        if (posts.length === 0) {
            return;
        }
        idx = (newIdx + posts.length) % posts.length;
        render();
    }

    /**
     * CLEAR tool: the backend has no server-side "clear" concept, only a
     * cache-bypassing refetch (?refresh=1) -- so CLEAR means "drop the
     * cached feed and reload from the top," landing on card 0 regardless of
     * where the user was (forceFirstOnFeed, consumed in onFeedResponse).
     * feedInFlight is the existing debounce: a tap while a fetch is already
     * running is a no-op, same as the periodic/retry timers.
     */
    function doClear() {
        log("clear tapped");
        setStatus("clearing...");
        fetchFeed(true);
    }

    function toggleLike() {
        var p = posts[idx];
        if (!p || likeInFlight) {
            return;
        }
        likeInFlight = true;
        var wanted = !p.liked;
        // optimistic flip
        p.liked = wanted;
        p.metrics = p.metrics || {};
        p.metrics.likes = Math.max(0, (Number(p.metrics.likes) || 0) + (wanted ? 1 : -1));
        renderMetrics(p);
        httpRequest({
            url: BACKEND + ACTION_PATH,
            method: "Post",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: String(p.id), action: wanted ? "like" : "unlike" }),
            timeout_ms: 8000,
            max_response_size: 4096
        }, function (response) {
            likeInFlight = false;
            if (!response || (response.error && response.error !== "Ok") || response.status_code !== 200) {
                // revert the optimistic flip
                p.liked = !wanted;
                p.metrics.likes = Math.max(0, (Number(p.metrics.likes) || 0) + (wanted ? -1 : 1));
                renderMetrics(p);
                setStatus("like failed");
                log("like POST failed for", p.id, response ? (response.error_message || response.error) : "no response");
                return;
            }
            try {
                var body = JSON.parse(response.body);
                if (typeof body.liked === "boolean" && body.liked !== p.liked) {
                    p.liked = body.liked;
                    renderMetrics(p);
                }
            } catch (e) {
                log("like response parse failed:", String(e));
            }
            setStatus("");
        });
    }

    // ---------------------------------------------------------------- lifecycle
    globalThis.brookesia_app = {
        on_start: function () {
            log("starting");
            try {
                // Keep an explicit binding so the Http service stays alive for
                // the app's lifetime (released by the core on stop).
                try {
                    httpServiceHandle = brookesia.start_service("Http");
                } catch (e) {
                    log("start_service(Http) failed (may already run):", String(e));
                }

                // Response events for the non-blocking RequestAsync path.
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

                // GUI actions (declared in res/screens/home.json).
                var actions = ["xviewer.gesture", "xviewer.like", "xviewer.prev", "xviewer.next", "xviewer.clear"];
                for (var j = 0; j < actions.length; j++) {
                    var subResult = svcCall("SystemGui", "SubscribeAction", { Action: actions[j] });
                    if (!subResult.success) {
                        log("SubscribeAction " + actions[j] + " failed:", subResult.error || "unknown");
                    }
                }

                // Periodic feed refresh.
                var timerResult = svcCall("SystemTimer", "StartPeriodic", { Name: "xv_refresh", IntervalMs: FEED_REFRESH_MS });
                if (timerResult.success) {
                    refreshTimerId = timerResult.data;
                } else {
                    log("refresh timer failed:", timerResult.error || "unknown");
                }

                fetchFeed();
            } catch (e) {
                log("on_start error:", String(e));
            }
            return true;
        },

        on_action: function (action, path, payloadJson) {
            try {
                if (action === "xviewer.gesture") {
                    var payload = {};
                    try {
                        payload = JSON.parse(payloadJson || "{}");
                    } catch (e) { /* ignore */ }
                    // Only horizontal swipes navigate. Vertical gestures are
                    // deliberately ignored so the system's swipe-up home
                    // gesture (handled at the display-port layer) is never
                    // interfered with.
                    if (payload.direction === "left" || payload.direction === "right") {
                        // Debounce: the touch layer emits multiple gesture
                        // events per continuous drag; only the first within
                        // the cooldown window navigates (same guard idea as
                        // likeInFlight).
                        if (gestureAllowed()) {
                            goTo(payload.direction === "left" ? idx + 1 : idx - 1);
                        }
                    }
                } else if (action === "xviewer.next") {
                    if (navAllowed()) { goTo(idx + 1); }
                } else if (action === "xviewer.prev") {
                    if (navAllowed()) { goTo(idx - 1); }
                } else if (action === "xviewer.like") {
                    toggleLike();
                } else if (action === "xviewer.clear") {
                    doClear();
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
                if (name === "xv_refresh" || name === "xv_retry") {
                    fetchFeed();
                }
            } catch (e) {
                log("on_timer error:", String(e));
            }
            return true;
        },

        on_stop: function () {
            log("stopping");
            try {
                if (refreshTimerId !== null) {
                    svcCall("SystemTimer", "Stop", { TimerId: refreshTimerId });
                    refreshTimerId = null;
                }
                if (retryTimerId !== null) {
                    svcCall("SystemTimer", "Stop", { TimerId: retryTimerId });
                    retryTimerId = null;
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
