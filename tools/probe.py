#!/usr/bin/env python3
"""
probe.py - settle the disputed Veo API parameters with one cheap call.

The docs disagree with each other. Vertex AI's VideoGenerationModelParams
lists negativePrompt and sampleCount; the Gemini API's Veo page lists
neither. Guessing wrong is expensive in two different ways:

  - If negativePrompt is NOT accepted, the style negative has to stay
    concatenated into the positive prompt, where it may summon the very
    things it names.
  - If sampleCount is NOT accepted, one call returns one video while the
    spend ledger bills for N. The ledger drifts and the cap stops working.

So we ask the API instead of assuming. This sends ONE real request with
both disputed fields and reports exactly what came back.

    export GEMINI_API_KEY=...
    python3 tools/probe.py --shotlist projects/the-woman-beyond-the-hill/shotlist.json

Cost: sampleCount x 8s x the model's per-second rate. On Veo 3.1 Lite at
$0.05/s that is $0.80 for the default 2 samples. A rejected request costs
nothing, so a negative result is free.

The API key is read from the environment, sent as an x-goog-api-key header,
and never written to a URL, a file, or a log line.
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
POLL_TIMEOUT = 900

# Per-second USD, 720p. Verified against ai.google.dev/gemini-api/docs/pricing.
RATES = {
    "veo-3.1-generate-preview": 0.40,
    "veo-3.1-fast-generate-preview": 0.10,
    "veo-3.1-lite-generate-preview": 0.05,
}

_KEY = None


def scrub(text):
    """Never let the key reach stdout, even inside an exception string."""
    s = str(text)
    if _KEY:
        s = s.replace(_KEY, "***REDACTED***")
    return re.sub(r"(key=)[A-Za-z0-9_.\-]+", r"\1***REDACTED***", s)


def api_key():
    k = os.environ.get("GEMINI_API_KEY")
    if not k:
        sys.exit("GEMINI_API_KEY is not set. export it and re-run.\n"
                 "Do not paste it into a file, a commit, or a chat window.")
    return k


def request(url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "x-goog-api-key": _KEY},
        method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


KNOWN_FIELDS = ("negativePrompt", "sampleCount", "personGeneration",
                "durationSeconds", "aspectRatio", "resolution", "prompt",
                "instances", "parameters", "seed", "numberOfVideos")


def blamed_field(body_lower):
    """Which field did the API name in its error? None if it named none."""
    for f in KNOWN_FIELDS:
        if f.lower() in body_lower:
            return f
    return None


def attempt(url, payload, label):
    """Returns (operation, None) on success or (None, error_body) on HTTP 4xx."""
    print(f"  -> {label}")
    try:
        return request(url, payload), None
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"     rejected: HTTP {e.code}")
        for line in scrub(body).splitlines()[:6]:
            print(f"       {line}")
        return None, body
    except Exception as e:
        sys.exit(f"     network failure: {scrub(e)}")


def poll(name):
    waited = 0
    while True:
        time.sleep(POLL_SECONDS)
        waited += POLL_SECONDS
        try:
            st = request(f"{BASE}/{name}")
        except urllib.error.HTTPError as e:
            print(f"     poll error {e.code}, retrying")
            continue
        except Exception as e:
            print(f"     poll error: {scrub(e)}, retrying")
            continue
        if st.get("done"):
            return st
        if waited > POLL_TIMEOUT:
            return None
        print(f"     ...{waited}s", flush=True)


def find_uris(obj, path="response"):
    """Walk the response and report every place a video URI actually lives.

    The documented path is
      response.generateVideoResponse.generatedSamples[].video.uri
    but the SDK and REST shapes have differed, so we discover it rather
    than trusting one spelling.
    """
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "uri" and isinstance(v, str):
                found.append((path, v))
            else:
                found.extend(find_uris(v, f"{path}.{k}"))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found.extend(find_uris(v, f"{path}[{i}]"))
    return found


def download(uri, path):
    req = urllib.request.Request(uri, headers={"x-goog-api-key": _KEY})
    try:
        with urllib.request.urlopen(req, timeout=300) as r, open(path, "wb") as f:
            f.write(r.read())
        return os.path.getsize(path)
    except Exception as e:
        print(f"     download failed: {scrub(e)}")
        return 0


def main():
    global _KEY
    ap = argparse.ArgumentParser()
    ap.add_argument("--shotlist", required=True)
    ap.add_argument("--shot", type=int, default=24,
                    help="shot id to probe with (default 24: no people, so a "
                         "rejection is about parameters and not safety)")
    ap.add_argument("--sample-count", type=int, default=2,
                    help="also proves whether >1 sample per call actually works")
    ap.add_argument("--model")
    ap.add_argument("--out", default="./probe-out")
    args = ap.parse_args()

    _KEY = api_key()

    with open(args.shotlist) as f:
        spec = json.load(f)
    shot = next((s for s in spec["shots"] if s["id"] == args.shot), None)
    if shot is None:
        sys.exit(f"shot {args.shot} not found in {args.shotlist}")

    model = args.model or spec["model"]
    d = spec["defaults"]
    rate = RATES.get(model)
    dur = int(d["durationSeconds"])

    print(f"probing {model} with shot {args.shot}")
    if rate:
        print(f"cost if accepted: {args.sample_count} x {dur}s x ${rate}/s "
              f"= ${args.sample_count * dur * rate:.2f}   (rejection is free)")
    else:
        print(f"cost if accepted: unknown rate for {model}")
    print()

    url = f"{BASE}/models/{model}:predictLongRunning"
    base_params = {
        "aspectRatio": d["aspectRatio"],
        "resolution": d["resolution"],
        "durationSeconds": dur,
        "personGeneration": d["personGeneration"],
    }

    # Stage 1: everything we hope is real.
    full = dict(base_params)
    full["negativePrompt"] = spec["style_negative"]
    full["sampleCount"] = args.sample_count
    payload = {"instances": [{"prompt": f"{spec['style_positive']} {shot['prompt']}"}],
               "parameters": full}

    verdict = {"model": model, "personGeneration": d["personGeneration"]}
    op, err = attempt(url, payload, "stage 1: negativePrompt + sampleCount")

    if op is None:
        # Isolate which field caused it. These retries are also free if rejected.
        low = (err or "").lower()
        verdict["stage1_error"] = scrub(err)[:400]

        # A 400 that names some OTHER field says nothing about the disputed
        # ones. Concluding "negativePrompt rejected" from an unrelated type
        # error would be a false negative, so stop and say the payload is
        # wrong instead of guessing.
        blamed = blamed_field(low)
        if blamed and blamed not in ("negativePrompt", "sampleCount",
                                     "personGeneration"):
            print(f"\n  INCONCLUSIVE: the request was rejected over "
                  f"{blamed!r}, which is not one of the fields under test.")
            print(f"  Fix that first — nothing can be concluded about "
                  f"negativePrompt or sampleCount until the payload is valid.")
            verdict["result"] = "inconclusive"
            verdict["blamed_field"] = blamed
            _report(args, verdict)
            return

        if blamed == "personGeneration":
            print("\n  personGeneration value rejected. Fix shotlist defaults "
                  "before anything else.")
            verdict["personGeneration_accepted"] = False
            _report(args, verdict)
            return
        verdict["personGeneration_accepted"] = True

        op, err2 = attempt(url, {"instances": payload["instances"],
                                 "parameters": {**base_params,
                                                "sampleCount": args.sample_count}},
                           "stage 2: sampleCount only (negativePrompt dropped)")
        verdict["negativePrompt_accepted"] = op is not None and "negativePrompt" in low
        if op is None:
            op, _ = attempt(url, {"instances": payload["instances"],
                                  "parameters": base_params},
                            "stage 3: neither (baseline)")
            verdict["negativePrompt_accepted"] = False
            verdict["sampleCount_accepted"] = False
            if op is None:
                print("\n  baseline itself was rejected. The endpoint or the "
                      "defaults are wrong, not just the disputed fields.")
                _report(args, verdict)
                return
        else:
            verdict["sampleCount_accepted"] = True
    else:
        verdict["personGeneration_accepted"] = True
        verdict["negativePrompt_accepted"] = True
        verdict["sampleCount_accepted"] = True

    name = op.get("name")
    if not name:
        print(f"\n  no operation name returned: {scrub(json.dumps(op))[:300]}")
        _report(args, verdict)
        return

    print("     accepted. polling...")
    st = poll(name)
    if st is None:
        print("  TIMEOUT. The generation was still billed if it completes later.")
        verdict["result"] = "timeout"
        _report(args, verdict)
        return

    if "error" in st:
        print(f"  operation failed: {scrub(json.dumps(st['error']))[:400]}")
        verdict["result"] = "operation_error"
        _report(args, verdict)
        return

    resp = st.get("response", {})
    uris = find_uris(resp)
    verdict["uri_paths"] = [p for p, _ in uris]
    verdict["samples_returned"] = len(uris)
    verdict["samples_requested"] = args.sample_count

    print(f"\n  samples requested: {args.sample_count}")
    print(f"  samples returned:  {len(uris)}")
    for p, _ in uris:
        print(f"    found uri at: {p}")

    if not uris:
        print(f"  raw response: {scrub(json.dumps(resp))[:500]}")

    os.makedirs(args.out, exist_ok=True)
    for i, (_, uri) in enumerate(uris, 1):
        path = os.path.join(args.out, f"probe-shot{args.shot:02d}-{i}.mp4")
        size = download(uri, path)
        if size:
            print(f"    -> {path} ({size/1e6:.1f} MB)")
            verdict.setdefault("files", []).append(path)

    # Audio is documented as always-on for Veo 3.1. Confirm on the real file.
    for p in verdict.get("files", []):
        streams = os.popen(
            f"ffprobe -v error -show_entries stream=codec_type "
            f"-of csv=p=0 {p!r} 2>/dev/null").read().split()
        verdict["streams"] = streams
        print(f"    streams in {os.path.basename(p)}: {', '.join(streams) or 'none'}")
        break

    _report(args, verdict)


def _report(args, v):
    os.makedirs(args.out, exist_ok=True)
    p = os.path.join(args.out, "probe-result.json")
    with open(p, "w") as f:
        json.dump(v, f, indent=2)

    print("\n" + "=" * 58)
    print("VERDICT")
    print("=" * 58)
    for field in ("personGeneration_accepted", "negativePrompt_accepted",
                  "sampleCount_accepted"):
        if field in v:
            mark = "yes" if v[field] else "NO"
            print(f"  {field.replace('_accepted', ''):18s} accepted: {mark}")
    if "samples_returned" in v:
        ok = v["samples_returned"] == v["samples_requested"]
        print(f"  sampleCount honoured:        "
              f"{'yes' if ok else 'NO - ledger math would be wrong'}")
    if v.get("streams"):
        has_audio = "audio" in v["streams"]
        print(f"  audio track present:         "
              f"{'yes (must be stripped in post)' if has_audio else 'no'}")
    print(f"\n  written to {p}")
    print("  paste that file back to continue.")


if __name__ == "__main__":
    main()
