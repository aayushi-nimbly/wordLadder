"""Draw the app icons (a small ladder of letter tiles) into src/wordladder/static/icons.

Usage:
    uv run python scripts/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src" / "wordladder" / "static" / "icons"
INK = (24, 33, 43)
TILE = (243, 245, 247)
P1 = (224, 103, 42)
P2 = (100, 125, 240)


def draw(size: int, maskable: bool = False, rounded: bool = True) -> Image.Image:
    img = Image.new("RGB", (size, size), INK)
    if rounded and not maskable:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(img).rounded_rectangle((0, 0, size - 1, size - 1), radius=size * 0.22, fill=INK)
    d = ImageDraw.Draw(img)
    # Content sits inside the safe zone (80%) for maskable icons.
    inset = size * (0.22 if maskable else 0.16)
    area = size - 2 * inset
    rows, cols = 4, 4
    gap = area * 0.06
    cell = (area - gap * (cols - 1)) / cols
    row_h = (area - gap * (rows - 1)) / rows
    # Which tile changes on each rung, and who changed it.
    changes = [None, (2, P1), (1, P2), (0, P1)]
    for r, change in enumerate(changes):
        for c in range(cols):
            x0 = inset + c * (cell + gap)
            y0 = inset + r * (row_h + gap)
            fill = TILE
            if change and change[0] == c:
                fill = change[1]
            if r == rows - 1:
                fill = change[1] if change and change[0] == c else (200, 208, 216)
            d.rounded_rectangle((x0, y0, x0 + cell, y0 + row_h), radius=cell * 0.18, fill=fill)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192).save(OUT / "icon-192.png")
    draw(512).save(OUT / "icon-512.png")
    draw(512, maskable=True).save(OUT / "icon-maskable-512.png")
    draw(180, rounded=False).save(OUT / "apple-touch-icon.png")  # iOS rounds it itself
    print("Icons written to", OUT)


if __name__ == "__main__":
    main()
