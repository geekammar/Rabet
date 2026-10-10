#!/usr/bin/env python3
"""Generate the Rabet PWA icon set from the existing brand mark.

No third-party dependencies: PNGs are written with the standard library only.

The brand mark (see src/components/brand/logo.tsx) is a rounded tile in the
`primary` token colour with the lucide `Link2` glyph in `primary-foreground`.
This script reproduces that mark at PWA sizes:

  public/icons/icon-192x192.png       — manifest "any" icon
  public/icons/icon-512x512.png       — manifest "any" icon
  public/icons/maskable-192x192.png   — manifest "maskable" icon
  public/icons/maskable-512x512.png   — manifest "maskable" icon
  public/icons/apple-touch-icon.png   — 180x180 Apple touch icon
  src/app/favicon.ico                 — 16/32/48 browser tab favicon

The glyph geometry is taken from the lucide Link2 path data (24x24 viewBox,
2px stroke, round caps/joins). It is symmetric about both centre axes, so only
one quadrant is sampled and mirrored, then box-downsampled (2x supersampling)
for anti-aliased edges.
"""

import math
import os
import struct
import zlib

VIEW_BOX = 24.0
STROKE = 2.0  # lucide default stroke width, in viewBox units

# Design tokens, duplicated from src/app/globals.css so the icons match the UI.
# primary = oklch(0.205 0 0), primary-foreground = oklch(0.985 0 0).


def oklch_to_srgb255(lightness: float, chroma: float, hue_deg: float) -> tuple[int, int, int]:
    """OKLCH -> sRGB, returned as 0-255 integers (the CSS colour-mapping path)."""
    h = math.radians(hue_deg)
    a = chroma * math.cos(h)
    b = chroma * math.sin(h)

    l = lightness + 0.3963377774 * a + 0.2158037573 * b
    m = lightness - 0.1055613458 * a - 0.0638541728 * b
    s = lightness - 0.0894841775 * a - 1.2914855480 * b

    l_, m_, s_ = l**3, m**3, s**3
    r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
    g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
    b_ = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_

    def to_srgb(x: float) -> float:
        x = max(0.0, min(1.0, x))
        return x / 12.92 if x <= 0.0031308 else 1.055 * x ** (1.0 / 2.4) - 0.055

    return (
        int(round(to_srgb(r) * 255)),
        int(round(to_srgb(g) * 255)),
        int(round(to_srgb(b_) * 255)),
    )


TILE = oklch_to_srgb255(0.205, 0.0, 0.0)      # primary
GLYPH = oklch_to_srgb255(0.985, 0.0, 0.0)     # primary-foreground

# lucide Link2 path primitives, in viewBox units (screen coordinates, y down):
#   M9 17H7A5 5 0 0 1 7 7h2      -> left arc (opens right)
#   M15 7h2a5 5 0 0 1 0 10h-2    -> right arc (opens left)
#   M8 12h8                       -> connector bar
# Straight segments:
SEGMENTS = (
    ((9.0, 17.0), (7.0, 17.0)),
    ((7.0, 7.0), (9.0, 7.0)),
    ((15.0, 7.0), (17.0, 7.0)),
    ((17.0, 17.0), (15.0, 17.0)),
    ((8.0, 12.0), (16.0, 12.0)),
)
# Circular arcs: (centre_x, centre_y, radius, angle_start, angle_end) in radians,
# screen-coordinate angles (atan2 of y-down offsets). Both arcs are semicircles.
ARCS = (
    (7.0, 12.0, 5.0, math.pi / 2, 3 * math.pi / 2),      # left arc
    (17.0, 12.0, 5.0, -math.pi / 2, math.pi / 2),        # right arc
)


def glyph_coverage(px: float, py: float, scale: float) -> float:
    """Anti-aliased stroke coverage in [0, 1] at viewBox point (px, py).
    `scale` converts viewBox units to pixels."""
    half_stroke = (STROKE / 2.0) * scale
    best = 1e9
    for (ax, ay), (bx, by) in SEGMENTS:
        bax, bay = bx - ax, by - ay
        pax, pay = px - ax, py - ay
        denom = bax * bax + bay * bay
        t = (pax * bax + pay * bay) / denom if denom else 0.0
        if t < 0.0:
            t = 0.0
        elif t > 1.0:
            t = 1.0
        dx = pax - bax * t
        dy = pay - bay * t
        d = math.sqrt(dx * dx + dy * dy)
        if d < best:
            best = d
    two_pi = 2.0 * math.pi
    for cx, cy, radius, a0, a1 in ARCS:
        ang = math.atan2(py - cy, px - cx)
        mid = (a0 + a1) / 2.0
        delta = (ang - mid + math.pi) % two_pi - math.pi
        ac = mid + delta
        if ac < a0:
            ac = a0
        elif ac > a1:
            ac = a1
        qx = cx + radius * math.cos(ac)
        qy = cy + radius * math.sin(ac)
        dx = px - qx
        dy = py - qy
        d = math.sqrt(dx * dx + dy * dy)
        if d < best:
            best = d
    coverage = half_stroke - best * scale + 0.5
    if coverage < 0.0:
        return 0.0
    if coverage > 1.0:
        return 1.0
    return coverage


def render_icon(size: int, glyph_fraction: float, supersample: int = 2) -> tuple[int, int, bytearray]:
    """Render the brand mark. glyph_fraction is the canvas width the glyph
    (including its stroke) occupies. Returns (width, height, RGBA bytes)."""
    m = size * supersample
    scale = glyph_fraction * m / 22.0  # glyph spans 22 of 24 viewBox units
    inv_scale = 1.0 / scale
    half_m = m / 2.0

    coverage = bytearray(m * m)

    # Sample one quadrant (x >= viewBox centre, y <= viewBox centre) and mirror.
    for y in range(m // 2):
        yv = (y + 0.5 - half_m) * inv_scale + 12.0
        row = y * m
        for x in range(m // 2, m):
            xv = (x + 0.5 - half_m) * inv_scale + 12.0
            cov = glyph_coverage(xv, yv, scale)
            ci = int(cov * 255.0 + 0.5)
            if ci > 255:
                ci = 255
            coverage[row + x] = ci

    for y in range(m // 2):
        row = y * m
        mirror_row = (m - 1 - y) * m
        for x in range(m // 2):
            c = coverage[row + m - 1 - x]
            coverage[row + x] = c
            coverage[mirror_row + x] = c
            coverage[mirror_row + m - 1 - x] = c

    pixels = bytearray(m * m * 4)
    tr, tg, tb = TILE
    gr, gg, gb = GLYPH
    for i in range(m * m):
        cov = coverage[i] / 255.0
        inv = 1.0 - cov
        o = i * 4
        pixels[o] = int(tr * inv + gr * cov + 0.5)
        pixels[o + 1] = int(tg * inv + gg * cov + 0.5)
        pixels[o + 2] = int(tb * inv + gb * cov + 0.5)
        pixels[o + 3] = 255

    if supersample == 1:
        return m, m, pixels

    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for sy in range(supersample):
                src_row = (y * supersample + sy) * m
                for sx in range(supersample):
                    i = (src_row + x * supersample + sx) * 4
                    r += pixels[i]
                    g += pixels[i + 1]
                    b += pixels[i + 2]
            n = supersample * supersample
            o = (y * size + x) * 4
            out[o] = (r + n // 2) // n
            out[o + 1] = (g + n // 2) // n
            out[o + 2] = (b + n // 2) // n
            out[o + 3] = 255
    return size, size, out


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def write_png(width: int, height: int, pixels: bytearray) -> bytes:
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (none)
        raw += pixels[y * stride : (y + 1) * stride]
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _png_chunk(b"IEND", b"")
    )


def write_ico(pngs: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(pngs))
    entries = b""
    offset = 6 + 16 * len(pngs)
    data = b""
    for size, png in pngs:
        entry_size = size if size < 256 else 0
        entries += struct.pack(
            "<BBBBHHII", entry_size, entry_size, 0, 0, 1, 32, len(png), offset
        )
        data += png
        offset += len(png)
    return header + entries + data


def main() -> None:
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons_dir = os.path.join(repo, "public", "icons")
    os.makedirs(icons_dir, exist_ok=True)

    # fraction of the canvas width the glyph occupies. 0.72 keeps the glyph
    # inside a circle mask for legacy Android icons; 0.66 keeps it inside the
    # 80% maskable safe zone (and inside the iOS squircle mask).
    outputs = (
        ("icon-192x192.png", 192, 0.72),
        ("icon-512x512.png", 512, 0.72),
        ("maskable-192x192.png", 192, 0.66),
        ("maskable-512x512.png", 512, 0.66),
        ("apple-touch-icon.png", 180, 0.66),
    )

    for name, size, fraction in outputs:
        _, _, pixels = render_icon(size, fraction)
        png = write_png(size, size, pixels)
        with open(os.path.join(icons_dir, name), "wb") as fh:
            fh.write(png)
        print(f"wrote public/icons/{name} ({size}x{size}, {len(png)} bytes)")

    ico_pngs = []
    for size in (16, 32, 48):
        _, _, pixels = render_icon(size, 0.72)
        ico_pngs.append((size, write_png(size, size, pixels)))
    favicon = os.path.join(repo, "src", "app", "favicon.ico")
    with open(favicon, "wb") as fh:
        fh.write(write_ico(ico_pngs))
    print(f"wrote src/app/favicon.ico (16/32/48, {os.path.getsize(favicon)} bytes)")


if __name__ == "__main__":
    main()
