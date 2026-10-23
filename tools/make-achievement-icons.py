# Generates Steam achievement icons (64x64: unlocked + locked) as mahjong tiles.
#   python tools/make-achievement-icons.py   ->  steam/achievements/*.jpg
# Needs Pillow and the Noto CJK fonts (Debian/Ubuntu: fonts-noto-cjk).
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

OUT = os.path.join(os.path.dirname(__file__), '..', 'steam', 'achievements')   # upload these to Steamworks
GAME = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'ach')      # shown in-game (128px)
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_SYMBOLS = '/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf'
FONT_CJK = ('/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', 3)  # Noto Serif CJK TC Bold

INK = {  # face ink color per tier
    'red': (184, 22, 31), 'green': (19, 112, 70), 'blue': (31, 79, 168), 'gold': (150, 100, 20),
}
ICONS = [
    ('FIRST_HAND', '東', 'blue'), ('FIRST_WIN', '和', 'red'), ('SELF_DRAWN', '摸', 'green'), ('CONCEALED_WIN', '門', 'green'),
    ('KONG_WIN', '槓', 'green'), ('ROB_KONG', '搶', 'blue'), ('ALL_PUNGS', '對', 'green'), ('MIXED_SUIT', '混', 'green'),
    ('PURE_SUIT', '清', 'blue'), ('DRAGONS', '龍', 'red'), ('LIMIT_HAND', '滿', 'gold'), ('THIRTEEN_ORPHANS', '13', 'gold'),
    ('HEAVENLY', '天', 'gold'), ('GAME_WIN', '#1', 'red'), ('HARD_WIN', '★', 'gold'), ('FRIENDLY_GAME', '♥', 'red'),
    ('SAY_CHEESE', '◉', 'blue'), ('HANDS_100', '100', 'blue'), ('WINS_50', '50', 'green'), ('HANDS_1000', '1K', 'gold'),
]

def font(text, size):
    if any(ord(ch) >= 0x2E80 for ch in text):
        return ImageFont.truetype(FONT_CJK[0], size, index=FONT_CJK[1])
    if any(ord(ch) > 0x2000 for ch in text):
        return ImageFont.truetype(FONT_SYMBOLS, size)
    return ImageFont.truetype(FONT_BOLD, size)

def chip(symbol, tier, S=512):
    img = Image.new('RGB', (S, S), (40, 6, 10))
    bg = ImageDraw.Draw(img)
    for r in range(S // 2, 0, -4):  # deep red vignette
        t = r / (S / 2)
        bg.ellipse([S/2 - r*1.45, S/2 - r*1.45, S/2 + r*1.45, S/2 + r*1.45], fill=(int(150 - 105*t), int(18 - 12*t), int(28 - 18*t)))
    sh = Image.new('L', (S, S), 0)
    ImageDraw.Draw(sh).rounded_rectangle([S*0.24, S*0.13, S*0.8, S*0.93], radius=S*0.07, fill=170)
    img = Image.composite(Image.new('RGB', (S, S), (0, 0, 0)), img, sh.filter(ImageFilter.GaussianBlur(S * 0.03)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([S*0.23, S*0.12, S*0.77, S*0.9], radius=S*0.07, fill=(12, 107, 78))          # jade back
    d.rounded_rectangle([S*0.21, S*0.08, S*0.75, S*0.84], radius=S*0.07, fill=(246, 241, 226))       # ivory face
    d.rounded_rectangle([S*0.245, S*0.115, S*0.715, S*0.805], radius=S*0.05, outline=(226, 214, 186), width=int(S*0.012))
    if tier == 'gold':
        d.rounded_rectangle([S*0.21, S*0.08, S*0.75, S*0.84], radius=S*0.07, outline=(232, 192, 96), width=int(S*0.018))
    n = len(symbol)
    size = int(S * (0.4 if n <= 1 else 0.27 if n == 2 else 0.2))
    f = font(symbol, size)
    cx, cy = S * 0.48, S * 0.46
    bbox = d.textbbox((0, 0), symbol, font=f)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((cx - w / 2 - bbox[0], cy - h / 2 - bbox[1]), symbol, font=f, fill=INK[tier])
    return img

def locked(img):
    g = ImageOps.grayscale(img).point(lambda v: int(v * 0.55))
    return ImageOps.colorize(g, (10, 10, 12), (150, 150, 158))

os.makedirs(OUT, exist_ok=True)
os.makedirs(GAME, exist_ok=True)
sheet = Image.new('RGB', (10 * 136, 4 * 136), (30, 20, 12))
for i, (aid, sym, tier) in enumerate(ICONS):
    big = chip(sym, tier)
    on = big.resize((64, 64), Image.LANCZOS)
    off = locked(big).resize((64, 64), Image.LANCZOS)
    on.save(os.path.join(OUT, f'{aid}.jpg'), quality=95)
    off.save(os.path.join(OUT, f'{aid}_locked.jpg'), quality=95)
    big.resize((128, 128), Image.LANCZOS).save(os.path.join(GAME, f'{aid}.jpg'), quality=88)
    locked(big).resize((128, 128), Image.LANCZOS).save(os.path.join(GAME, f'{aid}_locked.jpg'), quality=88)
    x, y = (i % 10) * 136, (i // 10) * 2 * 136
    sheet.paste(big.resize((128, 128), Image.LANCZOS), (x + 4, y + 4))
    sheet.paste(locked(big).resize((128, 128), Image.LANCZOS), (x + 4, y + 136 + 4))
sheet.save(os.path.join(OUT, '_preview.png'))
print('wrote', len(ICONS) * 2, 'icons to', os.path.abspath(OUT))
