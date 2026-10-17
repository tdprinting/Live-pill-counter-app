"""Make ios/LivePillCounter/Assets.xcassets/AppIcon.appiconset/icon-1024.png (1024x1024, no alpha).
Run:  python tools/make_ios_icon.py      (standard library only; reuses the drawing code in make_icons.py)
It upscales the 512 px icon smoothly (bilinear)."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_icons  # noqa: E402


def upscale2(buf):
    n = len(buf)
    m = n * 2
    out = []
    for oy in range(m):
        fy = min(max((oy + 0.5) / 2 - 0.5, 0), n - 1)
        y0 = int(fy)
        y1 = min(y0 + 1, n - 1)
        ty = fy - y0
        row = []
        for ox in range(m):
            fx = min(max((ox + 0.5) / 2 - 0.5, 0), n - 1)
            x0 = int(fx)
            x1 = min(x0 + 1, n - 1)
            tx = fx - x0
            px = []
            for c in range(3):
                top = buf[y0][x0][c] * (1 - tx) + buf[y0][x1][c] * tx
                bot = buf[y1][x0][c] * (1 - tx) + buf[y1][x1][c] * tx
                px.append(top * (1 - ty) + bot * ty)
            row.append(px)
        out.append(row)
    return out


if __name__ == "__main__":
    dest = os.path.join(os.path.dirname(HERE), "ios", "LivePillCounter", "Assets.xcassets", "AppIcon.appiconset")
    os.makedirs(dest, exist_ok=True)
    make_icons.write_png(os.path.join(dest, "icon-1024.png"), upscale2(make_icons.render(512)))
    print("Wrote icon-1024.png in", dest)
