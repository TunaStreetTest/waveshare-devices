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
idf.py bmgr -b esp32_s3_touch_amoled_1_8_v2

# Config: board defaults come from bmgr; append agent + platform settings,
# then local (gitignored) WiFi credentials.
cat "$OLDPWD/sdkconfig.microfi" >> sdkconfig
if [ -f "$OLDPWD/sdkconfig.local" ]; then
    cat "$OLDPWD/sdkconfig.local" >> sdkconfig
else
    echo "WARNING: no sdkconfig.local (WiFi creds) — device will not join a network" >&2
fi

idf.py build
echo
echo "Flash from the build dir (Windows: python -m esptool --port COM8):"
echo "  python -m esptool --chip esp32s3 -b 460800 write-flash @flash_args"
