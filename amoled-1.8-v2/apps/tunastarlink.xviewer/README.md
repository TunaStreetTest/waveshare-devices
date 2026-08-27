# tunastreet.xviewer — X Viewer runtime app (#183, #198)

ESP-Brookesia v0.8 JavaScript runtime app for the Waveshare 1.8" AMOLED (368x448
portrait). Shows the TunaStreet X feed one card at a time: 368x220 media slot,
wrapped post text, and a real bottom tools bar. Dark, X-ish styling.

`res/screens/home.json` is generated, not hand-written — see
`gen_xviewer_screen.py` (DesktopShare `files/xviewer/`), built on the
panelkit design system (#208). #198 rebuilt the screen from scratch: the old
hand-written JSON linted dirty (3 `requireValidPress` sites, 5 sub-15px
labels, a 48px bottom bar with 40x36 nav targets and a 28px heart) — every
one of those was the "text/buttons too small" complaint. Regenerate with
`python3 gen_xviewer_screen.py`; don't hand-edit the JSON.

## Layout (368x448, four stacked regions)

| Region | y-range | Contents |
|---|---|---|
| `topbar` | 0-28 | `pos` ("n/N", left) + `status` (error/loading text, right) |
| `media` | 28-248 | 368x220 `card_img`, plus `nav_prev`/`nav_next` tap zones |
| `post_text` | 248-364 | wrapped post body, 20px |
| `toolbar` | 364-448 | `t_like` (heart image + count) / `t_views` / `t_comments` — three equal 116px boxes |

## Backend contract (`http://192.168.1.121:8091`)

| Endpoint | Shape (verified against the live backend 2026-08-21) |
|---|---|
| `GET /xviewer/feed` | `{account, cached, count, panel, posts:[{id, author, text, ts, media_type, img, liked, metrics:{likes,reposts,views,replies}}]}` — `img` is a URL path (`/xviewer/img/<id>.jpg`) or `null`. `replies` is new (#198); the app treats a missing value as `0`. The app also accepts a bare top-level array, `img: true`, and absolute `img` URLs. |
| `GET /xviewer/img/<id>.jpg` | pre-scaled 368x220 baseline JPEG (~17 KB) |
| `POST /xviewer/action` | body `{"id":"...","action":"like"\|"unlike"}` → `{"liked":bool}` |
| `GET /xviewer/feed?refresh=1` | forces a re-fetch from X, bypassing the cache. **Nothing on the device calls this** — it was the CLEAR tool's endpoint, and CLEAR is gone (#218). |

## Gestures / input

- **Swipe left** = next post, **swipe right** = previous (JSON-UI `gesture`
  event on the screen root → `xviewer.gesture` action; the JS handler only
  acts on `direction: left|right`).
- **Swipe up/down is never intercepted**: vertical directions are explicitly
  ignored in `on_action`, and the system home swipe is handled at the display
  port layer (Display-service gesture recognition in `brookesia_system_super`
  `shell_display.cpp`), independent of LVGL object events.
- **Tap-to-navigate on the media card** is the guaranteed fallback path
  (#198 moved this off a 40x36 corner glyph and onto the card itself): the
  left half of the 368x220 `card_img` (`nav_prev`) and the right half
  (`nav_next`) are each a full-height, 184px-wide `canvas()` tap target —
  `xviewer.prev`/`xviewer.next` — with small `‹`/`›` chevron glyphs overlaid
  for affordance. Both zones sit *behind* `card_img` and the chevrons in
  child order; since neither the image nor the chevron labels are
  clickable, LVGL's hit-test skips them and the tap falls through to the
  zone underneath (same non-clickable-sibling passthrough
  `tunastreet.agent`'s `tapzone` uses) — so the photo renders unobstructed
  while the whole card stays tap-navigable. Reason a tap path is mandatory
  at all: code reading of the bundled LVGL 9.5 says `LV_EVENT_GESTURE` is
  only delivered to an object whose `LV_OBJ_FLAG_GESTURE_BUBBLE` is cleared
  (`lv_indev.c:1781-1785` — the loop climbs while the flag is set, then
  bails on `NULL`), and only parent-less screen/layer objects lack the flag
  (`lv_obj.c:593 if(parent) obj->flags |= LV_OBJ_FLAG_GESTURE_BUBBLE`).
  Mounted documents are children of the active screen
  (`brookesia_gui_lvgl/src/backend.cpp:653 lv_obj_set_parent`), and neither
  `bind_events` (`event.cpp`) nor the mount path clears the flag — so JSON
  `gesture` events on app nodes may never fire on this backend even though
  `events.rst` documents them (the shell's own `overlay.json` mask has the
  same declaration). The taps make navigation work regardless; if the
  swipes do fire on hardware, both paths coexist safely.
- **Tap the LIKE tool** (`t_like`, heart image + count) = like/unlike with
  optimistic toggle; the flip is reverted if the `POST /xviewer/action`
  fails. Heart is an image pair (`heart_off`/`heart_on` PNGs in the
  imageSet) because the system font (Telex-Regular) has no heart glyph; the
  likes count also recolors to `#f91880` via a `style.textColor` binding
  (`likeColor`).
- **VIEWS / COMMENTS** (`t_views` / `t_comments`) are display-only readouts
  (views count, and the backend's `replies` field) — there's no
  device-side action for either.

## The SetViewSrc-with-file-path spike

**Verdict: raw filesystem paths work — implemented as the primary path.**

Chain, with evidence:

1. `SystemGui.SetViewSrc(Path, Src)` passes `Src` verbatim to
   `Runtime::set_view_src` (`system_core/src/system/gui.cpp:1211-1230`).
2. `update_image_source` sets `image_props.src = src` and tries
   `resolve_image_spec`; an unknown id resolves empty
   (`gui_interface/src/runtime_binding.cpp:1408-1448`), and
   `make_runtime_image_resource` then falls back to
   `primary_src = image_props.src` — i.e. the raw string is used as a file
   path (`gui_interface/src/runtime_document.cpp:477-490`, and
   `runtime_view_properties.cpp:269-271` for the same fallback in
   `set_view_src`).
3. The LVGL backend requires preload for `.jpg/.jpeg/.png/.bin` paths
   (`gui_lvgl/src/props.cpp:74-79`) and reads the bytes through the Storage
   service (`props_image.cpp:190` `read_storage_file_bytes` →
   `StorageHelper::fs_read_text`), so any absolute path the Storage service
   can read is loadable. JPEG additionally needs the platform decoder
   (`props_image.cpp:35-50`, `CONFIG_ESP_LVGL_ADAPTER_ENABLE_DECODER`).
4. The app never hardcodes the absolute path: it passes
   `{"$brookesiaStoragePath":{"kind":"AppCache","relative_path":"img_N.jpg"}}`
   as the `Src` value; the host bridge resolves that marker (recursively, in
   any service-call params) to `<volume>/apps/tunastreet.xviewer/cache/img_N.jpg`
   before the GUI service sees it (`system_core/src/runtime/host_bridge.cpp:43,
   434-470`, kind enum `AppCache|AppData|AppFiles|...` in
   `system_core/src/system/storage.cpp:403-429`).

**Caveat / fallback:** `SetViewSrc` is queued to the GUI input task; a
"success" result means accepted, not rendered — a decode/preload failure only
logs `Failed to set GUI image source` on serial (`gui.cpp:1226`). If that shows
up on hardware (e.g. JPEG decoder disabled in sdkconfig), the visible fallback
is already wired: the image slot stays hidden (`imgHidden` binding) and the
card renders text-only; nothing else breaks. A second-line fallback would be
re-encoding the backend images as LVGL `.bin`, which takes the same code path
without the decoder dependency.

## HTTP call shape used

```js
// submit (non-blocking):
brookesia.call_service_function("Http", "RequestAsync", JSON.stringify({
  Request: {
    url: "http://192.168.1.121:8091/xviewer/img/<id>.jpg",
    method: "Get",                 // enum: Get|Post|Put|Patch|Delete|Head
    timeout_ms: 10000,
    download_path: {"$brookesiaStoragePath":
                     {"kind": "AppCache", "relative_path": "img_0.jpg"}},
    max_file_size: 262144          // max_response_size for in-memory bodies
  }
}));  // -> {"success":true,"data":<request_id>}
```

The single parameter is named `Request` (`service_helper/network/http.hpp:126`,
field names from `hal_interface/.../http_client.hpp:75-102` via
`BROOKESIA_DESCRIBE_STRUCT`). Responses arrive as `Http` service events
`RequestCompleted|RequestFailed|RequestCanceled` with items
`{"RequestId": n, "Response": {status_code, headers, body, file_path, error,
error_message}}`, subscribed via `brookesia.subscribe_service_event` and
dispatched to `brookesia_app.on_event(service, event, items_json)`. Events are
service-global, so responses are matched by `RequestId` against the app's
pending map. If any event subscription fails at startup the app falls back to
the synchronous `Http.Request` (blocking; `call_service_function_async` is not
a workaround — Http functions are `require_scheduler=false`, so the async
bridge form still runs them inline, `service_manager/src/service/base.cpp:249`).

## Image cache strategy

At most **3 JPEGs** live in the app cache dir, under fixed rotating names
`img_0.jpg` / `img_1.jpg` / `img_2.jpg` (overwritten via `download_path`; no
delete API needed, though `Storage.FSRemove` exists if ever wanted).
`slotOwner[]` maps each slot to the post id whose bytes it holds, so
re-visiting a post reuses the file without a re-download. Two safety rules:

- a slot is never overwritten while the image view is displaying it
  (`pickSlot` skips `shownSlot`), avoiding stale-decode aliasing in the
  backend's path-keyed image cache;
- a download completion is dropped if the user has already navigated away
  (`navSeq` guard), but the slot ownership is still recorded for reuse.

Feed refresh runs every 60 s (`SystemTimer` periodic `xv_refresh`), errors
show "backend unreachable - retrying" on the status line and arm a 10 s
one-shot retry (`xv_retry`). Current position is always kept across
refreshes by post id.

### The CLEAR tool was removed (#218)

A fourth toolbar box, `t_clear`, used to sit at x=284 and emit
`xviewer.clear`. Two things were wrong with it and only one was fixable:

- Every panelkit tap target emits its action on **both** `pressed` and
  `released` (`uikit/panelkit.py`'s `_tap_events`, deliberate — pressed for
  feel, released as the catch-all). `doClear()`'s only guard was
  `feedInFlight`, which the second emit outran, so one tap ran **two** full
  feed refetches. Reproduced under `tools/simulator` on the fixture backend.
- The backend has no server-side "clear" at all — only `?refresh=1`, which
  returns the same 25 posts. So a tap's entire visible effect was
  `forceFirstOnFeed` snapping you back to card 1: *"clear button doesnt
  actually clear, gets stuck on first one."*

The 60 s periodic refresh already does the only real work the button did, so
the tool was deleted rather than relabelled, and its 84px went back to the
three tools that remain.

## Files

```
manifest.json                  id tunastreet.xviewer, runtime JavaScript
app/app.js                     all logic (plain global script, QuickJS)
res/profile.json               launcher icon id + main screen flow (AppDefault)
res/root.json                  asset list
res/flows/main.json            single-screen flow
res/screens/home.json          the card UI (GENERATED -- see gen_xviewer_screen.py
                                in DesktopShare files/xviewer/, do not hand-edit)
res/images/index.json          imageSet: launcher_icon, heart_on, heart_off
res/images/launcher_icon.png   92x92 black rounded square, white X, red heart
res/images/heart_on.png        28x28 filled #f91880 heart
res/images/heart_off.png       28x28 grey outline heart
```
