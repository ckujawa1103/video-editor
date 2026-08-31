#!/usr/bin/env python3
"""
contact_sheet.py - one labelled image per shot, for reviewing takes on a phone.

Pulls 3 frames from every take of a shot and tiles them into a single image:
one row per take, three frames across. Lets you compare takes without
downloading a single video.

    python3 tools/contact_sheet.py --project projects/the-woman-beyond-the-hill
    python3 tools/contact_sheet.py --project ... --only 6,12,19
    python3 tools/contact_sheet.py --project ... --force

Idempotent: a sheet is rebuilt only if a take is newer than the sheet, or
--force is passed. Reads takes/, writes out/contact/. Never deletes a take.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

FRAMES_PER_TAKE = 3
FRAME_W = 480                  # per-frame width in the sheet
PAD = 8
LABEL_H = 34                   # per-row label strip
HEADER_H = 88

BG = (16, 16, 18)
FG = (232, 228, 220)
DIM = (140, 136, 130)
RULE = (52, 50, 48)


def font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


F_HEAD = font(30)
F_SUB = font(19)
F_LABEL = font(21)


def duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def grab(video, t, dest):
    """One frame at time t. -ss before -i so it seeks instead of decoding."""
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{t:.2f}",
         "-i", video, "-frames:v", "1", "-q:v", "3", dest],
        check=False, capture_output=True)
    return os.path.exists(dest) and os.path.getsize(dest) > 0


def takes_for(takes_dir, sid):
    prefix = f"shot-{sid:02d}-take-"
    if not os.path.isdir(takes_dir):
        return []
    fs = [f for f in os.listdir(takes_dir)
          if f.startswith(prefix) and f.endswith(".mp4")]

    def n(f):
        try:
            return int(f[len(prefix):-4])
        except ValueError:
            return 0
    return [(n(f), os.path.join(takes_dir, f)) for f in sorted(fs, key=n)]


def build_sheet(shot, takes, dest):
    sid = shot["id"]
    thumbs = []                                    # [(take_no, [Image, ...])]

    with tempfile.TemporaryDirectory() as tmp:
        for take_no, path in takes:
            dur = duration(path)
            if dur <= 0:
                print(f"    take {take_no}: unreadable, skipped")
                continue
            # 15% / 50% / 85% — avoids the first and last frame, which are
            # often the least representative of a generation.
            row = []
            for i, frac in enumerate((0.15, 0.50, 0.85)):
                fp = os.path.join(tmp, f"t{take_no}-{i}.jpg")
                if grab(path, dur * frac, fp):
                    row.append(Image.open(fp).convert("RGB"))
            if row:
                thumbs.append((take_no, row))

        if not thumbs:
            return False

        ar = thumbs[0][1][0].height / thumbs[0][1][0].width
        fh = int(FRAME_W * ar)
        row_h = fh + LABEL_H
        cols = max(len(r) for _, r in thumbs)
        W = PAD + cols * (FRAME_W + PAD)
        H = HEADER_H + len(thumbs) * (row_h + PAD)

        sheet = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(sheet)

        d.text((PAD, 12), f"SHOT {sid:02d}", font=F_HEAD, fill=FG)
        d.text((PAD + 150, 20),
               f"section {shot.get('section', '?')}   cut {shot['cut']}s   "
               f"{len(thumbs)} takes", font=F_SUB, fill=DIM)
        blurb = shot["prompt"]
        d.text((PAD, 54), blurb[:96] + ("..." if len(blurb) > 96 else ""),
               font=F_SUB, fill=DIM)
        d.line([(0, HEADER_H - 4), (W, HEADER_H - 4)], fill=RULE, width=2)

        y = HEADER_H
        for take_no, row in thumbs:
            x = PAD
            for im in row:
                sheet.paste(im.resize((FRAME_W, fh), Image.LANCZOS), (x, y))
                x += FRAME_W + PAD
            ly = y + fh + 6
            d.text((PAD, ly), f"take {take_no}", font=F_LABEL, fill=FG)
            d.text((PAD + 110, ly + 2),
                   f"select with:  select.py --shot {sid} --take {take_no}",
                   font=F_SUB, fill=DIM)
            y += row_h + PAD
            d.line([(0, y - PAD // 2), (W, y - PAD // 2)], fill=RULE, width=1)

        sheet.save(dest, "JPEG", quality=88, optimize=True)
        return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--only", help="comma-separated shot ids")
    ap.add_argument("--force", action="store_true", help="rebuild every sheet")
    args = ap.parse_args()

    shotlist = os.path.join(args.project, "shotlist.json")
    takes_dir = os.path.join(args.project, "takes")
    out_dir = os.path.join(args.project, "out", "contact")
    os.makedirs(out_dir, exist_ok=True)

    with open(shotlist) as f:
        spec = json.load(f)

    shots = spec["shots"]
    if args.only:
        keep = {int(x) for x in args.only.split(",")}
        shots = [s for s in shots if s["id"] in keep]

    built = skipped = empty = 0
    for shot in shots:
        sid = shot["id"]
        takes = takes_for(takes_dir, sid)
        dest = os.path.join(out_dir, f"shot-{sid:02d}.jpg")

        if not takes:
            print(f"  shot {sid:02d}: no takes")
            empty += 1
            continue

        if not args.force and os.path.exists(dest):
            newest = max(os.path.getmtime(p) for _, p in takes)
            if os.path.getmtime(dest) >= newest:
                print(f"  shot {sid:02d}: sheet current, skipping")
                skipped += 1
                continue

        print(f"  shot {sid:02d}: {len(takes)} takes -> {os.path.basename(dest)}")
        if build_sheet(shot, takes, dest):
            built += 1
        else:
            print(f"    no frames could be read")
            empty += 1

    print(f"\n{built} built, {skipped} current, {empty} without usable takes")
    print(f"sheets in {out_dir}")
    if built:
        print("review, then: select.py --shot N --take N")


if __name__ == "__main__":
    main()
