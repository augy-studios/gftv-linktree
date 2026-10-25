# OneLink GFTV app icon. Flat, in the GFTV icon family (gsl-*.png): a glyph
# over the multicolour GFTV wordmark in Arial Black, on the #fedc00 background.
#
# Everything is drawn on a transparent layer first, then scaled so every
# painted pixel sits inside a centred circle of 40% radius: the maskable icon
# safe zone. So the icon survives being cropped to a circle (Android, the
# manifest's "maskable" purpose, round avatars) with nothing cut off.
#
# Usage, from the project root: python tools/make-icons.py main-site
import math
import sys
from PIL import Image, ImageDraw, ImageFont

S = 1024
SAFE_RADIUS = 0.40 * S - 8   # a few pixels inside the safe circle
BG = '#fedc00'
INK = '#2e2800'        # hello-theme text colour, for outlines
CARD = '#ffffff'
BLUE = '#2cabe1'       # sister icon cloud blue
BLUE_LIGHT = '#e1f3fc'
GOLD = '#ffc00e'       # sister icon chain gold
GOLD_LIGHT = '#ffebb2'
WORD = ['#fd0000', '#ffda00', '#17ad1b', '#1a8cff']


def draw_artwork():
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = S // 2

    # The page card.
    d.rounded_rectangle((cx - 190, 120, cx + 190, 590), radius=56, fill=CARD, outline=BLUE, width=22)

    # Avatar dot and three link pills.
    d.ellipse((cx - 50, 172, cx + 50, 272), fill=BLUE)
    d.ellipse((cx - 26, 196, cx + 26, 248), fill=BLUE_LIGHT)
    for y in (310, 400, 490):
        d.rounded_rectangle((cx - 130, y, cx + 130, y + 62), radius=31, fill=BLUE_LIGHT, outline=BLUE, width=10)

    # Chain link badge over the bottom right corner of the card.
    bx, by = cx + 130, 560

    def link_ring(x0, y0, x1, y1):
        d.rounded_rectangle((x0 - 12, y0 - 12, x1 + 12, y1 + 12), radius=(y1 - y0 + 24) // 2, fill=CARD)
        d.rounded_rectangle((x0, y0, x1, y1), radius=(y1 - y0) // 2, fill=GOLD)
        pad = 22
        d.rounded_rectangle((x0 + pad, y0 + pad, x1 - pad, y1 - pad), radius=(y1 - y0 - 2 * pad) // 2, fill=GOLD_LIGHT)

    link_ring(bx - 150, by - 46, bx + 10, by + 46)
    link_ring(bx - 10, by - 46, bx + 150, by + 46)
    # Redraw the first ring's gold over the second's white halo, so the two
    # read as interlocked, then the bar that joins them.
    d.rounded_rectangle((bx - 150, by - 46, bx + 10, by + 46), radius=46, outline=GOLD, width=22)
    d.rounded_rectangle((bx - 70, by - 12, bx + 70, by + 12), radius=12, fill=GOLD)

    # Wordmark in Arial Black, each letter outlined so the yellow F reads on
    # the yellow ground.
    font = ImageFont.truetype('C:/Windows/Fonts/ariblk.ttf', 190)
    letters = 'GFTV'
    widths = [d.textlength(ch, font=font) for ch in letters]
    gap = 6
    x = cx - (sum(widths) + gap * 3) / 2
    for ch, w, colour in zip(letters, widths, WORD):
        d.text((x, 630), ch, font=font, fill=colour, stroke_width=9, stroke_fill=INK)
        x += w + gap
    return layer


def fit_to_circle(layer):
    """Scale and centre the artwork so its farthest painted pixel lies on
    SAFE_RADIUS from the middle of the icon."""
    box = layer.getbbox()
    art = layer.crop(box)
    w, h = art.size
    ox, oy = w / 2, h / 2
    alpha = art.getchannel('A').load()
    farthest = 0.0
    for y in range(h):
        for x in range(w):
            if alpha[x, y] > 8:
                farthest = max(farthest, math.hypot(x + 0.5 - ox, y + 0.5 - oy))
    scale = SAFE_RADIUS / farthest
    art = art.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    icon = Image.new('RGBA', (S, S), BG)
    icon.alpha_composite(art, ((S - art.width) // 2, (S - art.height) // 2))
    return icon, scale


def render(out_dir):
    icon, scale = fit_to_circle(draw_artwork())
    icon = icon.convert('RGB')
    icon.save(f'{out_dir}/OLG-main.png', optimize=True)
    icon.resize((512, 512), Image.LANCZOS).save(f'{out_dir}/OLG-512.png', optimize=True)
    icon.resize((192, 192), Image.LANCZOS).save(f'{out_dir}/OLG-192.png', optimize=True)
    icon.resize((180, 180), Image.LANCZOS).save(f'{out_dir}/OLG-180.png', optimize=True)
    icon.resize((256, 256), Image.LANCZOS).save(f'{out_dir}/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print(f'artwork scaled by {scale:.3f} to fit the safe circle')


render(sys.argv[1] if len(sys.argv) > 1 else 'main-site')
