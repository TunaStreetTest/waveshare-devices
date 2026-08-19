# waveshare-devices

Tuna Street's platform work on Waveshare ESP32 devices. One directory per SKU;
first up is the 1.8″ AMOLED.

## amoled-1.8-v2 — Waveshare ESP32-S3-Touch-AMOLED-1.8 V2

CO5300 368×448 QSPI AMOLED, CST820 touch, TCA9554 IO expander, AXP2101 PMIC,
QMI8658 IMU, ES8311 audio, 16 MB flash / 8 MB octal PSRAM.

The device runs one platform image — [ESP-Brookesia](https://github.com/espressif/esp-brookesia)
v0.8 (super system: launcher, status bar, App Store, JS runtime) — flashed once.
Everything else arrives without reflashing:

- **Apps are files.** Runtime app packages (`manifest.json` + JS entry +
  JSON-UI resources) dropped into `apps/` on LittleFS or SD install at boot —
  a new tile appears on the launcher. `apps/tunastreet.hello/` here is, as far
  as we know, the first runtime package built for Brookesia v0.8 outside
  Espressif — upstream ships the runtime but no example package.
- **The device is a fleet citizen.** A [MicroFi](https://github.com/) EFM/MiNiFi
  C2 agent runs inside the platform image as a native background component:
  it adopts Brookesia's WiFi, heartbeats to Cloudera Edge Flow Manager, and
  receives flow definitions over C2 — while the launcher keeps running.

### Layout

| Path | What |
|---|---|
| `platform/overlay/` | Our delta over the pinned esp-brookesia master: the **V2 HAL board** (`esp32_s3_touch_amoled_1_8_v2` — upstream only has the V1 SH8601/FT3168 board), the `microfi_agent` guest component, super-example wiring (WiFi pre-provision + agent task), and the Tuna Street boot screen resources |
| `platform/setup.sh` | Clone upstream at `PINNED_UPSTREAM`, apply overlay, select board, build |
| `platform/sdkconfig.microfi` | Agent + platform config (WiFi creds live in gitignored `sdkconfig.local`) |
| `bringup/amoled-colorbar/` | Minimal display bring-up: `esp_lcd_co5300` + `draw_bitmap` only. **Flash this first on a new board** — solid color on the glass before any LVGL/launcher work |
| `apps/tunastreet.hello/` | The runtime app package template (JS, `systems=["super"]`) |
| `boot-screen/compose.py` | Generates the 368×448 boot splash (pixel tuna on black) |

### Hard-won facts

- The CO5300 is **QSPI** — the RGB/vsync LVGL path gives a permanently black
  panel. Prove the display with `bringup/amoled-colorbar` before anything else.
- Panel init order: AXP2101 rails → TCA9554 reset pulse → panel. QSPI pins
  CS=12, PCLK=11, D0–3=4/5/6/7, X-offset 16. Touch is CST820 via the
  `esp_lcd_touch_cst816s` driver at 0x15, INT=13, RST=39.
- Brookesia master needs **ESP-IDF 6.0–6.2** on the S3 (IDF 6 no longer
  bundles cmake/ninja — `pip install cmake ninja` into the IDF venv works).
- A guest component's static BSS competes with the display's internal-DMA
  buffers — `microfi_agent`'s 79.6 KB BSS goes to PSRAM via a linker fragment
  (`extram_bss`), leaving 262 B internal.
- The example's `littlefs/` tree is a **staged output**: boot-screen edits go
  in `system/brookesia_system_super/resource/startup/` or the build silently
  reverts them. The startup screen's stock background is near-white, and a
  full-size 368×448 splash needs `CONFIG_LV_CACHE_DEF_SIZE` ≥ ~660 KB or it
  silently doesn't render.
- Programmatic WiFi provisioning: `SetConnectAp` alone stores the target;
  `GeneralAction::Connect` is what joins (`Start` is ignored once the service
  is already Started).

Built on the desk at Tuna Street. The V2 HAL board is a candidate for an
upstream esp-brookesia PR.
