# Board profiles

One `main`, many branded boards. A **profile** captures everything that differs
between physical AMOLED-1.8-V2 boards so the shared platform files stay generic
and the per-board specifics live here as data. Selected at build time:

```bash
BOARD_PROFILE=cloudera ./setup.sh      # (default: tuna-street)
```

`setup.sh` copies the generic overlay into the Brookesia work tree, then
`apply_profile.py <name>` patches that work tree from `profiles/<name>/`:

| Profile field | Patches (in the work tree, not the repo) |
|---|---|
| `brand.desktopBg` | `resource/shell/styles/shell.json` → `shell.desktop.bgColor` (launcher home background). `null` resets to `${color.bg.base}`, the generic upstream default |
| `brand.statusBar` | `shell.json` → the top status-strip palette: `bgColor`/`borderColor` on `shell.statusBar`, `textColor` on `shell.statusBrand`+`shell.statusTiny`, `mutedTextColor` on `shell.statusTitle`+`shell.statusTinyMuted`. `null`/absent → all reset to the generic upstream `${color.*}` tokens (the light-on-neutral default) |
| `brand.splashBg` | `resource/startup/screens/startup.json` → `style.bgColor`, the frame colour behind the boot splash. `null` → `#000000` (generic black) |
| `brand.accent` | reserved for wordmark/accent styling (not yet wired) |
| `splash` | `resource/startup/images/background.png` (the file named here, from this profile dir; absent → the overlay's generic tuna splash is kept) |
| `launcher.*` | `resource/shell/constants/portrait.json` → the `launcher*` grid constants |
| `launcher.hideFiles` | generated `main/board_profile.cmake` → `BOARD_HIDE_FILES` **compile definition** (read by `shell_app_launcher.cpp`, which lives in another component and can't include `main/` — so it rides as a build-wide define, not a header macro) |
| `hasBattery` | generated `main/board_profile.cmake` → `BOARD_HAS_BATTERY` **compile definition** (#261): boards with a LiPo fitted read the AXP2101 and show the status-bar charge gauge (a pill at the **right** edge of the bar — the bar is WiFi · clock · battery, three spaceBetween groups); a USB-only board compiles it out and the clock stays centred |
| `hasAgent` | generated `main/board_profile.cmake` → `BOARD_HAS_AGENT` (#263). Default **true**. `false` = **no EFM agent on this board**: `components/microfi_agent` and `components/agent_status_tile` build as one-file stubs (no MicroFi sources, no flow engine / C2 client / processors, no PSRAM BSS, no native status tile) and `main.cpp` never starts the agent task — the board is a plain Brookesia panel. Meant for the battery boards that leave the LAN. Drop the `tunastreet.agent` tile from `apps` too, or it just shows SILENT. The C2 fields become don't-cares but are harmless |
| `apps` | `main/CMakeLists.txt` → `TUNASTREET_APP_PACKAGES` (which runtime tiles get staged) |
| `wifi.evictAp` | generated `main/board_profile.h` → `BOARD_WIFI_EVICT_AP` (read by `main.cpp`, same dir); the SSID to join stays in gitignored `sdkconfig.local` |
| `c2.baseUrl` | generated `examples/system/super/sdkconfig.profile` → `CONFIG_MICROFI_C2_HEARTBEAT_URL` / `_ACK_URL`; `setup.sh` cats it **after** `sdkconfig.microfi` so the board's URL wins. The agent reads these as Kconfig, not a macro |

Three generated artifacts, one per consumption mechanism: a **header** (`board_profile.h`, string macros for `main.cpp` which sits alongside it), a **CMake fragment** (`board_profile.cmake` — plain `set(BOARD_HIDE_FILES/BOARD_HAS_BATTERY/BOARD_HAS_AGENT 0|1)` variables; the project `CMakeLists.txt` includes it **before** `project()` so the agent components can read `BOARD_HAS_AGENT` while they register, then turns each variable into a build-wide compile definition for the C++ in components `main/` can't reach), and a **Kconfig fragment** (`sdkconfig.profile`, for the agent which reads `CONFIG_*`). All three are re-generated on every `apply_profile.py` run and are `.gitignore`-worthy build output, never committed.

**Where the apps come from.** The profile's `apps` ids are resolved by `main/CMakeLists.txt` across a list of app roots (`TUNASTREET_APPS_DIR`, `;`-separated): this repo's `apps/` (`tunastreet.hello`, `tunastarlink.*`) and the four per-app **leader** clones `~/amoled-{agent,racing,tminus,x-viewer}/apps/` — the `tunastreet.*` packages moved there 2026-08-27 (app + backend in one repo). `setup.sh` sets the list; override with `AMOLED_APP_ROOTS` if the clones live elsewhere. A missing package fails the configure loudly.

Design note: the base overlay files keep the generic (tuna-street) defaults; `apply_profile.py`
overwrites the profile-owned values on top, so the overlay's own values are the
default any board starts from. A board that needs a value the schema does
not yet cover is the signal to add a field here — never to hardcode it back into
a shared file (that is exactly the divergence #260 exists to end).

## Profiles

- **tuna-street** — the original board (WindowsDesktop / COM8). 2×2 launcher paged
  sideways (two pages — swipe over, swipe back; `shell_app_launcher.cpp` delta 4), all
  four `tunastreet.*` apps, Files hidden, ATT LAN, direct EFM C2, tuna splash.
- **tuna-starlink** — StarlinkAI board (#252 / PR #1). 2×2, `tunastarlink.*` apps,
  open STARLINK WiFi, StarlinkAI C2 relay, amber-on-black splash.
- **cloudera** — Cloudera-branded board (#258, COM10). 2×2, RACING, orange
  desktop, Cloudera-cloud splash, ATT LAN. Battery board, **no EFM agent**
  (`hasAgent: false`, #263).
