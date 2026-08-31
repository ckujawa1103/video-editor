# THE WOMAN BEYOND THE HILL — pipeline rules

Automated pipeline for a narrated horror short. `projects/the-woman-beyond-the-hill/`
holds the film; `tools/` holds the code. Every tool is a standalone CLI, runnable
independently, idempotent, plain-text output. No GUI, no browser step — this is
driven from a phone.

---

## THE SEVEN RULES

These are not defaults. They are not negotiable without the director saying so
in the current session.

**1. Never generate before the director approves `shotlist.json`.**
No API call until they have said, in words, that the shotlist is approved. A
shotlist that merely exists is not an approved shotlist.

**2. Never assemble from `takes/` — only from `selects/`.**
`takes/` is raw output, including rejects. `assemble.py` reads `selects/` and
`selects.json` and nothing else. If a select is missing, stop and say which
shot; do not reach into `takes/` to fill the hole.

**3. The style constants in `shotlist.json` are byte-identical across every shot.**
`style_positive` and `style_negative` are prepended and applied to every shot
exactly as written. Never tune them per shot. Never "improve" one shot's copy.
That byte-identity is the entire consistency mechanism — it is why 34 separate
API calls look like one film.

**4. Once generation starts, the style block is locked.**
Set `"locked": true` in `shotlist.json` at first generation. After that, changing
`style_positive` or `style_negative` invalidates every shot already generated.
If a change is requested, say so explicitly and in full: name every shot that
would need regenerating and what it costs. Never make the edit quietly.

**5. Discard any take that renders the old man as a visible figure.**
Regardless of quality. The old man is never rendered — he is a displacement at
the edge of lamplight. A beautiful take with a figure in the dark is a failed
take. This applies to shots 17, 18, 21, 22, 24 and 27 especially.

**6. Never submit anything to any platform.**
No uploads, no publishing, no posting, no sharing. The pipeline produces a file
in `out/`. The director submits it.

**7. Halt at the spend cap and ask.**
When projected spend crosses `--cap`, stop and report. Never raise the cap,
never edit the default, never work around it by splitting runs. The director
raises it explicitly or it does not go up.

---

## VERIFIED API FACTS

Audited against current docs. Do not re-derive from memory; do not assume the
older bash example is still right.

| Fact | Value |
|---|---|
| Endpoint | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning` |
| Auth | `x-goog-api-key` **header**. Never a `?key=` query param — those land in proxy and server logs. |
| Model | `veo-3.1-lite-generate-preview` |
| Price | **$0.05/s** (Lite 720p). Standard $0.40/s, Fast $0.10/s. No free tier. |
| Billing | Per second **generated** (always 8), not per second kept after trimming to `cut`. |
| `personGeneration` | **`allow_all`** — text-to-video accepts only this. `allow_adult` is image-to-video/interpolation only. Region-restricted in EU/UK/CH/MENA. |
| `durationSeconds` | **Number**, not a string: `4`, `6`, `8`. The docs example shows `"8"` quoted; the live API rejects a string. Must be `8` at 1080p/4K. |
| `aspectRatio` | `16:9` or `9:16` only. **2.39:1 comes from `crop.py`, never the API.** |
| `resolution` | `720p` / `1080p` (Lite has no 4K). |
| Audio | **Always on. Cannot be disabled.** Every take arrives with generated audio. |
| Response path | `response.generateVideoResponse.generatedSamples[].video.uri` |

### Still unverified — settle with `tools/probe.py`, do not guess

- **`negativePrompt`** — documented on Vertex, absent from the Gemini API page.
  If accepted, `style_negative` goes there. If not, it stays concatenated onto
  the positive prompt, where naming a thing risks summoning it.
- **`sampleCount`** — same split. If it is ignored, one call returns one video
  while the ledger bills for N, and the cap silently stops working.

Run `tools/probe.py` before any full generation run. A rejected request is free.

---

## AUDIO AND SILENCE

Veo audio is always on, so **silence is constructed, never requested.**

- `"No music."` in `style_negative` does nothing to the audio track. It is a
  text prompt, not an audio control.
- `crop.py` strips audio (`-an`). `selects/` is therefore silent by construction.
- `assemble.py` lays narration onto known-silent video and enforces the script's
  requirement: **at least 45 seconds of runtime with no audio track at all.**
  It fails loudly if the cut does not meet that, rather than shipping it.

## SHOT 28

Pure black, three seconds. **Generated with ffmpeg, never the API.** It carries a
prompt in `shotlist.json` only so the shot numbering stays intact. `generate.py`
skips it unconditionally. Sending it would cost money to generate a black frame.

## THE API KEY

`GEMINI_API_KEY` comes from the environment. It must never appear in a file, a
commit, a log line, or a chat window. Tools scrub it from exception text before
printing — network errors otherwise stringify the full URL. If a key is ever
pasted into a transcript, it is compromised: rotate it at
https://aistudio.google.com/apikey before doing anything else.

For remote/web sessions, set it as an environment variable on the Claude Code
environment rather than exporting it per session — it then exists for every
session without ever being typed.

## PIPELINE ORDER

```
approve shotlist.json          rule 1
tools/probe.py                 settle negativePrompt / sampleCount  (~$0.80)
tools/generate.py    -> takes/
tools/contact_sheet.py         review on a phone, no video download
tools/select.py      -> selects/ + selects.json   director chooses, rule 2
tools/crop.py                  2.39:1 + grain, audio stripped
tools/assemble.py    -> out/    narration, silence budget, shot 28
```

No tool auto-selects, scores or ranks takes. `select.py` records a human
decision and does nothing else. The director chooses.

## ENVIRONMENT

Containers are ephemeral — `ffmpeg` and `Pillow` are not preinstalled and are
lost when the container is reclaimed:

```
apt-get install -y ffmpeg && pip install Pillow
```

## BUDGET

33 generated shots (28 is ffmpeg) x 4 takes x 8s:

| Tier | Rate | Full run |
|---|---|---|
| **Lite (selected)** | $0.05/s | **$52.80** |
| Fast | $0.10/s | $105.60 |
| Standard | $0.40/s | $422.40 |

Default `--cap` is $100. At Lite that comfortably covers a full run plus
regenerations. Rule 7 still applies.
