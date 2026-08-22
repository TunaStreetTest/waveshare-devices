/*
 * SPDX-FileCopyrightText: 2026 Steven Matison
 *
 * SPDX-License-Identifier: Apache-2.0
 */
/*
 * toAscii -- the canonical runtime text sanitiser for the AMOLED 1.8 V2.
 *
 * THIS FILE IS THE SOURCE OF TRUTH AND IS COPIED VERBATIM INTO EVERY APP.
 * The Brookesia JS runtime has no module loader -- an app is one global script
 * -- so each apps/<id>/app/app.js carries an inlined copy between the
 * BEGIN/END sentinels below. tools/simulator/selftest.js asserts every copy is
 * byte-identical to this file; edit here, then re-run tools/sync-ascii.py.
 *
 * Why it exists: CONFIG_LV_USE_FREETYPE and CONFIG_LV_USE_TINY_TTF are both
 * off, so every glyph comes from a compiled-in LVGL Montserrat, which carries
 * ASCII and nothing else. panelkit already refuses non-ASCII in a GENERATED
 * screen, but that only covers text baked in at generation time. Runtime text
 * -- an X post, a launch name, a processor name, anything a backend sends --
 * goes straight to SetText and was never checked. Measured against the live
 * x-viewer feed: 24 non-ASCII characters across 15 codepoints in a single
 * fetch (emoji, U+2026 ellipsis, U+2014 em dash, U+2019 curly apostrophe),
 * every one of them a white tofu box on the glass.
 *
 * Policy: transliterate what has an honest ASCII spelling, drop what does not.
 * A dropped emoji leaves a gap; a kept one leaves a box that reads as a broken
 * font. Whitespace is deliberately NOT collapsed or trimmed -- callers build
 * fixed-width strings out of runs of spaces (tminus's /meta is status + three
 * spaces + index) and silently reflowing them would trade one glitch for
 * another.
 */
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

if (typeof module === "object" && module.exports) { module.exports = { toAscii: toAscii }; }
