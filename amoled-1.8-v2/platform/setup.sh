#!/usr/bin/env bash
# Build the Tuna Street AMOLED platform image: ESP-Brookesia super system +
# MicroFi EFM agent + Tuna Street boot screen, for the Waveshare
# ESP32-S3-Touch-AMOLED-1.8 V2.
#
# Prereqs: ESP-IDF 6.0.x exported (idf.py on PATH), the MicroFi repo checked
# out (set MICROFI_ROOT if it is not at /mnt/c/Users/tunas/MicroFi), and WiFi
# credentials in sdkconfig.local next to this script.
set -euo pipefail
cd "$(dirname "$0")"

PIN=$(cat PINNED_UPSTREAM)
WORK=${BROOKESIA_DIR:-"$HOME/esp/esp-brookesia"}

if [ ! -d "$WORK" ]; then
    git clone https://github.com/espressif/esp-brookesia.git "$WORK"
    git -C "$WORK" checkout "$PIN"
else
    echo "Using existing clone at $WORK (expected upstream pin: $PIN)"
fi

# Apply our overlay: V2 board, microfi_agent component, main.cpp wiring,
# boot-screen resources.
cp -rv overlay/. "$WORK/"

SUPER="$WORK/examples/system/super"
cd "$SUPER"
idf.py set-target esp32s3

# The board's own defaults -- 16 MB flash and partitions_16m.csv, which is what
# creates the littlefs_data partition -- are injected into SDKCONFIG_DEFAULTS
# only when `sdkconfig` is ABSENT (esp_board_manager/idf_ext.py,
# board_manager_global_callback: "Inject board_manager.defaults into
# SDKCONFIG_DEFAULTS when sdkconfig is absent; otherwise warn-only consistency
# check"). set-target leaves a freshly-reset stock sdkconfig behind -- 2 MB,
# single-app table -- and bmgr then prints "Board unchanged, preserving
# sdkconfig" and applies nothing. The build gets the default partition table,
# which has no littlefs_data, and dies with "Failed to create littlefs image
# for partition 'littlefs_data'". Removing the file is what makes a
# from-scratch build come out the same as an incremental one (#216).
rm -f sdkconfig
idf.py bmgr -b esp32_s3_touch_amoled_1_8_v2
idf.py reconfigure

# Fail loudly rather than build an image with no storage partition: the
# symptom above is several hundred lines up from where the build stops.
if ! grep -q '^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions_16m.csv"' sdkconfig; then
    echo "ERROR: board defaults did not reach sdkconfig -- no littlefs_data partition." >&2
    grep -E '^CONFIG_(PARTITION_TABLE_CUSTOM_FILENAME|ESPTOOLPY_FLASHSIZE)=' sdkconfig >&2
    exit 1
fi

# Config: board defaults are in place above; append agent + platform settings,
# then local (gitignored) WiFi credentials.
cat "$OLDPWD/sdkconfig.microfi" >> sdkconfig
if [ -f "$OLDPWD/sdkconfig.local" ]; then
    cat "$OLDPWD/sdkconfig.local" >> sdkconfig
else
    echo "WARNING: no sdkconfig.local (WiFi creds) — device will not join a network" >&2
fi

# Runtime apps: the four tunastreet.* packages are staged into the build's
# littlefs tree by main/CMakeLists.txt (see the #216 block there), reading them
# straight out of this repo -- no separate staging tree to drift. -D puts the
# path in the CMake cache, so a later bare `idf.py build` still finds them.
APPS_DIR=$(cd "$OLDPWD/../apps" && pwd)
idf.py -DTUNASTREET_APPS_DIR="$APPS_DIR" build

echo
echo "Runtime apps in the generated image:"
ls -1 littlefs/apps

echo
echo "Flash from the build dir (Windows: python -m esptool --port COM8):"
echo "  python -m esptool --chip esp32s3 -b 460800 write-flash @flash_args"
