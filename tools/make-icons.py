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

SIZE = 1024
SAFE_RADIUS = 0.40 * SIZE - 8   # a few pixels inside the safe circle
BACKGROUND = '#fedc00'
INK = '#2e2800'        # hello-theme text colour, for outlines
CARD = '#ffffff'
BLUE = '#2cabe1'       # sister icon cloud blue
BLUE_LIGHT = '#e1f3fc'
GOLD = '#ffc00e'       # sister icon chain gold
GOLD_LIGHT = '#ffebb2'
WORD_COLOURS = ['#fd0000', '#ffda00', '#17ad1b', '#1a8cff']


# The whole artwork at full size on a transparent layer: the page card with
# its avatar and link pills, the chain link badge, and the GFTV wordmark.
def draw_artwork():
    layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    centre_x = SIZE // 2

    # The page card.
    draw.rounded_rectangle((centre_x - 190, 120, centre_x + 190, 590), radius=56, fill=CARD, outline=BLUE, width=22)

    # Avatar dot and three link pills.
    draw.ellipse((centre_x - 50, 172, centre_x + 50, 272), fill=BLUE)
    draw.ellipse((centre_x - 26, 196, centre_x + 26, 248), fill=BLUE_LIGHT)
    for pill_top in (310, 400, 490):
        draw.rounded_rectangle((centre_x - 130, pill_top, centre_x + 130, pill_top + 62), radius=31, fill=BLUE_LIGHT, outline=BLUE, width=10)

    # Chain link badge over the bottom right corner of the card.
    badge_x, badge_y = centre_x + 130, 560

    # One link of the chain: a white halo, the gold ring, and its pale inside.
    def link_ring(left, top, right, bottom):
        draw.rounded_rectangle((left - 12, top - 12, right + 12, bottom + 12), radius=(bottom - top + 24) // 2, fill=CARD)
        draw.rounded_rectangle((left, top, right, bottom), radius=(bottom - top) // 2, fill=GOLD)
        padding = 22
        draw.rounded_rectangle((left + padding, top + padding, right - padding, bottom - padding), radius=(bottom - top - 2 * padding) // 2, fill=GOLD_LIGHT)

    link_ring(badge_x - 150, badge_y - 46, badge_x + 10, badge_y + 46)
    link_ring(badge_x - 10, badge_y - 46, badge_x + 150, badge_y + 46)
    # Redraw the first ring's gold over the second's white halo, so the two
    # read as interlocked, then the bar that joins them.
    draw.rounded_rectangle((badge_x - 150, badge_y - 46, badge_x + 10, badge_y + 46), radius=46, outline=GOLD, width=22)
    draw.rounded_rectangle((badge_x - 70, badge_y - 12, badge_x + 70, badge_y + 12), radius=12, fill=GOLD)

    # Wordmark in Arial Black, each letter outlined so the yellow F reads on
    # the yellow ground.
    font = ImageFont.truetype('C:/Windows/Fonts/ariblk.ttf', 190)
    letters = 'GFTV'
    widths = [draw.textlength(letter, font=font) for letter in letters]
    gap = 6
    letter_x = centre_x - (sum(widths) + gap * 3) / 2
    for letter, width, colour in zip(letters, widths, WORD_COLOURS):
        draw.text((letter_x, 630), letter, font=font, fill=colour, stroke_width=9, stroke_fill=INK)
        letter_x += width + gap
    return layer


def fit_to_circle(layer):
    """Scale and centre the artwork so its farthest painted pixel lies on
    SAFE_RADIUS from the middle of the icon."""
    box = layer.getbbox()
    artwork = layer.crop(box)
    width, height = artwork.size
    centre_x, centre_y = width / 2, height / 2
    alpha = artwork.getchannel('A').load()
    farthest = 0.0
    for pixel_y in range(height):
        for pixel_x in range(width):
            if alpha[pixel_x, pixel_y] > 8:
                farthest = max(farthest, math.hypot(pixel_x + 0.5 - centre_x, pixel_y + 0.5 - centre_y))
    scale = SAFE_RADIUS / farthest
    artwork = artwork.resize((round(width * scale), round(height * scale)), Image.LANCZOS)
    icon = Image.new('RGBA', (SIZE, SIZE), BACKGROUND)
    icon.alpha_composite(artwork, ((SIZE - artwork.width) // 2, (SIZE - artwork.height) // 2))
    return icon, scale


def render(output_directory):
    icon, scale = fit_to_circle(draw_artwork())
    icon = icon.convert('RGB')
    icon.save(f'{output_directory}/OLG-main.png', optimize=True)
    icon.resize((512, 512), Image.LANCZOS).save(f'{output_directory}/OLG-512.png', optimize=True)
    icon.resize((192, 192), Image.LANCZOS).save(f'{output_directory}/OLG-192.png', optimize=True)
    icon.resize((180, 180), Image.LANCZOS).save(f'{output_directory}/OLG-180.png', optimize=True)
    icon.resize((256, 256), Image.LANCZOS).save(f'{output_directory}/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print(f'artwork scaled by {scale:.3f} to fit the safe circle')


# The folder to write into: the first argument, or main-site.
if len(sys.argv) > 1:
    site_directory = sys.argv[1]
else:
    site_directory = 'main-site'
render(site_directory)
