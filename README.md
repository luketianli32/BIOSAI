# BIOS AI

A BIOS emulator with an AI tutor. It reads a UEFI firmware image, rebuilds the setup menus from the image's IFR data, renders them in a recreation of the board's GUI, and teaches users what each option does and how to tune it.

## Pipeline

```
Samples/<bios>.bin ─► biosai extract ─► out/<board>/bios_schema.json ─┐
<video>.mp4        ─► biosai.vision.frames ─► out/<board>/video_frames │
boards/<board>/{layout,hardware_profile}.json ────────────────────────┴► biosai bundle ─► app/public/data ─► emulator
```

| Part | Path | What it does |
|---|---|---|
| Firmware walker | `biosai/firmware/fv.py` | Walks firmware volumes, FFS files and sections; decompresses LZMA; handles nested volumes |
| HII scanner | `biosai/firmware/hii.py` | Finds IFR form packages and string packages (all languages) |
| IFR decoder | `biosai/firmware/ifr.py` | Decodes forms, questions, options, defaults, ranges, varstore offsets, and suppress/grayout expressions |
| Schema builder | `biosai/schema/build.py` | Normalizes everything into `bios_schema.json` and evaluates visibility against a hardware profile |
| Video keyframes | `biosai/vision/frames.py` | Extracts each distinct screen from a recording and builds contact sheets |
| Board profile | `boards/<board>/` | `layout.json` (GUI tab mapping) and `hardware_profile.json` (runtime state the BIOS fills in at boot) |
| Emulator | `app/` | Vite + React + TypeScript; keyboard-driven, live show/hide logic, Explain drawer, search, change list |

## Run

```sh
uv sync
uv run python -m biosai extract Samples/Z890EAGLEWIFI7P.F5 -o out/z890-eagle-f5 -p boards/gigabyte-z890-eagle-wifi7/hardware_profile.json
uv run python -m biosai bundle out/z890-eagle-f5/bios_schema.json boards/gigabyte-z890-eagle-wifi7
cd app && pnpm install && pnpm build && cd ..
uv run python -m biosai serve                # app + AI tutor at http://127.0.0.1:8765
```

For frontend development, run `pnpm dev` in `app/` (http://localhost:5173). It proxies `/api` to the server.

## Docker deployment

The Docker build uses the board data bundled in `app/public/data/`. Regenerate
that data with the `bundle` command above when updating the BIOS schema. The
image builds the web UI and runs the API and UI together:

```sh
docker build -t biosai .
docker run --rm -p 8080:8080 -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" biosai
```

The container listens on `0.0.0.0:8080` by default; deployment platforms can
override the port with the `PORT` environment variable. Pass
`ANTHROPIC_API_KEY` at runtime if you want to enable the hosted AI tutor.

**AI tutor:** set `ANTHROPIC_API_KEY` before `biosai serve` to use Claude (`claude-opus-5-5`, with server-side refusal fallback enabled). Without a key, the tutor runs offline and answers from the BIOS's own help text and dependency rules. Answers are grounded in options retrieved from this board's firmware plus `kb/tuning_guide.md`.

Deep links: `?tab=settings&page=tab:settings/p1`, `?tab=tweaker&page=form:4:10843`, `?mode=easy`, and `?set=<item id>=<value>,...` to preset options (e.g. `?tab=tweaker&page=form:4:10870&set=4:10870/1=1` sets Vcore Voltage Mode to Adaptive).

## How dynamic options work

Every show/hide/grey-out rule comes from the firmware's IFR (`suppressif` / `grayoutif` expressions), and the emulator re-evaluates them on every change. Some rules read values the real BIOS fills in at boot from the installed hardware. Those are decoded from the firmware's conditions and driven by the selected parts (`app/src/hardware.ts` → `runtimeOverrides`):

| Varstore | Offset | Meaning |
|---|---|---|
| `ProcMitAttrib` | +0 / +1 | P-core / E-core count (sizes the per-core ratio lists) |
| `MemMitAttrib` | +1, +9, +10, +11 | Kit has a profile / XMP+EXPO / EXPO / XMP (picks the X.M.P. variant) |
| `*MitAttrib`, `SystemAccess` | — | Feature-supported flags; admin access |

The Gigabyte GUI reorders rows across IFR forms. `boards/<board>/layout.json` rebuilds that order from the video using `pick` entries; each picked row automatically brings its dependent sub-options.

## Safety

The emulator never writes firmware. "Save & Exit" produces a change list that the user applies on the real board by hand.
