# tools — Windows-side flash + serial for the AMOLED 1.8 V2 (COM8)

## Before any flash: run it in the simulator first

`simulator/` (#212) runs a runtime app's real `app/app.js` + screen off-device
at true 368x448 -- headless (scoreable) or in a browser (watchable) -- and
`simulator/lint.js --check <app-id>` is the pre-flash structural/reachability
check (thresholds from `uikit/tokens.json`). See `simulator/README.md`.
Building the harness and driving it yourself catches a UI bug in seconds
that would otherwise cost a flash cycle to notice.

The board's USB-Serial/JTAG console only yields bytes to a host that already
holds the port open across a reset — so **capture is always chained to a
reset**. Toggling RTS alone from a fresh open reads 0 bytes and does NOT
reset the chip; the scripts below drive RTS→EN correctly (DTR held low keeps
IO0 high → normal boot, not download mode).

Run these from Windows (`python` = Windows Python with `pyserial` +
`esptool`), working dir `C:\temp\amoled-super` by convention. WSL builds,
Windows flashes.

| Script | What |
|---|---|
| `bootlog.py [PORT] [SECS]` | reset + capture boot serial (default COM8, 30 s; use 120 s to see WiFi + agent + app start) |
| `readlog.py [PORT] [SECS]` | capture **without** reset (default COM8, 90 s; often 0 bytes on a fresh attach — use bootlog.py) |

Default port `COM8` is the board on **WindowsDesktop**; on **StarlinkAI** it
enumerates as `COM6`. Re-identify by MAC `1c:db:d4:7b:85:84` after a replug:
`python -m serial.tools.list_ports -v` (reads SER= without resetting;
`esptool flash-id` DOES reset).

## Flash recipes

Build in WSL (`examples/system/super`), copy segments to
`C:\temp\amoled-super`, flash from Windows:

```bat
:: full platform image (bootloader + partition table + srmodels + app + storage)
python -m esptool --chip esp32s3 --port COM8 -b 460800 write-flash ^
  0x0 bootloader.bin 0x8000 partition-table.bin 0x10000 srmodels.bin ^
  0x60000 example_system_super.bin 0xaa1000 littlefs_data.bin

:: runtime apps only -- littlefs_data partition, platform + agent untouched
python -m esptool --chip esp32s3 --port COM8 -b 460800 write-flash 0xaa1000 littlefs_data.bin
```

Offsets come from `partitions_16m.csv` (littlefs_data = 5000K @ `0xaa1000`).
Ask before every flash — the board hard-resets after and the EFM agent drops
for ~15 s.

**Anything not in `examples/system/super/littlefs/apps/` vanishes on a storage
flash**, and that tree is rebuilt by the build itself. `platform/setup.sh`
stages all four `tunastreet.*` packages straight out of `../apps/` through
upstream's `brookesia_stage_runtime_app_package` hook (#216), so a clean build
produces a complete image. Do **not** hand-copy an app into that tree instead:
the upstream hook wipes the whole apps stage root once per CMake configure and
then re-copies only the registered packages, so a hand-placed app survives
exactly until the next configure and then silently disappears — which is how
the board once ended up running a build older than the repo. To add a fifth
app, add its id to `TUNASTREET_APP_PACKAGES` in
`platform/overlay/examples/system/super/main/CMakeLists.txt`.

Recovery image: `ESP32-S3-Touch-AMOLED-1.8-V2-FactoryXiaozhi_260601.bin`
(16 MB whole-flash write at `0x0`).

## Iterating runtime apps WITHOUT ESP-IDF

Runtime apps are plain files on the `littlefs_data` partition — changing one
never requires rebuilding the platform image. On a host with no IDF (e.g.
StarlinkAI), take the current `littlefs_data.bin` as the base and edit it
with `littlefs-python` (`pip install littlefs-python`; geometry: block_size
4096, block_count 1250 → 5,120,000 bytes):

```python
from littlefs import LittleFS
fs = LittleFS(block_size=4096, block_count=1250, mount=False)
fs.context.buffer = bytearray(open("littlefs_data.bin", "rb").read())
fs.mount()
# read/replace files under /apps/<id>/..., e.g.:
with open("app.js", "rb") as f:
    data = f.read()
fs.remove("/apps/tunastreet.ember/app/app.js")
with fs.open("/apps/tunastreet.ember/app/app.js", "wb") as fh:
    fh.write(data)
fs.unmount()
open("littlefs_data.bin", "wb").write(bytes(fs.context.buffer))
```

Then flash the partition (`write-flash 0xaa1000 littlefs_data.bin`) and the
board scans `apps/` again on the post-flash reset. Everything already in the
image (system apps included) survives — only edit what you mean to change.
