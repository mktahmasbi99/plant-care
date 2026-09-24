"""Generate the Plant Care home-screen icons from the shared green sprout mark."""

import math
from pathlib import Path

from PIL import Image, ImageDraw


OUTPUT = Path(__file__).resolve().parents[1] / "public"
CANVAS = 1024


def point(value: float) -> int:
    return round(value * CANVAS / 512)


def icon() -> Image.Image:
    image = Image.new("RGBA", (CANVAS, CANVAS), "#2f5b40")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, CANVAS, CANVAS), radius=point(112), fill="#2f5b40")
    draw.rounded_rectangle(
        (point(231), point(245), point(281), point(416)),
        radius=point(25),
        fill="#dcecdf",
    )
    leaf(draw, (256, 252), (105, 108))
    leaf(draw, (256, 252), (407, 108))
    draw.ellipse(
        (point(236), point(232), point(276), point(272)), fill="#a9cfae"
    )
    return image


def leaf(draw: ImageDraw.ImageDraw, base: tuple[int, int], tip: tuple[int, int]) -> None:
    """Draw a pointed, symmetrical leaf with a broad natural center."""
    dx, dy = tip[0] - base[0], tip[1] - base[1]
    length = math.hypot(dx, dy)
    normal = (-dy / length, dx / length)
    points = []
    for sign in (1, -1):
        values = range(25) if sign == 1 else range(24, -1, -1)
        for index in values:
            progress = index / 24
            width = math.sin(math.pi * progress) * 67
            points.append(
                (
                    point(base[0] + dx * progress + normal[0] * width * sign),
                    point(base[1] + dy * progress + normal[1] * width * sign),
                )
            )
    draw.polygon(points, fill="#f5f4ee")


for filename, size in {
    "pwa-512x512.png": 512,
    "pwa-maskable-512x512.png": 512,
    "pwa-192x192.png": 192,
    "apple-touch-icon.png": 180,
}.items():
    icon().resize((size, size), Image.Resampling.LANCZOS).convert("RGB").save(OUTPUT / filename)
