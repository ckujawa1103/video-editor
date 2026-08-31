#!/usr/bin/env python3
"""
assemble.py - build the cut from selects, with narration and the silence budget.

    python3 tools/assemble.py --project projects/the-woman-beyond-the-hill
    python3 tools/assemble.py --project ... --narration path/to/narration
    python3 tools/assemble.py --project ... --dry-run

Reads out/cropped/ (which crop.py derives from selects/). It never reads
takes/ — rule 2. A missing select is a hard stop naming the shot, not a
silent substitution.

Each shot is trimmed from its 8-second generation down to the "cut" duration
in shotlist.json. Trims are re-encoded so the cut lands on the exact frame
rather than the nearest keyframe.

SHOT 28 is pure black for three seconds and is generated here with ffmpeg,
matching the surrounding shots' resolution and frame rate. It is never sent
to the API.

NARRATION AND SILENCE
The script requires at least 45 seconds of runtime carrying no audio at all.
Narration files are laid at the start of the shot they belong to; every
region without narration is true digital silence. The silence budget is
measured and the build FAILS if it is not met, rather than quietly shipping
a film that breaks its own rule. With no narration supplied, the output
carries no audio stream whatsoever.

    narration/narration-06.wav  ->  laid at the start of shot 6
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

SILENCE_REQUIRED = 45.0          # seconds, from the script's sound spec
RUNTIME_TARGET = (390, 420)      # 6:30-7:00
BLACK_SHOTS = {28}
AUDIO_EXT = (".wav", ".flac", ".m4a", ".mp3", ".aac", ".ogg")


def ffprobe(path, entries, stream=None):
    cmd = ["ffprobe", "-v", "error"]
    if stream:
        cmd += ["-select_streams", stream]
    cmd += ["-show_entries", entries, "-of", "default=nw=1:nk=1", path]
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


def duration(path):
    try:
        return float(ffprobe(path, "format=duration"))
    except ValueError:
        return 0.0


def video_props(path):
    out = ffprobe(path, "stream=width,height,r_frame_rate", "v:0").split()
    if len(out) < 3:
        return None
    w, h, rate = int(out[0]), int(out[1]), out[2]
    num, _, den = rate.partition("/")
    fps = float(num) / float(den or 1)
    return w, h, fps


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:400])
    return r


def find_narration(ndir, sid):
    if not ndir or not os.path.isdir(ndir):
        return None
    for ext in AUDIO_EXT:
        for stem in (f"narration-{sid:02d}", f"narration-{sid}", f"{sid:02d}", str(sid)):
            p = os.path.join(ndir, stem + ext)
            if os.path.exists(p):
                return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--narration", help="directory of narration-NN.wav files")
    ap.add_argument("--out", help="output path (default out/<project>-cut.mp4)")
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--dry-run", action="store_true",
                    help="report the edit and the silence budget, build nothing")
    ap.add_argument("--allow-short-silence", action="store_true",
                    help="build even if the 45s silence requirement is not met")
    args = ap.parse_args()

    proj = args.project
    crop_dir = os.path.join(proj, "out", "cropped")
    sel_json = os.path.join(proj, "selects.json")
    out_dir = os.path.join(proj, "out")
    os.makedirs(out_dir, exist_ok=True)

    with open(os.path.join(proj, "shotlist.json")) as f:
        spec = json.load(f)
    shots = spec["shots"]

    selections = {}
    if os.path.exists(sel_json):
        with open(sel_json) as f:
            selections = json.load(f).get("selections", {})

    # ---- resolve every shot to a source, or stop ----
    plan, missing = [], []
    for shot in shots:
        sid, cut = shot["id"], float(shot["cut"])
        if sid in BLACK_SHOTS:
            plan.append({"id": sid, "cut": cut, "src": None, "black": True})
            continue
        src = os.path.join(crop_dir, f"shot-{sid:02d}.mp4")
        if not os.path.exists(src):
            missing.append(sid)
            continue
        plan.append({"id": sid, "cut": cut, "src": src, "black": False,
                     "have": duration(src)})

    if missing:
        print("Cannot assemble. These shots have no cropped select:")
        print("  " + ", ".join(f"{i:02d}" for i in missing))
        unselected = [i for i in missing if str(i) not in selections]
        if unselected:
            print("\n  not yet selected: " + ", ".join(str(i) for i in unselected))
            print("  -> contact_sheet.py, then select.py")
        cropped_gap = [i for i in missing if str(i) in selections]
        if cropped_gap:
            print("  selected but not cropped: "
                  + ", ".join(str(i) for i in cropped_gap))
            print("  -> crop.py")
        print("\nRule 2: the cut is built from selects only. "
              "takes/ is never used to fill a gap.")
        sys.exit(1)

    short = [(p["id"], p["have"], p["cut"]) for p in plan
             if not p["black"] and p["have"] + 0.05 < p["cut"]]
    if short:
        print("These shots are shorter than their cut duration:")
        for sid, have, cut in short:
            print(f"  shot {sid:02d}: {have:.2f}s available, {cut:.1f}s needed")
        print("Shorten the cut in shotlist.json or regenerate the shot.")
        sys.exit(1)

    runtime = sum(p["cut"] for p in plan)

    # ---- narration and the silence budget ----
    t = 0.0
    narration, narrated = [], 0.0
    for p in plan:
        p["start"] = t
        n = find_narration(args.narration, p["id"])
        if n:
            nd = duration(n)
            if nd > p["cut"]:
                print(f"  ! narration for shot {p['id']:02d} is {nd:.1f}s but the "
                      f"shot is {p['cut']:.1f}s — it will run under the next shot")
            narration.append({"id": p["id"], "path": n, "start": t, "dur": nd})
            narrated += nd
        t += p["cut"]

    narrated = min(narrated, runtime)
    silence = runtime - narrated

    print(f"shots        {len(plan)} ({len(BLACK_SHOTS & {p['id'] for p in plan})} "
          f"black, generated with ffmpeg)")
    print(f"runtime      {runtime:.1f}s  ({int(runtime // 60)}:{int(runtime % 60):02d})")
    print(f"narration    {len(narration)} file(s), {narrated:.1f}s")
    print(f"silence      {silence:.1f}s  (required {SILENCE_REQUIRED:.0f}s)")

    if not (RUNTIME_TARGET[0] <= runtime <= RUNTIME_TARGET[1]):
        lo, hi = RUNTIME_TARGET
        print(f"\n  ! runtime is outside the script's {lo // 60}:{lo % 60:02d}-"
              f"{hi // 60}:{hi % 60:02d} target by "
              f"{(lo - runtime if runtime < lo else runtime - hi):.0f}s.")
        print("    The cut durations in shotlist.json sum to less than the "
              "target runtime. Not fatal, but the film will come in short.")

    ok_silence = silence >= SILENCE_REQUIRED
    if not ok_silence:
        print(f"\n  SILENCE REQUIREMENT NOT MET: {silence:.1f}s of "
              f"{SILENCE_REQUIRED:.0f}s required.")
        print(f"    Cut {narrated - (runtime - SILENCE_REQUIRED):.1f}s of narration, "
              f"or lengthen the silent shots.")
        if not args.allow_short_silence and not args.dry_run:
            sys.exit("Refusing to build. Pass --allow-short-silence to override.")

    if args.dry_run:
        print("\nedit:")
        for p in plan:
            kind = "BLACK (ffmpeg)" if p["black"] else os.path.basename(p["src"])
            nar = next((n for n in narration if n["id"] == p["id"]), None)
            tag = f"  narration {nar['dur']:.1f}s" if nar else "  [silent]"
            print(f"  {p['start']:6.1f}s  shot {p['id']:02d}  {p['cut']:4.1f}s  "
                  f"{kind:22s}{tag}")
        print("\ndry run: nothing written")
        return

    ref = next((p for p in plan if not p["black"]), None)
    props = video_props(ref["src"]) if ref else None
    if not props:
        sys.exit("could not read video properties from any cropped shot")
    w, h, fps = props
    print(f"\nformat       {w}x{h} @ {fps:.3f}fps  ({w / h:.2f}:1)")

    out_path = args.out or os.path.join(
        out_dir, f"{spec.get('project', 'cut')}-cut.mp4")

    with tempfile.TemporaryDirectory() as tmp:
        # ---- trim / generate each segment to identical parameters ----
        segs = []
        for p in plan:
            seg = os.path.join(tmp, f"seg-{p['id']:02d}.mp4")
            if p["black"]:
                print(f"  shot {p['id']:02d}: black {p['cut']:.1f}s (ffmpeg)")
                run(["ffmpeg", "-nostdin", "-v", "error", "-y",
                     "-f", "lavfi", "-i",
                     f"color=c=black:s={w}x{h}:r={fps:.6f}:d={p['cut']}",
                     "-c:v", "libx264", "-crf", str(args.crf), "-preset", "medium",
                     "-pix_fmt", "yuv420p", seg])
            else:
                print(f"  shot {p['id']:02d}: trim {p['have']:.1f}s -> {p['cut']:.1f}s")
                run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", p["src"],
                     "-t", f"{p['cut']:.3f}",
                     "-vf", f"scale={w}:{h},fps={fps:.6f}",
                     "-an", "-c:v", "libx264", "-crf", str(args.crf),
                     "-preset", "medium", "-pix_fmt", "yuv420p", seg])
            segs.append(seg)

        listfile = os.path.join(tmp, "concat.txt")
        with open(listfile, "w") as f:
            for s in segs:
                f.write(f"file '{s}'\n")

        silent_cut = os.path.join(tmp, "video.mp4")
        print("  concatenating...")
        run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "concat",
             "-safe", "0", "-i", listfile, "-c", "copy", silent_cut])

        if not narration:
            shutil.copy2(silent_cut, out_path)
            print("\n  no narration supplied: the output carries no audio "
                  "stream at all.")
        else:
            # Silent bed the length of the film, narration laid at each shot's
            # start. Every un-narrated region is true digital silence.
            print(f"  mixing {len(narration)} narration file(s)...")
            cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", silent_cut,
                   "-f", "lavfi", "-t", f"{runtime:.3f}",
                   "-i", "anullsrc=r=48000:cl=stereo"]
            for n in narration:
                cmd += ["-i", n["path"]]

            parts, labels = [], ["[1:a]"]
            for i, n in enumerate(narration):
                lbl = f"[a{i}]"
                parts.append(f"[{i + 2}:a]aresample=48000,aformat="
                             f"sample_fmts=fltp:channel_layouts=stereo,"
                             f"adelay={int(n['start'] * 1000)}|"
                             f"{int(n['start'] * 1000)}{lbl}")
                labels.append(lbl)
            parts.append(f"{''.join(labels)}amix=inputs={len(labels)}:"
                         f"normalize=0:duration=first[mix]")

            cmd += ["-filter_complex", ";".join(parts),
                    "-map", "0:v", "-map", "[mix]",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", "-shortest", out_path]
            run(cmd)

    final_dur = duration(out_path)
    size = os.path.getsize(out_path) / 1e6
    print(f"\n  -> {out_path}")
    print(f"     {final_dur:.1f}s, {size:.1f} MB, {w}x{h} ({w / h:.2f}:1)")
    print(f"     silence {silence:.1f}s"
          + ("" if ok_silence else "  ** BELOW REQUIREMENT, built under override **"))
    print("\nRule 6: nothing is submitted anywhere. The file is yours to send.")


if __name__ == "__main__":
    main()
