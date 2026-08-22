#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Steven Matison
#
# SPDX-License-Identifier: Apache-2.0
"""Stage runtime app packages into a littlefs_data.bin image, off-device.

The board scans /apps on every post-flash reset, and a storage flash replaces
the whole partition -- so anything not present in the image vanishes from the
launcher. This script edits an existing image in place with littlefs-python
rather than rebuilding it, which means the three brookesia.general.* system
apps (whose sources are not ours) survive untouched.

    python3 stage_apps.py <image.bin> tunastreet.racing tunastreet.agent ...
    python3 stage_apps.py <image.bin> --shell            # shell overlay only
    python3 stage_apps.py <image.bin> --shell tunastreet.agent

Each named app is mirrored from ../apps/<id>/ into /apps/<id>/ in the image:
the app's tree in the image is removed first, so a file deleted locally is
also gone on the board. README.md is skipped -- it is documentation, and the
partition is 5 MB.

--shell additionally copies platform/overlay/system/brookesia_system_super/
resource/shell/ over /system/super/shell/ in the image. The Brookesia shell --
its constants, screens, styles and templates -- is data on this same partition,
NOT compiled into the firmware, so a shell fix (the status-bar type scale, the
launcher tile template) ships by patching this image, with no ESP-IDF rebuild
and no platform flash. Only the files present in the overlay are replaced;
everything else in the shell tree is left alone.

Prints a before/after inventory and the free space left, because running out
of littlefs space fails in ways that look like an app bug on the glass.
"""
import os
import sys

from littlefs import LittleFS

BLOCK_SIZE = 4096
BLOCK_COUNT = 1250          # 5,120,000 bytes, from partitions_16m.csv
APPS_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps")
SHELL_OVERLAY = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "platform", "overlay",
    "system", "brookesia_system_super", "resource", "shell")
SHELL_DEST = "/system/super/shell"
SKIP_NAMES = {"README.md", ".DS_Store"}


def is_dir(fs, path):
    try:
        return fs.stat(path).type == 2
    except Exception:
        return False


def rmtree(fs, path):
    if not is_dir(fs, path):
        try:
            fs.remove(path)
        except Exception:
            pass
        return
    for name in fs.listdir(path):
        rmtree(fs, path.rstrip("/") + "/" + name)
    fs.remove(path)


def mkdirs(fs, path):
    parts = [p for p in path.strip("/").split("/") if p]
    cur = ""
    for p in parts:
        cur += "/" + p
        if not is_dir(fs, cur):
            fs.mkdir(cur)


def copy_tree(fs, local_dir, dest_dir):
    """Mirror local_dir into dest_dir. Returns (files, bytes)."""
    files = bytes_written = 0
    mkdirs(fs, dest_dir)
    for entry in sorted(os.listdir(local_dir)):
        if entry in SKIP_NAMES:
            continue
        local = os.path.join(local_dir, entry)
        dest = dest_dir.rstrip("/") + "/" + entry
        if os.path.isdir(local):
            f, b = copy_tree(fs, local, dest)
            files += f
            bytes_written += b
        else:
            with open(local, "rb") as fh:
                data = fh.read()
            with fs.open(dest, "wb") as out:
                out.write(data)
            files += 1
            bytes_written += len(data)
    return files, bytes_written


def inventory(fs):
    out = []
    for name in sorted(fs.listdir("/apps")):
        total = 0
        stack = ["/apps/" + name]
        while stack:
            p = stack.pop()
            if is_dir(fs, p):
                stack.extend(p.rstrip("/") + "/" + c for c in fs.listdir(p))
            else:
                total += fs.stat(p).size
        out.append((name, total))
    return out


def free_bytes(fs):
    # used_block_count is a property on littlefs-python 0.19, not a method
    used = fs.used_block_count
    if callable(used):
        used = used()
    return (BLOCK_COUNT - used) * BLOCK_SIZE


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    image = sys.argv[1]
    rest = sys.argv[2:]
    do_shell = "--shell" in rest
    apps = [a for a in rest if a != "--shell"]
    if not apps and not do_shell:
        print(__doc__)
        return 2

    fs = LittleFS(block_size=BLOCK_SIZE, block_count=BLOCK_COUNT, mount=False)
    with open(image, "rb") as fh:
        fs.context.buffer = bytearray(fh.read())
    fs.mount()

    print("before:")
    for name, size in inventory(fs):
        print("  %-34s %8d B" % (name, size))
    print("  free: %d B\n" % free_bytes(fs))

    for app_id in apps:
        local = os.path.abspath(os.path.join(APPS_ROOT, app_id))
        if not os.path.isdir(local):
            print("!! no such package:", local)
            return 1
        dest = "/apps/" + app_id
        rmtree(fs, dest)
        files, size = copy_tree(fs, local, dest)
        print("staged %-34s %3d files  %7d B" % (app_id, files, size))

    if do_shell:
        local = os.path.abspath(SHELL_OVERLAY)
        if not os.path.isdir(local):
            print("!! no shell overlay at", local)
            return 1
        # Deliberately NOT rmtree'd: the overlay carries only the files we
        # override, and the rest of the shell tree must survive.
        files, size = copy_tree(fs, local, SHELL_DEST)
        print("staged %-34s %3d files  %7d B" % ("shell overlay", files, size))

    print("\nafter:")
    for name, size in inventory(fs):
        print("  %-34s %8d B" % (name, size))
    free = free_bytes(fs)
    print("  free: %d B" % free)

    fs.unmount()
    with open(image, "wb") as fh:
        fh.write(bytes(fs.context.buffer))
    print("\nwrote", image, os.path.getsize(image), "bytes")
    if free < 200 * 1024:
        print("WARNING: under 200 KB free -- littlefs gets unreliable when full")
    return 0


if __name__ == "__main__":
    sys.exit(main())
