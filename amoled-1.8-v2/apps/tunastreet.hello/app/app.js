/*
 * Tuna Hello - minimal ESP-Brookesia JavaScript runtime app.
 *
 * The app's UI comes entirely from res/root.json + res/screens/home.json,
 * mounted automatically at startup via res/profile.json's screen_flows[]
 * (system_core reads that independently of this script). This entry
 * script only needs to exist and define the brookesia_app lifecycle
 * object; any hook left undefined is filled with a no-op by the JS
 * backend's lifecycle shim (see runtime/brookesia_runtime_js/src/backend.cpp
 * ensure_js_lifecycle_module()).
 *
 * Written as a plain global script (no import/export) so the backend
 * evaluates it with JS_EVAL_TYPE_GLOBAL instead of JS_EVAL_TYPE_MODULE.
 */
globalThis.brookesia_app = {
    on_start: function () {
        return true;
    },
    on_stop: function () {
        return true;
    }
};
