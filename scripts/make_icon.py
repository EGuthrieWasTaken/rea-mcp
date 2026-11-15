#!/usr/bin/env python3
"""Draw unraid/icon.png: original artwork for the rea-mcp unRAID template.

A magnifying lens over a grid of "byte cells": the product inspects binaries. Every shape is drawn
here from scratch with signed-distance functions, so the picture is original and reproduces byte for
byte. Python 3 standard library only.

    python3 scripts/make_icon.py [output.png]          (default: unraid/icon.png)

The PNG is a plain, single-frame 256 x 256 RGBA image with no ancillary chunks (so it is not
animated). 256 x 256 is a choice, not a documented Community Apps size (docs/DESIGN.md, 10.2).
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

SIZE = 256
Color = tuple[float, float, float, float]  # r, g, b in 0..255, alpha in 0..1


# --- signed distances: negative inside a shape, in pixels --------------------------------------
def round_rect(px: float, py: float, cx: float, cy: float, hx: float, hy: float, r: float) -> float:
    qx = abs(px - cx) - (hx - r)
    qy = abs(py - cy) - (hy - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def ring(px: float, py: float, cx: float, cy: float, radius: float, width: float) -> float:
    return abs(math.hypot(px - cx, py - cy) - radius) - width / 2


def disc(px: float, py: float, cx: float, cy: float, radius: float) -> float:
    return math.hypot(px - cx, py - cy) - radius


def capsule(px: float, py: float, ax: float, ay: float, bx: float, by: float, radius: float) -> float:
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - radius


def coverage(distance: float) -> float:
    """Anti-aliased coverage of a pixel whose centre is `distance` px from the shape's edge."""
    return max(0.0, min(1.0, 0.5 - distance))


# --- the picture --------------------------------------------------------------------------------
NAVY_TOP: Color = (30, 44, 78, 1.0)
NAVY_BOTTOM: Color = (13, 22, 44, 1.0)
CELL: Color = (58, 80, 120, 1.0)  # a quiet byte cell
CELL_HOT: Color = (96, 150, 236, 1.0)  # a highlighted byte cell
AMBER: Color = (255, 183, 3, 1.0)  # lens ring and handle
LENS_FILL: Color = (13, 22, 44, 1.0)  # hides the grid under the lens
ZOOM: Color = (120, 224, 214, 1.0)  # the magnified cells inside the lens

GRID_ORIGIN, GRID_PITCH, GRID_CELL = 34.0, 46.0, 30.0
HOT_CELLS = {(0, 1), (1, 3), (2, 0), (3, 2), (0, 3)}  # (row, column) of the highlighted cells
LENS_C, LENS_R, LENS_W = (150.0, 150.0), 58.0, 14.0
HANDLE = (192.0, 192.0, 228.0, 228.0, 10.0)  # ax, ay, bx, by, radius


def blend(base: list[float], colour: Color, cover: float) -> None:
    """Composite `colour` over `base` (premultiplied-free float RGBA) in place."""
    a = colour[3] * cover
    if a <= 0.0:
        return
    out_a = a + base[3] * (1 - a)
    for i in range(3):
        base[i] = (colour[i] * a + base[i] * base[3] * (1 - a)) / out_a
    base[3] = out_a


def pixel(x: int, y: int) -> list[float]:
    px, py = x + 0.5, y + 0.5
    # The whole icon is one rounded square, so the corners stay transparent.
    badge = coverage(round_rect(px, py, 128, 128, 128, 128, 52))
    t = py / SIZE
    top = [NAVY_TOP[i] * (1 - t) + NAVY_BOTTOM[i] * t for i in range(3)]
    px_rgba = [0.0, 0.0, 0.0, 0.0]
    blend(px_rgba, (top[0], top[1], top[2], 1.0), badge)

    for row in range(4):
        for col in range(4):
            cx = GRID_ORIGIN + GRID_CELL / 2 + col * GRID_PITCH
            cy = GRID_ORIGIN + GRID_CELL / 2 + row * GRID_PITCH
            hot = (row, col) in HOT_CELLS
            half = GRID_CELL / 2
            blend(px_rgba, CELL_HOT if hot else CELL, coverage(round_rect(px, py, cx, cy, half, half, 7)) * badge)

    lx, ly = LENS_C
    blend(px_rgba, LENS_FILL, coverage(disc(px, py, lx, ly, LENS_R)) * badge)
    # Four larger cells inside the lens: the same bytes, magnified.
    for dy in (-1, 1):
        for dx in (-1, 1):
            blend(px_rgba, ZOOM, coverage(round_rect(px, py, lx + dx * 19, ly + dy * 19, 15, 15, 6)) * badge)
    ax, ay, bx, by, hr = HANDLE
    blend(px_rgba, AMBER, coverage(capsule(px, py, ax, ay, bx, by, hr)) * badge)
    blend(px_rgba, AMBER, coverage(ring(px, py, lx, ly, LENS_R, LENS_W)) * badge)
    return px_rgba


# --- PNG ----------------------------------------------------------------------------------------
def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def render() -> bytes:
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)  # filter type 0 (none) for this scanline
        for x in range(SIZE):
            r, g, b, a = pixel(x, y)
            rows += bytes((round(r), round(g), round(b), round(a * 255)))
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8-bit RGBA, no interlace
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent / "unraid" / "icon.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(render())
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
