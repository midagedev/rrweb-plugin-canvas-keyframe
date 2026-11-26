export const PLUGIN_NAME = 'rrweb/canvas-keyframe@1';

const REQUEST_EVENT = 'rrweb-canvas-keyframe:request';
const BUSY_EVENT = 'rrweb-canvas-keyframe:busy';

// rrweb event shapes this plugin reads or writes. Declared here so the plugin
// does not depend on one rrweb version's type package.
const EVENT_TYPE_FULL_SNAPSHOT = 2;
const EVENT_TYPE_INCREMENTAL_SNAPSHOT = 3;
const EVENT_TYPE_PLUGIN = 6;
const INCREMENTAL_SOURCE_CANVAS_MUTATION = 9;
const CANVAS_CONTEXT_2D = 0;

interface RrwebEvent {
  type: number;
  data: unknown;
  timestamp: number;
}

interface NodeMirror {
  getId(node: Node): number;
}

export interface CanvasKeyframeOptions {
  /** Canvases to capture, per recorded document. Default `'canvas'`. */
  selector?: string;
  /** Longest edge of the stored image in px. Larger canvases are downscaled. Default 960. */
  maxEdge?: number;
  /** Image type for the stored frame. Default `'image/webp'`. */
  type?: string;
  /** Encoder quality, 0..1. Default 0.6. */
  quality?: number;
  /** Capture this long after the last input event, i.e. once the user has stopped interacting. Default 2000. */
  settleMs?: number;
  /**
   * Minimum time between input-triggered captures. A capture that falls inside
   * the interval is postponed to its end, not dropped. Default 10000.
   */
  minIntervalMs?: number;
  /** Capture at this interval even without input; identical frames are dropped. `false` disables. Default 60000. */
  heartbeatMs?: number | false;
  /**
   * Input events (listened on the window, capture phase) that count as interaction. A pressed pointer
   * (`pointerdown` until `pointerup`/`pointercancel`) always counts, so a long drag is never captured midway.
   */
  inputEvents?: string[];
  /** Requests made with `requestCanvasKeyframe` within this window collapse into the last one. Default 500. */
  requestCoalesceMs?: number;
  /** Extra busy check, called right before a canvas is read. Return true to skip the capture. */
  isBusy?: (win: Window) => boolean;
  /** Encode in a worker when possible. Falls back to the main thread if the worker cannot start. Default true. */
  useWorker?: boolean;
}

export interface CanvasKeyframePayload {
  id: number;
  label: string;
  width: number;
  height: number;
  type: string;
  base64: string;
}

type ResolvedOptions = Required<Omit<CanvasKeyframeOptions, 'isBusy'>> & Pick<CanvasKeyframeOptions, 'isBusy'>;

const DEFAULTS: ResolvedOptions = {
  selector: 'canvas',
  maxEdge: 960,
  type: 'image/webp',
  quality: 0.6,
  settleMs: 2_000,
  minIntervalMs: 10_000,
  heartbeatMs: 60_000,
  inputEvents: ['pointerup', 'wheel', 'keydown', 'keyup'],
  requestCoalesceMs: 500,
  isBusy: undefined,
  useWorker: true,
};

/**
 * Ask the recorder to capture the canvases of `target` now (e.g. "case loaded",
 * "computation finished"). Safe to call when nothing is recording. Pass the
 * iframe's `contentWindow` when the canvas lives in an iframe.
 */
export function requestCanvasKeyframe(label = 'request', target: Window = window): void {
  target.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { label } }));
}

/**
 * Tell the recorder that the app in `target` is busy (heavy computation, loading).
 * No canvas is read while busy. Safe to call when nothing is recording.
 */
export function setCanvasKeyframeBusy(busy: boolean, target: Window = window): void {
  target.dispatchEvent(new CustomEvent(BUSY_EVENT, { detail: { busy } }));
}

const WORKER_SOURCE = `
  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  onmessage = async ({ data }) => {
    try {
      const canvas = new OffscreenCanvas(data.bitmap.width, data.bitmap.height);
      canvas.getContext('2d').drawImage(data.bitmap, 0, 0);
      data.bitmap.close();
      const blob = await canvas.convertToBlob({ type: data.type, quality: data.quality });
      postMessage({ seq: data.seq, type: blob.type, base64: toBase64(await blob.arrayBuffer()) });
    } catch (error) {
      postMessage({ seq: data.seq, error: String(error) });
    }
  };
`;

interface Encoded {
  type: string;
  base64: string;
}

function createEncoder(options: ResolvedOptions): (bitmap: ImageBitmap) => Promise<Encoded | null> {
  let worker: Worker | null | undefined;
  let seq = 0;
  const pending = new Map<number, (encoded: Encoded | null) => void>();

  const startWorker = (): Worker | null => {
    if (!options.useWorker || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    try {
      const started = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
      started.onmessage = ({ data }: MessageEvent<{ seq: number; type?: string; base64?: string }>) => {
        const resolve = pending.get(data.seq);
        pending.delete(data.seq);
        resolve?.(data.base64 && data.type ? { type: data.type, base64: data.base64 } : null);
      };
      // A worker blocked by CSP fails asynchronously: release waiters and stop using it.
      started.onerror = () => {
        worker = null;
        pending.forEach((resolve) => resolve(null));
        pending.clear();
      };
      return started;
    } catch {
      return null;
    }
  };

  const encodeOnMainThread = (bitmap: ImageBitmap): Promise<Encoded | null> =>
    new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(null);
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = typeof reader.result === 'string' ? reader.result : '';
            const comma = dataUrl.indexOf(',');
            resolve(comma < 0 ? null : { type: blob.type, base64: dataUrl.slice(comma + 1) });
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        },
        options.type,
        options.quality,
      );
    });

  return (bitmap) => {
    if (worker === undefined) worker = startWorker();
    if (!worker) return encodeOnMainThread(bitmap);
    const current = worker;
    return new Promise((resolve) => {
      seq += 1;
      pending.set(seq, resolve);
      current.postMessage({ seq, bitmap, type: options.type, quality: options.quality }, [bitmap]);
    });
  };
}

/**
 * rrweb record plugin for apps that render everything into a canvas.
 *
 * It reads the canvas only when the app is likely idle — after input settles,
 * on an explicit request, or on a slow heartbeat — never while the app reports
 * busy, and emits the frame as a native rrweb canvas event. Replay needs no
 * plugin: use `new Replayer(events, { UNSAFE_replayCanvas: true })`.
 */
export function getRecordCanvasKeyframePlugin(userOptions: CanvasKeyframeOptions = {}) {
  const options: ResolvedOptions = { ...DEFAULTS, ...userOptions };
  const encode = createEncoder(options);
  let mirror: NodeMirror | undefined;
  const lastFrameByCanvas = new Map<number, string>();
  const fullSnapshotListeners = new Set<() => void>();

  const observer = (emit: (payload: CanvasKeyframePayload) => void, win: Window): (() => void) => {
    let busy = false;
    let stopped = false;
    let capturing = false;
    let lastInputCaptureAt = Number.NEGATIVE_INFINITY;
    let lastInputAt = Number.NEGATIVE_INFINITY;
    let pressed = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;

    const readCanvas = async (canvas: HTMLCanvasElement, label: string): Promise<void> => {
      const id = mirror?.getId(canvas) ?? -1;
      if (id < 0 || canvas.width === 0 || canvas.height === 0) return;
      const scale = Math.min(1, options.maxEdge / Math.max(canvas.width, canvas.height));
      const bitmap = await win.createImageBitmap(canvas, {
        resizeWidth: Math.max(1, Math.round(canvas.width * scale)),
        resizeHeight: Math.max(1, Math.round(canvas.height * scale)),
        resizeQuality: 'low',
      });
      const encoded = await encode(bitmap);
      if (!encoded || stopped || encoded.base64 === lastFrameByCanvas.get(id)) return;
      lastFrameByCanvas.set(id, encoded.base64);
      emit({ id, label, width: canvas.width, height: canvas.height, ...encoded });
    };

    const capture = (label: string): void => {
      if (stopped || capturing) return;
      capturing = true;
      // A WebGPU (and non-preserved WebGL) canvas only holds its image between
      // the app's draw and the end of that frame. A rAF callback queued from a
      // task runs after the app's already-registered render callback.
      win.setTimeout(() => {
        win.requestAnimationFrame(() => {
          const skip = stopped || busy || win.document.visibilityState !== 'visible' || options.isBusy?.(win) === true;
          const canvases = skip ? [] : Array.from(win.document.querySelectorAll<HTMLCanvasElement>(options.selector));
          void Promise.allSettled(canvases.map((canvas) => readCanvas(canvas, label))).then(() => {
            capturing = false;
          });
        });
      }, 0);
    };

    const captureSettled = (): void => {
      lastInputCaptureAt = Date.now();
      capture('input:settled');
    };
    const onSettle = (): void => {
      const wait = lastInputCaptureAt + options.minIntervalMs - Date.now();
      if (wait <= 0) captureSettled();
      else settleTimer = setTimeout(captureSettled, wait);
    };
    const onInput = (): void => {
      lastInputAt = Date.now();
      clearTimeout(settleTimer);
      settleTimer = pressed ? undefined : setTimeout(onSettle, options.settleMs);
    };
    const onPress = (): void => {
      pressed = true;
      onInput();
    };
    const onRelease = (): void => {
      pressed = false;
      onInput();
    };
    // The user is mid-gesture: a heartbeat now would read the canvas while the app is busiest.
    const onHeartbeat = (): void => {
      if (pressed || Date.now() - lastInputAt < options.settleMs) return;
      capture('heartbeat');
    };
    const onRequest = (event: Event): void => {
      const detail: unknown = 'detail' in event ? event.detail : undefined;
      const label =
        detail && typeof detail === 'object' && 'label' in detail && typeof detail.label === 'string'
          ? detail.label
          : 'request';
      clearTimeout(requestTimer);
      requestTimer = setTimeout(() => capture(label), options.requestCoalesceMs);
    };
    const onBusy = (event: Event): void => {
      const detail: unknown = 'detail' in event ? event.detail : undefined;
      busy = Boolean(detail && typeof detail === 'object' && 'busy' in detail && detail.busy);
    };
    const onFullSnapshot = (): void => {
      // A full snapshot rebuilds the replay DOM with empty canvases; send the current frame again.
      capture('snapshot');
    };

    const listenerOptions = { passive: true, capture: true };
    options.inputEvents.forEach((type) => win.addEventListener(type, onInput, listenerOptions));
    win.addEventListener('pointerdown', onPress, listenerOptions);
    win.addEventListener('pointerup', onRelease, listenerOptions);
    win.addEventListener('pointercancel', onRelease, listenerOptions);
    win.addEventListener(REQUEST_EVENT, onRequest);
    win.addEventListener(BUSY_EVENT, onBusy);
    fullSnapshotListeners.add(onFullSnapshot);
    const heartbeat =
      options.heartbeatMs === false ? undefined : setInterval(onHeartbeat, options.heartbeatMs);
    capture('init');

    return () => {
      stopped = true;
      clearTimeout(settleTimer);
      clearTimeout(requestTimer);
      clearInterval(heartbeat);
      options.inputEvents.forEach((type) => win.removeEventListener(type, onInput, listenerOptions));
      win.removeEventListener('pointerdown', onPress, listenerOptions);
      win.removeEventListener('pointerup', onRelease, listenerOptions);
      win.removeEventListener('pointercancel', onRelease, listenerOptions);
      win.removeEventListener(REQUEST_EVENT, onRequest);
      win.removeEventListener(BUSY_EVENT, onBusy);
      fullSnapshotListeners.delete(onFullSnapshot);
    };
  };

  const isKeyframePayload = (payload: unknown): payload is CanvasKeyframePayload =>
    Boolean(payload && typeof payload === 'object' && 'base64' in payload && 'id' in payload);

  const eventProcessor = <T extends RrwebEvent>(event: T): T => {
    if (event.type === EVENT_TYPE_FULL_SNAPSHOT) {
      lastFrameByCanvas.clear();
      fullSnapshotListeners.forEach((listener) => listener());
      return event;
    }
    if (event.type !== EVENT_TYPE_PLUGIN) return event;
    const data = event.data;
    if (!data || typeof data !== 'object' || !('plugin' in data) || data.plugin !== PLUGIN_NAME) return event;
    const payload: unknown = 'payload' in data ? data.payload : undefined;
    if (!isKeyframePayload(payload)) return event;
    // Same shape rrweb's own canvas FPS snapshot emits, so the stock Replayer
    // draws it — including while seeking. `keyframe` is extra metadata.
    return {
      ...event,
      type: EVENT_TYPE_INCREMENTAL_SNAPSHOT,
      data: {
        source: INCREMENTAL_SOURCE_CANVAS_MUTATION,
        id: payload.id,
        type: CANVAS_CONTEXT_2D,
        commands: [
          { property: 'clearRect', args: [0, 0, payload.width, payload.height] },
          {
            property: 'drawImage',
            args: [
              {
                rr_type: 'ImageBitmap',
                args: [{ rr_type: 'Blob', data: [{ rr_type: 'ArrayBuffer', base64: payload.base64 }], type: payload.type }],
              },
              0,
              0,
              payload.width,
              payload.height,
            ],
          },
        ],
        keyframe: { label: payload.label },
      },
    };
  };

  return {
    name: PLUGIN_NAME,
    options,
    observer,
    eventProcessor,
    getMirror: ({ nodeMirror }: { nodeMirror: NodeMirror }) => {
      mirror = nodeMirror;
    },
  };
}
