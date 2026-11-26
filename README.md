# rrweb-plugin-canvas-keyframe

An [rrweb](https://github.com/rrweb-io/rrweb) record plugin for apps that render **everything** into a canvas —
WebGPU / WebGL / wasm editors, CAD tools, games. For those apps rrweb's DOM recording is an empty rectangle.

This plugin stores a downscaled picture of the canvas, but only at moments when reading it will not get in the
app's way:

- after the user **stops interacting** (input settles), rate-limited — a capture that falls inside the minimum
  interval is postponed, not dropped;
- when the **app asks** (`requestCanvasKeyframe('case loaded')`), with bursts collapsed into one;
- on a slow **heartbeat**, dropped if the picture did not change;
- **never while the app says it is busy** (`setCanvasKeyframeBusy(true)`), and never while the tab is hidden.

Frames are emitted as native rrweb canvas events, so **replay needs no plugin**.

## Install

```bash
npm install rrweb-plugin-canvas-keyframe
```

Without a bundler, `https://unpkg.com/rrweb-plugin-canvas-keyframe` exposes `window.rrwebPluginCanvasKeyframe`.

## Use

```ts
import { record } from 'rrweb';
import { getRecordCanvasKeyframePlugin, requestCanvasKeyframe, setCanvasKeyframeBusy } from 'rrweb-plugin-canvas-keyframe';

record({
  emit,
  plugins: [getRecordCanvasKeyframePlugin({ maxEdge: 960 })],
  // leave rrweb's own `recordCanvas` off: this plugin replaces it
});

// anywhere in the app — no shared instance needed, these are window events
requestCanvasKeyframe('case loaded');
setCanvasKeyframeBusy(true); // heavy computation starts
setCanvasKeyframeBusy(false);
requestCanvasKeyframe('computation finished');
```

When the canvas lives in a same-origin iframe and the recorder runs in the parent, pass the iframe's window:
`requestCanvasKeyframe('case loaded', iframe.contentWindow)`.

Replay:

```ts
new Replayer(events, { UNSAFE_replayCanvas: true });
```

Each frame carries its trigger in `event.data.keyframe.label` (`init`, `input:settled`, `heartbeat`, `snapshot`,
or the label you passed).

## Options

| option | default | |
|---|---|---|
| `selector` | `'canvas'` | canvases to capture, per recorded document |
| `maxEdge` | `960` | longest edge of the stored image, px |
| `type` / `quality` | `'image/webp'` / `0.6` | stored image format |
| `settleMs` | `2000` | capture this long after the last input event |
| `minIntervalMs` | `10000` | minimum time between input-triggered captures |
| `heartbeatMs` | `60000` | `false` to disable |
| `inputEvents` | `pointerup`, `wheel`, `keyup` | listened on the window, capture phase |
| `requestCoalesceMs` | `500` | requests within this window collapse into the last |
| `isBusy` | — | extra check called right before a canvas is read |
| `useWorker` | `true` | encode in a worker; falls back to the main thread (e.g. CSP blocks blob workers) |

## How it differs from rrweb's `recordCanvas` + `sampling.canvas`

rrweb's built-in mode samples at a fixed rate (reads the canvas up to N times per second, whether or not the app
is busy) and stores full-size frames. This plugin decides **when** to read from input and app signals, downscales
before encoding, and skips entirely while the app is busy. It also reads WebGPU canvases correctly regardless of
which `requestAnimationFrame` loop was registered first
([rrweb#2034](https://github.com/rrweb-io/rrweb/pull/2034) fixes that in rrweb itself).

It does not record the motion *during* an interaction — only the settled result.

## Cost

Measured with `createImageBitmap(canvas, { resize… })` → worker encode on a 1920×1080 WebGPU canvas
(Chrome 158, Apple silicon, a full-screen animated shader):

| | main-thread time in the frame | longest frame gap | stored size |
|---|---|---|---|
| no capture | — | 16.7 ms | — |
| 960 px WebP | 0.1 ms | 16.7 ms | 28 kB |
| 640 px WebP | 0.1 ms | 16.7 ms | 18 kB |
| 960 px JPEG | 0.1 ms | 16.7 ms | 43 kB |

For comparison, a main-thread `drawImage` downscale + `toBlob` took 1.3–1.6 ms in the frame. These numbers come
from a fast GPU and a light scene; a GPU-bound app or a machine without a GPU will be slower, which is why the
plugin avoids capturing during interaction and computation at all.

## Known limits

- Tested with rrweb 2.2.2 and 2.1.6, Chrome only.
- Seeking a `Replayer` that has never played can show an older frame: rrweb decodes all pending canvas frames
  concurrently and the last one to finish wins. Players that start by playing (or call `play()` once) preload the
  images and are not affected. `COLD=1 npm test` reproduces it
  ([rrweb#2035](https://github.com/rrweb-io/rrweb/pull/2035) fixes that in rrweb itself).
- Cross-origin iframes are not covered.
- The canvas must be part of rrweb's snapshot (not blocked) to get a node id.

## Develop

```bash
npm install
npm test                               # builds, then records and replays a WebGPU scene in Chrome
RRWEB_PACKAGE=rrweb-2-1-6 npm test     # same against rrweb 2.1.6
```

The test records a WebGPU canvas (top-level and inside an iframe), checks that exactly the expected frames are
captured — including none while busy — then replays and seeks forwards, backwards and forwards again.
