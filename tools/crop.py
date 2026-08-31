#!/usr/bin/env python3
"""
crop.py - 16:9 -> 2.39:1 centre crop plus the film grain pass. Selects only.

    python3 tools/crop.py --project projects/the-woman-beyond-the-hill
    python3 tools/crop.py --project ... --only 6,12,19
    python3 tools/crop.py --project ... --grain 22 --crush
    python3 tools/crop.py --project ... --force

Reads selects/, writes out/cropped/. Never touches takes/ (rule 2) and never
modifies a select in place — the select stays the pristine chosen take.

Two things happen here, both from the script's VISUAL BIBLE:

  Aspect   The film is 2.39:1. Veo only emits 16:9 or 9:16, so the scope
           framing is made here, by centre-cropping the 16:9 generation.

  Texture  "Heavy grain. Dust. Nothing clean." A uniform temporal grain is
           applied after the crop so grain size is consistent in the final
           frame rather than being scaled by it.

Audio is stripped (-an). Veo 3.1 always generates an audio track and this film
does not want it: the script requires at least 45 seconds carrying no audio at
all, and the score is built in assemble.py. Stripping here means selects are
silent by construction and no generated audio can leak into the cut.

Idempotent: a shot is re-encoded only if its select is newer, or --force.
"""

import argparse
import json
import os
import subprocess
import sys

TARGET_AR = 2.39


def probe(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True)
    try:
        w, h = r.stdout.strip().split("x")[:2]
        return int(w), int(h)
    except ValueError:
        return None, None


def has_audio(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
        capture_output=True, text=True)
    return bool(r.stdout.strip())


def build_filter(w, h, grain, crush):
    """Centre crop to 2.39:1, then grain. Grain last so it is not resampled."""
    ch = int(w / TARGET_AR)
    ch -= ch % 2                       # even height, required by yuv420p
    if ch > h:                         # source is already wider than 2.39
        ch = h - (h % 2)
    chain = [f"crop={w}:{ch}:0:{(h - ch) // 2}"]
    if crush:
        # "Single-source. Hard falloff to black." Deepens shadows without
        # touching highlights. Off by default — the look is prompted, not graded.
        chain.append("curves=all='0/0 0.18/0.06 0.6/0.62 1/1'")
    if grain > 0:
        chain.append(f"noise=alls={grain}:allf=t+u")
    return ",".join(chain), ch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--only", help="comma-separated shot ids")
    ap.add_argument("--grain", type=int, default=16,
                    help="grain strength 0-40 (default 16; 0 disables)")
    ap.add_argument("--crush", action="store_true",
                    help="deepen shadows toward hard falloff to black")
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    sel_dir = os.path.join(args.project, "selects")
    sel_json = os.path.join(args.project, "selects.json")
    out_dir = os.path.join(args.project, "out", "cropped")
    os.makedirs(out_dir, exist_ok=True)

    if not os.path.exists(sel_json):
        sys.exit("no selects.json — nothing has been selected yet.\n"
                 "Rule 2: the cut is built from selects, never from takes.\n"
                 "Run contact_sheet.py, then select.py.")

    with open(sel_json) as f:
        data = json.load(f)
    if not data.get("selections"):
        sys.exit("selects.json has no selections yet.")

    ids = sorted(int(k) for k in data["selections"])
    if args.only:
        keep = {int(x) for x in args.only.split(",")}
        ids = [i for i in ids if i in keep]
    if not ids:
        sys.exit("no matching selections.")

    done = skipped = failed = 0
    for sid in ids:
        src = os.path.join(sel_dir, data["selections"][str(sid)]["file"])
        dest = os.path.join(out_dir, f"shot-{sid:02d}.mp4")

        if not os.path.exists(src):
            print(f"  shot {sid:02d}: select missing ({os.path.basename(src)})")
            failed += 1
            continue

        if not args.force and os.path.exists(dest) \
                and os.path.getmtime(dest) >= os.path.getmtime(src):
            print(f"  shot {sid:02d}: current, skipping")
            skipped += 1
            continue

        w, h = probe(src)
        if not w:
            print(f"  shot {sid:02d}: unreadable")
            failed += 1
            continue

        vf, ch = build_filter(w, h, args.grain, args.crush)
        tmp = dest + ".tmp.mp4"
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src,
               "-vf", vf, "-an",
               "-c:v", "libx264", "-crf", str(args.crf), "-preset", "medium",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(tmp):
            print(f"  shot {sid:02d}: ffmpeg failed\n    {r.stderr.strip()[:200]}")
            if os.path.exists(tmp):
                os.remove(tmp)
            failed += 1
            continue

        os.replace(tmp, dest)
        note = " +crush" if args.crush else ""
        audio = " (audio stripped)" if has_audio(src) else ""
        print(f"  shot {sid:02d}: {w}x{h} -> {w}x{ch}  grain {args.grain}{note}{audio}")
        done += 1

    print(f"\n{done} cropped, {skipped} current, {failed} failed")
    print(f"output in {out_dir}")
    if failed:
        sys.exit(1)
    print("next: assemble.py")


if __name__ == "__main__":
    main()
