#!/usr/bin/env python3
"""Practice Machine 앱 아이콘 생성 (PIL) → assets/app.iconset → app.icns
사용: /usr/bin/python3 make_icon.py   (macOS 시스템 파이썬, Pillow 필요)
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, "assets")
SIZE = 1024
S = 2  # supersampling


def rounded_gradient_bg(w: int, radius: int) -> Image.Image:
    top = (34, 52, 102)     # #223466
    bottom = (12, 20, 40)   # #0C1428
    img = Image.new("RGBA", (w, w))
    dr = ImageDraw.Draw(img)
    for y in range(w):
        t = y / (w - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        dr.line([(0, y), (w, y)], fill=c)
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (w, w))
    out.paste(img, (0, 0), mask)
    return out


def main() -> None:
    w = SIZE * S
    img = rounded_gradient_bg(w, radius=232 * S)
    dr = ImageDraw.Draw(img)
    white = (245, 248, 255, 255)
    note_c = (127, 168, 255, 235)  # 옅은 블루 음표

    # --- 마이크 (캡슐 바디) ---
    dr.rounded_rectangle([392 * S, 240 * S, 632 * S, 512 * S], radius=120 * S, fill=white)
    # U 홀더 (라운드 캡: 끝단에 원형 캡 추가)
    arc_bbox = [322 * S, 300 * S, 702 * S, 592 * S]
    dr.arc(arc_bbox, start=0, end=180, fill=white, width=30 * S)
    cap_r = 15 * S
    for cx in (arc_bbox[0] + cap_r, arc_bbox[2] - cap_r):
        cy = (arc_bbox[1] + arc_bbox[3]) // 2
        dr.ellipse([cx - cap_r, cy - cap_r, cx + cap_r, cy + cap_r], fill=white)
    # 스템 (정중앙 x=512 정렬)
    dr.rounded_rectangle([497 * S, 592 * S, 527 * S, 690 * S], radius=10 * S, fill=white)
    # 베이스
    dr.rounded_rectangle([416 * S, 690 * S, 608 * S, 722 * S], radius=16 * S, fill=white)

    # --- 음표 악센트는 제거 (단일 글리프가 더 깔끔) ---

    img = img.resize((SIZE, SIZE), Image.LANCZOS)

    os.makedirs(ASSETS, exist_ok=True)
    png = os.path.join(ASSETS, "app_1024.png")
    img.save(png)

    # iconset → icns
    iconset = os.path.join(ASSETS, "app.iconset")
    os.makedirs(iconset, exist_ok=True)
    for sz in (16, 32, 64, 128, 256, 512, 1024):
        subprocess.run(
            ["sips", "-z", str(sz), str(sz), png, "--out", os.path.join(iconset, f"icon_{sz}x{sz}.png")],
            check=True,
            capture_output=True,
        )
        if sz <= 512:
            s2 = sz * 2
            subprocess.run(
                ["sips", "-z", str(s2), str(s2), png, "--out", os.path.join(iconset, f"icon_{sz}x{sz}@2x.png")],
                check=True,
                capture_output=True,
            )
    icns = os.path.join(ASSETS, "app.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns], check=True)
    print("OK:", icns)


if __name__ == "__main__":
    sys.exit(main())
