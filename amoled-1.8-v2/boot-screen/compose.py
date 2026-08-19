#!/usr/bin/env python3
"""Compose the 368x448 AMOLED boot-screen background. v2: true black bg,
small crisp pixel-style blue text (no giant figlet blocks)."""
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage
import os

SRC = "/home/tunas/DesktopShare/images/mini tuna transparent.jpg"
OUTDIR = "/tmp/claude-1000/-home-tunas-DesktopShare/4c166096-396d-4ff0-9ad1-ec71f0650632/scratchpad/bootscreen"
CANVAS_W, CANVAS_H = 368, 448
BG_COLOR = (0, 0, 0)                # true black - pixels off on AMOLED
TEXT_BLUE = (74, 144, 217)          # #4A90D9 vivid readable blue
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

# ---------------------------------------------------------------------------
# 1. Load tuna asset and remove the baked-in checkerboard "transparent" bg
# ---------------------------------------------------------------------------
im = Image.open(SRC).convert("RGB")
arr = np.asarray(im).astype(np.int16)
r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]

# checkerboard cells are near-grayscale (R==G==B); JPEG blur widens the
# tolerance a bit AND, in concave notches between fin spikes, blurs whole
# checker cells all the way down through mid-greys before they'd ever hit
# a "light" threshold (observed brightness as low as ~30 in some pockets).
# So key on "grayscale and not literally the black outline" rather than
# "grayscale and light" -- the border-connected-component step below is
# what actually protects the fish's own light areas (belly white/cream,
# eye white): those aren't touching the image border, so they never join
# this mask's border-connected region regardless of how low the brightness
# floor is set.
is_grayish = (np.abs(r - g) < 12) & (np.abs(g - b) < 12) & (np.abs(r - b) < 12)
is_not_outline_black = (r > 25) & (g > 25) & (b > 25)
bg_mask = is_grayish & is_not_outline_black

labeled, n = ndimage.label(bg_mask, structure=np.ones((3, 3)))
h, w = bg_mask.shape
border_labels = set(labeled[0, :]) | set(labeled[-1, :]) | set(labeled[:, 0]) | set(labeled[:, -1])
border_labels.discard(0)
transparent_mask = np.isin(labeled, list(border_labels))
opaque_mask = ~transparent_mask

# A couple of checker cells sit in fully-enclosed pockets (concave notches
# in the silhouette, e.g. between fin spikes) where black outline surrounds
# them on every side -- no border flood-fill will ever reach them no matter
# how the threshold above is tuned, since they're topologically cut off
# from the rest of the checkerboard. A generic "small enclosed bg_mask blob
# -> background" pass is NOT safe here: the belly's own white fill is
# criss-crossed by thin dark separator/spine lines, chopping it into many
# small enclosed white sub-regions in the same size range as the stray
# checker pockets -- a size-only heuristic deletes real belly along with
# the noise (confirmed by testing, reverted). So the two confirmed pockets
# are patched by their exact enclosed-component label instead of a
# generic rule -- found by sampling a pixel inside each visible speck.
enclosed_labels = set(range(1, n + 1)) - border_labels
KNOWN_POCKET_SAMPLE_PX = [
    (450, 116),  # left-flank notch speck
    (627, 208),  # tail-base notch speck
]
for py, px in KNOWN_POCKET_SAMPLE_PX:
    lbl = labeled[py, px]
    if lbl != 0 and lbl in enclosed_labels:
        transparent_mask[labeled == lbl] = True
opaque_mask = ~transparent_mask

# --- clean up JPEG blend-noise fringe around the silhouette -----------------
# The checkerboard-key -> flood-fill above leaves a ring of grey/white
# partial-blend pixels right at the fish's black outline (JPEG compression
# smeared the checker pattern into the outline). Two passes fix it:
#
# 1. Erode the opaque mask a few px at source res. The outline is many px
#    thick so this eats the fringe ring without biting into the real
#    silhouette. NOTE: this also thins already-thin features (fin/tail
#    tips) -- keep iterations small and re-check those areas visually.
ERODE_ITERS = 2
eroded_mask = ndimage.binary_erosion(opaque_mask, iterations=ERODE_ITERS)

# drop orphan islands: some checker specks are joined to the fish body only
# by a hairline (1-2px) filament pre-erosion, so they survive as part of
# the single big component -- but the erosion above snaps that filament,
# leaving them as small disconnected floaters. Re-run the largest-component
# filter AFTER erosion so those floaters actually get dropped.
comp_labeled, comp_n = ndimage.label(eroded_mask, structure=np.ones((3, 3)))
if comp_n > 1:
    sizes = ndimage.sum(eroded_mask, comp_labeled, index=range(1, comp_n + 1))
    largest_label = int(np.argmax(sizes)) + 1
    eroded_mask = comp_labeled == largest_label

# 2. On the boundary band that's left (a few px ring just inside the new
#    edge), kill any pixel that's still grey/white-ish blend noise -- but
#    leave the fish's own cream/white highlights alone since those sit
#    well inside the outline, away from the edge band.
BAND_PX = 6
band_inner = ndimage.binary_erosion(eroded_mask, iterations=BAND_PX)
boundary_band = eroded_mask & ~band_inner

minc = np.minimum(np.minimum(r, g), b)
maxc = np.maximum(np.maximum(r, g), b)
# NOTE: the checker->outline JPEG ramp isn't just near-white; some pockets
# (e.g. checker cells inside a concave notch between fin spikes) blur all
# the way down through mid greys (observed as low as ~30-120 brightness)
# before hitting true black. Catch the whole low-saturation ramp but stop
# short of the real outline's near-black pixels (min < ~20) and its navy
# tint (much bigger max-min spread, already excluded by the sat check).
greyish_light = (minc > 20) & ((maxc - minc) < 45)

final_mask = eroded_mask & ~(boundary_band & greyish_light)

# 3. Snap whatever's left on the new boundary ring to the outline's own
#    dark color, so the silhouette edge reads as a clean uniform dark line
#    against black instead of a jagged mix of near-black shades.
snap_inner = ndimage.binary_erosion(final_mask, iterations=1)
snap_band = final_mask & ~snap_inner
src_rgb = np.asarray(im).copy()
src_rgb[snap_band] = (10, 10, 10)

alpha = np.where(final_mask, 255, 0).astype(np.uint8)
rgba = np.dstack([src_rgb, alpha])
tuna = Image.fromarray(rgba, mode="RGBA")

# soften the cut edge slightly so it isn't razor/aliased against the new bg
a_img = tuna.split()[3]
a_img = a_img.filter(ImageFilter.GaussianBlur(0.6))
tuna.putalpha(a_img)

# tight-crop to the fish's actual bounding box
bbox = tuna.getbbox()
tuna = tuna.crop(bbox)
print("cropped tuna size:", tuna.size)

# ---------------------------------------------------------------------------
# 2. Scale tuna to ~260px wide, NEAREST to keep pixel-art crispness
# ---------------------------------------------------------------------------
TARGET_W = 260
scale = TARGET_W / tuna.width
tuna_resized = tuna.resize((TARGET_W, round(tuna.height * scale)), Image.NEAREST)
print("resized tuna size:", tuna_resized.size)

# ---------------------------------------------------------------------------
# 3. Build canvas + paste tuna, upper-middle, centered horizontally
# ---------------------------------------------------------------------------
canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), BG_COLOR)

TOP_MARGIN = 14
tuna_x = (CANVAS_W - tuna_resized.width) // 2
tuna_y = TOP_MARGIN
canvas.paste(tuna_resized, (tuna_x, tuna_y), tuna_resized)
fish_bottom = tuna_y + tuna_resized.height
print("fish placed at", tuna_x, tuna_y, "bottom=", fish_bottom)

# ---------------------------------------------------------------------------
# 4. "tuna street" - small crisp pixel-style lettering.
#    Render at a small point size in grayscale (mode "L"), THRESHOLD to
#    pure on/off (kills antialiasing gray fringe -> clean pixel edges),
#    then NEAREST-upscale 3x for a chunky-but-clean retro look.
# ---------------------------------------------------------------------------
UPSCALE = 3
SMALL_PT = 13  # small pixel size per brief (~10-14px)
text_str = "tuna street"

small_font = ImageFont.truetype(FONT_PATH, SMALL_PT)
# measure at small size with generous padding
tmp = Image.new("L", (1, 1), 0)
tmp_draw = ImageDraw.Draw(tmp)
bbox_txt = tmp_draw.textbbox((0, 0), text_str, font=small_font)
pad = 2
small_w = (bbox_txt[2] - bbox_txt[0]) + pad * 2
small_h = (bbox_txt[3] - bbox_txt[1]) + pad * 2

small_img = Image.new("L", (small_w, small_h), 0)
small_draw = ImageDraw.Draw(small_img)
small_draw.text((pad - bbox_txt[0], pad - bbox_txt[1]), text_str, font=small_font, fill=255)

# threshold to pure black/white to remove antialiasing gray fringe
small_arr = np.asarray(small_img)
thresholded = np.where(small_arr > 90, 255, 0).astype(np.uint8)
small_img = Image.fromarray(thresholded, mode="L")

# NEAREST upscale to get chunky-but-clean pixels
big_img = small_img.resize((small_w * UPSCALE, small_h * UPSCALE), Image.NEAREST)

# colorize: blue text on transparent
text_rgba = Image.new("RGBA", big_img.size, (0, 0, 0, 0))
text_rgba.paste(TEXT_BLUE, (0, 0, big_img.width, big_img.height), big_img)

print("text bitmap size:", text_rgba.size)

avail_h = CANVAS_H - fish_bottom
text_x = (CANVAS_W - text_rgba.width) // 2
text_y = fish_bottom + max(10, (avail_h - text_rgba.height) // 2)
# clamp so it never clips off the bottom
text_y = min(text_y, CANVAS_H - text_rgba.height - 10)
canvas.paste(text_rgba, (text_x, text_y), text_rgba)
print("text placed at", text_x, text_y, "size", text_rgba.size)

# ---------------------------------------------------------------------------
# 5. Save outputs
# ---------------------------------------------------------------------------
assert canvas.size == (CANVAS_W, CANVAS_H)
canvas = canvas.convert("RGB")
out_path = os.path.join(OUTDIR, "background.png")
canvas.save(out_path, "PNG")

preview = canvas.resize((CANVAS_W * 2, CANVAS_H * 2), Image.NEAREST)
preview_path = os.path.join(OUTDIR, "preview_2x.png")
preview.save(preview_path, "PNG")

print("saved", out_path, canvas.size, canvas.mode)
print("saved", preview_path, preview.size, preview.mode)

# ---------------------------------------------------------------------------
# 6. edge_check.png: 3x NEAREST crop of just the fish region, for zoomed
#    inspection of the silhouette edge quality.
# ---------------------------------------------------------------------------
fish_bbox = (tuna_x, tuna_y, tuna_x + tuna_resized.width, tuna_y + tuna_resized.height)
fish_crop = canvas.crop(fish_bbox)
edge_check = fish_crop.resize((fish_crop.width * 3, fish_crop.height * 3), Image.NEAREST)
edge_check_path = os.path.join(OUTDIR, "edge_check.png")
edge_check.save(edge_check_path, "PNG")
print("saved", edge_check_path, edge_check.size, edge_check.mode)
