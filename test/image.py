#!/usr/bin/env python3
"""Measure and slice the harness screenshots in test/out/.

    python3 test/image.py sample <png> <x,y> [x,y ...]
    python3 test/image.py diff   <a.png> <b.png>
    python3 test/image.py scan   <png> [threshold] [x0 y0 x1 y1]
    python3 test/image.py crop   <in.png> <out.png> <x0> <y0> <x1> <y1> [scale]

sample  colours at named points, for before/after tables
diff    how many pixels changed, where, and by how much
scan    find light blobs — the fastest way to spot an unthemed element, since
        an unstyled Gmail surface is almost always near-white
crop    cut a region out, optionally magnified, to actually look at it

No image library needed: Chrome writes 8-bit truecolour PNGs and zlib is stdlib.
"""

import sys
import zlib
import struct
import numpy as np


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'{path} is not a PNG'
    pos, idat, hdr = 8, b'', None
    while pos < len(data):
        ln, typ = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            hdr = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat += body
        pos += 12 + ln
    w, h, depth, ctype = hdr[0], hdr[1], hdr[2], hdr[3]
    assert depth == 8 and ctype in (2, 6), f'unsupported depth/colour {depth}/{ctype}'
    ch = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    out = np.zeros((h, w * ch), dtype=np.uint8)
    stride, prev = w * ch, np.zeros(w * ch, dtype=np.uint8)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = np.frombuffer(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)],
                             dtype=np.uint8).astype(np.int32)
        cur = np.zeros(stride, dtype=np.int32)
        for x in range(stride):
            a = cur[x - ch] if x >= ch else 0
            b = int(prev[x])
            c = int(prev[x - ch]) if x >= ch else 0
            if f == 0:
                cur[x] = line[x]
            elif f == 1:
                cur[x] = line[x] + a
            elif f == 2:
                cur[x] = line[x] + b
            elif f == 3:
                cur[x] = line[x] + (a + b) // 2
            else:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                cur[x] = line[x] + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))
            cur[x] &= 0xFF
        out[y] = cur.astype(np.uint8)
        prev = out[y]
    return out.reshape(h, w, ch)[:, :, :3]


def write_png(path, arr):
    h, w, _ = arr.shape
    raw = b''.join(b'\x00' + arr[y].tobytes() for y in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    open(path, 'wb').write(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 6))
        + chunk(b'IEND', b''))


def hexs(px):
    return '#%02x%02x%02x' % tuple(px)


def cmd_sample(args):
    img = read_png(args[0])
    print(f'{args[0]}  {img.shape[1]}x{img.shape[0]}')
    for point in args[1:]:
        x, y = (int(v) for v in point.split(','))
        print(f'  {point:>12}  {hexs(img[y, x])}')


def cmd_diff(args):
    a, b = read_png(args[0]), read_png(args[1])
    if a.shape != b.shape:
        print(f'different sizes: {a.shape} vs {b.shape}')
        return
    d = a.astype(int) - b.astype(int)
    mask = np.abs(d).sum(axis=2) > 0
    print(f'differing pixels: {mask.sum():,} of {mask.size:,} ({100 * mask.sum() / mask.size:.2f}%)')
    if mask.any():
        ys, xs = np.where(mask)
        print(f'bounding box: x {xs.min()}-{xs.max()}, y {ys.min()}-{ys.max()}')
        print(f'max per-channel delta: {np.abs(d).max()}')


def cmd_scan(args):
    img = read_png(args[0])
    threshold = int(args[1]) if len(args) > 1 else 235
    if len(args) >= 6:
        x0, y0, x1, y1 = (int(v) for v in args[2:6])
        img, ox, oy = img[y0:y1, x0:x1], x0, y0
    else:
        ox = oy = 0
    mask = (img[:, :, 0] > threshold) & (img[:, :, 1] > threshold) & (img[:, :, 2] > threshold)
    print(f'pixels brighter than {threshold}: {mask.sum():,}')
    if not mask.any():
        return
    ys, xs = np.where(mask)
    order = np.argsort(ys)
    xs, ys = xs[order], ys[order]
    groups, start = [], 0
    for i in range(1, len(ys)):
        if ys[i] - ys[i - 1] > 18:
            groups.append((start, i))
            start = i
    groups.append((start, len(ys)))
    for a, b in groups:
        if b - a < 40:
            continue
        gx, gy = xs[a:b], ys[a:b]
        print(f'  blob  x {gx.min() + ox}-{gx.max() + ox}  y {gy.min() + oy}-{gy.max() + oy}  n={b - a}')


def cmd_crop(args):
    src, dst = args[0], args[1]
    x0, y0, x1, y1 = (int(v) for v in args[2:6])
    scale = int(args[6]) if len(args) > 6 else 1
    img = read_png(src)[y0:y1, x0:x1]
    if scale > 1:
        img = img.repeat(scale, axis=0).repeat(scale, axis=1)
    write_png(dst, np.ascontiguousarray(img))
    print(f'{dst}  {img.shape[1]}x{img.shape[0]} from {src}')


COMMANDS = {'sample': cmd_sample, 'diff': cmd_diff, 'scan': cmd_scan, 'crop': cmd_crop}

if __name__ == '__main__':
    if len(sys.argv) < 3 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])
