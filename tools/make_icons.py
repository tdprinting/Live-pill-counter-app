"""Draw the Live Pill Counter icon (assets/icon.svg + PNGs) with plain Python, no Pillow needed.

Run:  python tools/make_icons.py
The PNG/SVG results are committed in assets/, so the normal build never needs to run this.
Everything is drawn from the SHAPES list below (512 x 512 units); the same list makes the SVG and the PNGs.
"""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets")

BG, TRAY, TRAY_EDGE = "#0a111c", "#112038", "#22d3ee"
TEAL, WHITE, SHADE = "#22d3ee", "#e8f0f7", "#9db2c6"

# ("rrect", x, y, w, h, r, color) | ("circle", cx, cy, r, color) | ("capsule", cx, cy, length, width, angle_deg, color)
SHAPES = [
    ("rrect", 0, 0, 512, 512, 0, BG),                      # full-bleed tile (iOS rounds the corners itself)
    ("rrect", 52, 104, 408, 356, 48, TRAY_EDGE),           # counting tray: teal rim ...
    ("rrect", 60, 112, 392, 340, 40, TRAY),                # ... and dark floor
    ("circle", 176, 236, 62, WHITE),                       # tablet
    ("capsule", 176, 236, 76, 8, 20, SHADE),               #   score line
    ("circle", 196, 372, 50, SHADE),                       # second tablet (shaded)
    ("circle", 190, 366, 40, WHITE),
    ("capsule", 338, 322, 190, 82, -32, TEAL),             # capsule (the one teal accent)
    ("capsule", 322, 296, 80, 14, -32, "#a5f3fc"),         #   highlight
    ("circle", 392, 128, 78, BG),                          # count badge: cut-out ring ...
    ("circle", 392, 128, 66, TEAL),                        # ... teal disc ...
    ("circle", 364, 128, 11, BG),                          # ... with three dots = "3"
    ("circle", 392, 128, 11, BG),
    ("circle", 420, 128, 11, BG),
]


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def inside(shape, x, y):
    k = shape[0]
    if k == "rrect":
        _, rx, ry, w, h, r, _c = shape
        qx = abs(x - (rx + w / 2)) - (w / 2 - r)
        qy = abs(y - (ry + h / 2)) - (h / 2 - r)
        return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) <= r
    if k == "circle":
        _, cx, cy, r, _c = shape
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    _, cx, cy, ln, wd, ang, _c = shape  # capsule: a thick line segment with round ends
    a = math.radians(ang)
    dx, dy = x - cx, y - cy
    u = dx * math.cos(a) + dy * math.sin(a)
    v = -dx * math.sin(a) + dy * math.cos(a)
    half = ln / 2 - wd / 2
    return math.hypot(max(abs(u) - half, 0), v) <= wd / 2


def bbox(shape):
    k = shape[0]
    if k == "rrect":
        return shape[1], shape[2], shape[1] + shape[3], shape[2] + shape[4]
    if k == "circle":
        return shape[1] - shape[3], shape[2] - shape[3], shape[1] + shape[3], shape[2] + shape[3]
    r = shape[3] / 2 + 2
    return shape[1] - r, shape[2] - r, shape[1] + r, shape[2] + r


def render(size=512, ss=4):
    buf = [[list(hex_rgb(BG)) for _ in range(size)] for _ in range(size)]
    for s in SHAPES:
        col = hex_rgb(s[-1])
        x0, y0, x1, y1 = bbox(s)
        for py in range(max(int(y0) - 1, 0), min(int(y1) + 2, size)):
            row = buf[py]
            for px in range(max(int(x0) - 1, 0), min(int(x1) + 2, size)):
                hit = 0
                for j in range(ss):
                    for i in range(ss):
                        if inside(s, px + (i + .5) / ss, py + (j + .5) / ss):
                            hit += 1
                if hit:
                    a = hit / (ss * ss)
                    p = row[px]
                    for c in range(3):
                        p[c] = p[c] * (1 - a) + col[c] * a
    return buf


def downscale(buf, size):
    n = len(buf)
    out = []
    for oy in range(size):
        row = []
        ya, yb = oy * n / size, (oy + 1) * n / size
        for ox in range(size):
            xa, xb = ox * n / size, (ox + 1) * n / size
            acc, wsum = [0.0, 0.0, 0.0], 0.0
            y = int(ya)
            while y < yb:
                wy = min(y + 1, yb) - max(y, ya)
                x = int(xa)
                while x < xb:
                    w = wy * (min(x + 1, xb) - max(x, xa))
                    px = buf[min(y, n - 1)][min(x, n - 1)]
                    for c in range(3):
                        acc[c] += px[c] * w
                    wsum += w
                    x += 1
                y += 1
            row.append([v / wsum for v in acc])
        out.append(row)
    return out


def write_png(path, buf):
    h, w = len(buf), len(buf[0])
    raw = b"".join(b"\x00" + bytes(min(255, max(0, round(v))) for p in row for v in p) for row in buf)

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def svg():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">']
    for s in SHAPES:
        c = s[-1]
        if s[0] == "rrect":
            out.append(f'<rect x="{s[1]}" y="{s[2]}" width="{s[3]}" height="{s[4]}" rx="{s[5]}" fill="{c}"/>')
        elif s[0] == "circle":
            out.append(f'<circle cx="{s[1]}" cy="{s[2]}" r="{s[3]}" fill="{c}"/>')
        else:
            _, cx, cy, ln, wd, ang, _ = s
            out.append(f'<rect x="{cx - ln / 2}" y="{cy - wd / 2}" width="{ln}" height="{wd}" rx="{wd / 2}" '
                       f'fill="{c}" transform="rotate({ang} {cx} {cy})"/>')
    out.append("</svg>")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    big = render(512)
    write_png(os.path.join(OUT, "icon-512.png"), big)
    write_png(os.path.join(OUT, "icon-192.png"), downscale(big, 192))
    write_png(os.path.join(OUT, "apple-touch-icon.png"), downscale(big, 180))
    open(os.path.join(OUT, "icon.svg"), "w", encoding="utf-8").write(svg())
    print("Wrote icon.svg, icon-512.png, icon-192.png, apple-touch-icon.png in", OUT)
