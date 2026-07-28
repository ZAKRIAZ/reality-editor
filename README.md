# Reality Editor

Hand-gesture AR prototype — select a region of your camera feed and rewrite its rules
(gravity off, freeze time, black hole, ocean, neon city, …). Camera-only; nothing is
recorded or uploaded. Hand tracking runs locally via MediaPipe; effects are a WebGL
warp pipeline over the live feed. Optional voice control ("make this underwater",
"freeze time", "clear").

Imported from the Claude Design project
[`d813b45d-5eab-46ee-9973-96e246185b60`](https://claude.ai/design/p/d813b45d-5eab-46ee-9973-96e246185b60).

## Files

| File | What it is |
|---|---|
| `Reality Editor - Standalone.html` | **The app, single file.** Double-click to open; allow the camera. React/ReactDOM/engine/runtime are inlined (works from `file://`). Needs network only for the MediaPipe hand-tracker + Google Fonts. |
| `Reality Editor.dc.html` | Source design-component document (template + component logic). Runs via `support.js` from a local server. |
| `engine.js` | Core engine: camera, MediaPipe hand tracking, gesture FSM, WebGL effect pipeline, voice (`createRealityEngine` / `createRealityVoice`). |
| `support.js` | Design-component runtime (generated upstream — do not edit). |
| `build-standalone.py` | Rebuilds the standalone from the three files above + `vendor/` React UMDs. |
| `vendor/` | React 18.3.1 UMD builds, pinned to the SRI hashes inside `support.js`. |
| `index.html`, `css/`, `js/` | Older hand-rolled prototype (July 7), kept for reference — not part of the imported app. |

## Run

- **Standalone:** open `Reality Editor - Standalone.html` in Chrome/Edge/Safari, allow the camera.
- **Dev server:** the `.claude/launch.json` config serves this directory; open
  `/Reality%20Editor.dc.html` (or the standalone) from the server root.

## Rebuild the standalone

```sh
python3 build-standalone.py
```

Note: the build sets `window.__resources = {}` before the inlined `support.js`. Without
it, the runtime re-fetches the page source and re-parses it as raw text, where the first
`<x-dc` match lands inside a string literal of the inlined runtime itself and the page
renders mangled JS. Keep that guard if you touch the build. The build also splits the
component's `src="./support.js"` standalone-detection literal so it can't match its own
source (the original bundler ships it JSON-escaped, which has the same effect).

## Gestures

Raise an open hand to summon a zone · spread fingers / use both hands to shape it ·
fist or pinch to lock it · pinch inside to drag · open-palm hold for a new zone ·
fist hold to erase · tap a bottom chip (or use voice) to switch power.
