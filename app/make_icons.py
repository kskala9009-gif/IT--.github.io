from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).parent
font_path = r"C:\Windows\Fonts\seguisb.ttf"

for size in (192, 512):
    image = Image.new("RGB", (size, size), "#09090b")
    draw = ImageDraw.Draw(image)
    margin = size // 7
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=size // 5,
        fill="#ffffff",
    )
    draw.polygon(
        [(size // 2, margin), (size - margin, margin), (size - margin, size - margin)],
        fill="#6d63ff",
    )
    font = ImageFont.truetype(font_path, size // 2)
    text_box = draw.textbbox((0, 0), "S", font=font)
    x = (size - (text_box[2] - text_box[0])) / 2
    y = (size - (text_box[3] - text_box[1])) / 2 - text_box[1]
    draw.text((x, y), "S", font=font, fill="#09090b")
    image.save(root / f"icon-{size}.png", optimize=True)
