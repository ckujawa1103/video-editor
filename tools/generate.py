#!/usr/bin/env python3
"""
generate.py - batch shot generation against the Veo API.

One API call per shot, N takes each, resumable, with a hard spend cap.

    export GEMINI_API_KEY=...
    python3 tools/generate.py --shotlist projects/the-woman-beyond-the-hill/shotlist.json \
                              --out projects/the-woman-beyond-the-hill/takes --approved
    python3 tools/generate.py --shotlist ... --out ... --only 6,12,19 --approved
    python3 tools/generate.py --shotlist ... --dry-run

Verified against current docs (see CLAUDE.md for the full table):
  - Veo caps at 8 seconds per call. 34 shots = 34 calls.
  - Only 16:9 or 9:16. The 2.39:1 crop happens in post (crop.py).
  - personGeneration for TEXT-TO-VIDEO is "allow_all" only. "allow_adult" is
    for image-to-video and interpolation, and is rejected here.
  - Audio is always on and cannot be disabled. crop.py strips it.
  - Auth is the x-goog-api-key header, never a ?key= query param.
  - Billing is per second GENERATED (always 8), not per second kept.

negativePrompt and sampleCount are sent as real fields but are not documented
on this endpoint. If the API rejects them we fall back automatically and say
so. Run tools/probe.py first to settle it cheaply.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "https://generativelanguage.googleapis.com/v1beta"
POLL_SECONDS = 10
POLL_TIMEOUT = 900          # 15 min per shot before giving up

# Per-second USD at 720p, verified against ai.google.dev/gemini-api/docs/pricing.
RATES = {
    "veo-3.1-generate-preview": 0.40,
    "veo-3.1-fast-generate-preview": 0.10,
    "veo-3.1-lite-generate-preview": 0.05,
}

# Rule: shot 28 is pure black and is produced by ffmpeg in assemble.py.
# It carries a prompt only so shot numbering stays intact. Never generate it.
FFMPEG_ONLY_SHOTS = {28}

_KEY = None


def scrub(text):
    """The key must never reach stdout. urllib exceptions stringify the URL."""
    s = str(text)
    if _KEY:
        s = s.replace(_KEY, "***REDACTED***")
    return re.sub(r"(key=)[A-Za-z0-9_.\-]+", r"\1***REDACTED***", s)


def api_key():
    k = os.environ.get("GEMINI_API_KEY")
    if not k:
        sys.exit("GEMINI_API_KEY is not set. export it and re-run.")
    return k


def request(url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "x-goog-api-key": _KEY},
        method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def rate_for(model):
    if model not in RATES:
        sys.exit(f"No known per-second rate for {model!r}. Add it to RATES "
                 f"from ai.google.dev/gemini-api/docs/pricing before running — "
                 f"an unknown rate means the spend cap cannot protect you.")
    return RATES[model]


def build_prompt(spec, shot, inline_negative):
    """Style constants are byte-identical across every shot. That is the
    entire consistency mechanism - do not vary them per shot."""
    p = f"{spec['style_positive']} {shot['prompt']}"
    if inline_negative:
        # Fallback only, when the API will not take a negativePrompt field.
        p += f" NEGATIVE: {spec['style_negative']}"
    return p


def existing_takes(outdir, shot_id):
    """Count only complete takes. Partial downloads are written as .part and
    renamed on success, so a killed run never leaves a phantom take behind."""
    prefix = f"shot-{shot_id:02d}-take-"
    if not os.path.isdir(outdir):
        return 0
    return len([f for f in os.listdir(outdir)
                if f.startswith(prefix) and f.endswith(".mp4")])


def spend_path(outdir):
    return os.path.join(outdir, "spend.json")


def load_spend(outdir):
    p = spend_path(outdir)
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return {"total_usd": 0.0, "calls": []}


def save_spend(outdir, spend):
    with open(spend_path(outdir), "w") as f:
        json.dump(spend, f, indent=2)


def find_uris(obj):
    """Documented path is response.generateVideoResponse.generatedSamples[].
    video.uri, but shapes have differed between REST and SDK. Discover it."""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "uri" and isinstance(v, str):
                out.append(v)
            else:
                out.extend(find_uris(v))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(find_uris(v))
    return out


def generate_shot(spec, shot, outdir, takes, warn, cap, spend, caps):
    sid = shot["id"]
    if sid in FFMPEG_ONLY_SHOTS:
        print(f"  shot {sid:02d}: ffmpeg-only (pure black), never generated")
        return

    have = existing_takes(outdir, sid)
    need = takes - have
    if need <= 0:
        print(f"  shot {sid:02d}: {have} takes already, skipping")
        return

    model = spec["model"]
    rate = rate_for(model)
    dur = int(spec["defaults"]["durationSeconds"])

    # If sampleCount is not honoured we get one video per call, so cost is
    # per call, not per requested sample. Assume the expensive case.
    est = dur * need * rate
    projected = spend["total_usd"] + est

    if projected > cap:
        print(f"\n  HALT: shot {sid} would put spend at ${projected:.2f}, "
              f"over the ${cap:.2f} cap.")
        print(f"  Spent so far ${spend['total_usd']:.2f}. "
              f"{len([s for s in spec['shots'] if s['id'] >= sid])} shots remain.")
        print("  Raise --cap explicitly if you want to continue. "
              "This tool will not raise it for you.")
        sys.exit(1)
    if spend["total_usd"] < warn <= projected:
        print(f"\n  ! spend passing ${warn:.2f} (now ~${projected:.2f})\n")

    d = spec["defaults"]
    params = {
        "aspectRatio": d["aspectRatio"],
        "resolution": d["resolution"],
        "durationSeconds": dur,
        "personGeneration": d["personGeneration"],
    }
    if caps["negativePrompt"]:
        params["negativePrompt"] = spec["style_negative"]
    if caps["sampleCount"]:
        params["sampleCount"] = need

    prompt = build_prompt(spec, shot, inline_negative=not caps["negativePrompt"])
    payload = {"instances": [{"prompt": prompt}], "parameters": params}

    url = f"{BASE}/models/{model}:predictLongRunning"
    asked = need if caps["sampleCount"] else 1
    print(f"  shot {sid:02d}: requesting {asked} take(s)...", flush=True)

    try:
        op = request(url, payload)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        low = body.lower()
        # Degrade once, permanently, and say so.
        for field in ("negativeprompt", "samplecount"):
            key = "negativePrompt" if field == "negativeprompt" else "sampleCount"
            if field in low and caps[key]:
                caps[key] = False
                print(f"    API rejected {key}; disabling it for the rest of "
                      f"this run and retrying.")
                if key == "negativePrompt":
                    print("    style_negative falls back to inline prompt text.")
                return generate_shot(spec, shot, outdir, takes, warn, cap,
                                     spend, caps)
        print(f"    FAILED: {e.code} {scrub(body)[:300]}")
        return
    except Exception as e:
        print(f"    FAILED: {scrub(e)[:300]}")
        return

    name = op.get("name")
    if not name:
        print(f"    FAILED: no operation name. {scrub(json.dumps(op))[:300]}")
        return

    # The generation is billed from acceptance. Record it NOW, before polling,
    # so a timeout or a failed download cannot make the cap under-count.
    spend["total_usd"] += est
    spend["calls"].append({"shot": sid, "requested": asked, "seconds": dur * asked,
                           "est_usd": round(est, 2), "model": model,
                           "status": "accepted"})
    save_spend(outdir, spend)
    call = spend["calls"][-1]

    waited = 0
    while True:
        time.sleep(POLL_SECONDS)
        waited += POLL_SECONDS
        try:
            st = request(f"{BASE}/{name}")
        except Exception as e:
            print(f"    poll error: {scrub(e)[:120]}, retrying")
            continue
        if st.get("done"):
            break
        if waited > POLL_TIMEOUT:
            print("    TIMEOUT, moving on (already billed, recorded in spend.json)")
            call["status"] = "timeout"
            save_spend(outdir, spend)
            return
        print(f"    ...{waited}s", flush=True)

    if "error" in st:
        print(f"    FAILED: {scrub(json.dumps(st['error']))[:300]}")
        call["status"] = "error"
        save_spend(outdir, spend)
        return

    uris = find_uris(st.get("response", {}))
    if not uris:
        print(f"    no samples returned. Often a safety filter. "
              f"{scrub(json.dumps(st.get('response', {})))[:300]}")
        call["status"] = "no_samples"
        save_spend(outdir, spend)
        return

    written = 0
    for i, uri in enumerate(uris):
        final = os.path.join(outdir, f"shot-{sid:02d}-take-{have + i + 1}.mp4")
        part = final + ".part"
        try:
            req = urllib.request.Request(uri, headers={"x-goog-api-key": _KEY})
            with urllib.request.urlopen(req, timeout=300) as r, open(part, "wb") as f:
                f.write(r.read())
            os.replace(part, final)          # atomic: only complete files count
            written += 1
            print(f"    -> {os.path.basename(final)}")
        except Exception as e:
            print(f"    download failed: {scrub(e)[:200]}")
            if os.path.exists(part):
                os.remove(part)

    call["status"] = "ok"
    call["returned"] = len(uris)
    call["written"] = written
    save_spend(outdir, spend)

    if caps["sampleCount"] and len(uris) < asked:
        print(f"    note: asked for {asked}, got {len(uris)}. sampleCount may "
              f"not be honoured — re-run to top up.")


def main():
    global _KEY
    ap = argparse.ArgumentParser()
    ap.add_argument("--shotlist", required=True)
    ap.add_argument("--out", default="./takes")
    ap.add_argument("--takes", type=int)
    ap.add_argument("--only", help="comma-separated shot ids, e.g. 6,12,19")
    ap.add_argument("--warn", type=float, default=50.0)
    ap.add_argument("--cap", type=float, default=100.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--approved", action="store_true",
                    help="confirms the director has approved shotlist.json (rule 1)")
    args = ap.parse_args()

    with open(args.shotlist) as f:
        spec = json.load(f)

    takes = args.takes or spec["defaults"]["takes"]
    shots = spec["shots"]
    if args.only:
        keep = {int(x) for x in args.only.split(",")}
        shots = [s for s in shots if s["id"] in keep]
        missing = keep - {s["id"] for s in shots}
        if missing:
            sys.exit(f"no such shot(s): {sorted(missing)}")
    if not shots:
        sys.exit("no shots selected.")

    model = spec["model"]
    rate = rate_for(model)
    dur = int(spec["defaults"]["durationSeconds"])
    billable = [s for s in shots if s["id"] not in FFMPEG_ONLY_SHOTS]

    if args.dry_run:
        print(build_prompt(spec, billable[0] if billable else shots[0], False))
        print(f"\nnegativePrompt (sent as a field if accepted):")
        print(spec["style_negative"])
        print(f"\nmodel {model} @ ${rate}/s")
        print(f"{len(billable)} billable shots x {takes} takes x {dur}s "
              f"({len(shots) - len(billable)} ffmpeg-only, not billed)")
        print(f"estimated ${len(billable) * takes * dur * rate:.2f}")
        return

    if not args.approved:
        sys.exit("Refusing to generate: pass --approved to confirm the director "
                 "has approved shotlist.json (rule 1). Use --dry-run to preview.")

    if spec["defaults"]["personGeneration"] != "allow_all":
        sys.exit(f"personGeneration is {spec['defaults']['personGeneration']!r}. "
                 f"Text-to-video accepts 'allow_all' only; anything else is "
                 f"rejected by the API. Fix shotlist.json defaults.")

    os.makedirs(args.out, exist_ok=True)
    _KEY = api_key()
    spend = load_spend(args.out)
    caps = {"negativePrompt": True, "sampleCount": True}

    print(f"model {model} @ ${rate}/s")
    print(f"{len(billable)} billable shots, {takes} takes each, into {args.out}")
    print(f"full run would cost ~${len(billable) * takes * dur * rate:.2f}")
    print(f"spend so far ${spend['total_usd']:.2f}, cap ${args.cap:.2f}\n")

    for shot in shots:
        generate_shot(spec, shot, args.out, takes, args.warn, args.cap, spend, caps)

    # Rule 4: the style block is locked from first generation onward.
    if not spec.get("locked") and spend["calls"]:
        spec["locked"] = True
        with open(args.shotlist) as f:
            raw = f.read()
        with open(args.shotlist, "w") as f:
            f.write(raw.replace('"locked": false', '"locked": true', 1))
        print("\nshotlist.json is now locked=true. Changing style_positive or "
              "style_negative from here invalidates every generated shot.")

    print(f"\ndone. estimated spend ${spend['total_usd']:.2f}")
    print("next: contact_sheet.py to review takes, then select.py to choose")


if __name__ == "__main__":
    main()
