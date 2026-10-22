"""Draw the explorer's folder mark as a PNG (run once; the PNG is committed).

The detached window's taskbar entry used Electron's default icon, which is the
generic Electron atom. A window that belongs to the explorer should look like
the explorer, so the same folder glyph the footer button draws is rendered
here at 256 px and handed to BrowserWindow as `icon`.

Zero runtime dependencies: this script is not shipped, and the PNG is a static
asset. Run with the bundled Python:

    python tools/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256
SCALE = SIZE / 16  # the glyph is designed on the same 16x16 grid as the UI


def box(x0, y0, x1, y1):
    return [round(x0 * SCALE), round(y0 * SCALE), round(x1 * SCALE), round(y1 * SCALE)]


def main():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # The tab sits behind the body, the way the 16x16 outline reads: a folder
    # with a raised tab on its left, not a rectangle with a notch cut out.
    draw.rounded_rectangle(box(2, 3.2, 7.8, 7), radius=round(1.1 * SCALE), fill=(122, 169, 255, 255))
    draw.rounded_rectangle(box(2, 5.4, 14, 13), radius=round(1.6 * SCALE), fill=(79, 140, 255, 255))

    out = Path(__file__).resolve().parent.parent / "assets" / "icon.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
