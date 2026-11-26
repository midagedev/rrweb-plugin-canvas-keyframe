// src/index.ts
var PLUGIN_NAME = "rrweb/canvas-keyframe@1";
var REQUEST_EVENT = "rrweb-canvas-keyframe:request";
var BUSY_EVENT = "rrweb-canvas-keyframe:busy";
var EVENT_TYPE_FULL_SNAPSHOT = 2;
var EVENT_TYPE_INCREMENTAL_SNAPSHOT = 3;
var EVENT_TYPE_PLUGIN = 6;
var INCREMENTAL_SOURCE_CANVAS_MUTATION = 9;
var CANVAS_CONTEXT_2D = 0;
var DEFAULTS = {
  selector: "canvas",
  maxEdge: 960,
  type: "image/webp",
  quality: 0.6,
  settleMs: 2e3,
  minIntervalMs: 1e4,
  heartbeatMs: 6e4,
  inputEvents: ["pointerup", "wheel", "keyup"],
  requestCoalesceMs: 500,
  isBusy: void 0,
  useWorker: true
};
function requestCanvasKeyframe(label = "request", target = window) {
  target.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { label } }));
}
function setCanvasKeyframeBusy(busy, target = window) {
  target.dispatchEvent(new CustomEvent(BUSY_EVENT, { detail: { busy } }));
}
var WORKER_SOURCE = `
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
function createEncoder(options) {
  let worker;
  let seq = 0;
  const pending = /* @__PURE__ */ new Map();
  const startWorker = () => {
    if (!options.useWorker || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
    try {
      const started = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })));
      started.onmessage = ({ data }) => {
        const resolve = pending.get(data.seq);
        pending.delete(data.seq);
        resolve?.(data.base64 && data.type ? { type: data.type, base64: data.base64 } : null);
      };
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
  const encodeOnMainThread = (bitmap) => new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
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
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          const comma = dataUrl.indexOf(",");
          resolve(comma < 0 ? null : { type: blob.type, base64: dataUrl.slice(comma + 1) });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      },
      options.type,
      options.quality
    );
  });
  return (bitmap) => {
    if (worker === void 0) worker = startWorker();
    if (!worker) return encodeOnMainThread(bitmap);
    const current = worker;
    return new Promise((resolve) => {
      seq += 1;
      pending.set(seq, resolve);
      current.postMessage({ seq, bitmap, type: options.type, quality: options.quality }, [bitmap]);
    });
  };
}
function getRecordCanvasKeyframePlugin(userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  const encode = createEncoder(options);
  let mirror;
  const lastFrameByCanvas = /* @__PURE__ */ new Map();
  const fullSnapshotListeners = /* @__PURE__ */ new Set();
  const observer = (emit, win) => {
    let busy = false;
    let stopped = false;
    let capturing = false;
    let lastInputCaptureAt = Number.NEGATIVE_INFINITY;
    let settleTimer;
    let requestTimer;
    const readCanvas = async (canvas, label) => {
      const id = mirror?.getId(canvas) ?? -1;
      if (id < 0 || canvas.width === 0 || canvas.height === 0) return;
      const scale = Math.min(1, options.maxEdge / Math.max(canvas.width, canvas.height));
      const bitmap = await win.createImageBitmap(canvas, {
        resizeWidth: Math.max(1, Math.round(canvas.width * scale)),
        resizeHeight: Math.max(1, Math.round(canvas.height * scale)),
        resizeQuality: "low"
      });
      const encoded = await encode(bitmap);
      if (!encoded || stopped || encoded.base64 === lastFrameByCanvas.get(id)) return;
      lastFrameByCanvas.set(id, encoded.base64);
      emit({ id, label, width: canvas.width, height: canvas.height, ...encoded });
    };
    const capture = (label) => {
      if (stopped || capturing) return;
      capturing = true;
      win.setTimeout(() => {
        win.requestAnimationFrame(() => {
          const skip = stopped || busy || win.document.visibilityState !== "visible" || options.isBusy?.(win) === true;
          const canvases = skip ? [] : Array.from(win.document.querySelectorAll(options.selector));
          void Promise.allSettled(canvases.map((canvas) => readCanvas(canvas, label))).then(() => {
            capturing = false;
          });
        });
      }, 0);
    };
    const captureSettled = () => {
      lastInputCaptureAt = Date.now();
      capture("input:settled");
    };
    const onSettle = () => {
      const wait = lastInputCaptureAt + options.minIntervalMs - Date.now();
      if (wait <= 0) captureSettled();
      else settleTimer = setTimeout(captureSettled, wait);
    };
    const onInput = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(onSettle, options.settleMs);
    };
    const onRequest = (event) => {
      const detail = "detail" in event ? event.detail : void 0;
      const label = detail && typeof detail === "object" && "label" in detail && typeof detail.label === "string" ? detail.label : "request";
      clearTimeout(requestTimer);
      requestTimer = setTimeout(() => capture(label), options.requestCoalesceMs);
    };
    const onBusy = (event) => {
      const detail = "detail" in event ? event.detail : void 0;
      busy = Boolean(detail && typeof detail === "object" && "busy" in detail && detail.busy);
    };
    const onFullSnapshot = () => {
      capture("snapshot");
    };
    const listenerOptions = { passive: true, capture: true };
    options.inputEvents.forEach((type) => win.addEventListener(type, onInput, listenerOptions));
    win.addEventListener(REQUEST_EVENT, onRequest);
    win.addEventListener(BUSY_EVENT, onBusy);
    fullSnapshotListeners.add(onFullSnapshot);
    const heartbeat = options.heartbeatMs === false ? void 0 : setInterval(() => capture("heartbeat"), options.heartbeatMs);
    capture("init");
    return () => {
      stopped = true;
      clearTimeout(settleTimer);
      clearTimeout(requestTimer);
      clearInterval(heartbeat);
      options.inputEvents.forEach((type) => win.removeEventListener(type, onInput, listenerOptions));
      win.removeEventListener(REQUEST_EVENT, onRequest);
      win.removeEventListener(BUSY_EVENT, onBusy);
      fullSnapshotListeners.delete(onFullSnapshot);
    };
  };
  const isKeyframePayload = (payload) => Boolean(payload && typeof payload === "object" && "base64" in payload && "id" in payload);
  const eventProcessor = (event) => {
    if (event.type === EVENT_TYPE_FULL_SNAPSHOT) {
      lastFrameByCanvas.clear();
      fullSnapshotListeners.forEach((listener) => listener());
      return event;
    }
    if (event.type !== EVENT_TYPE_PLUGIN) return event;
    const data = event.data;
    if (!data || typeof data !== "object" || !("plugin" in data) || data.plugin !== PLUGIN_NAME) return event;
    const payload = "payload" in data ? data.payload : void 0;
    if (!isKeyframePayload(payload)) return event;
    return {
      ...event,
      type: EVENT_TYPE_INCREMENTAL_SNAPSHOT,
      data: {
        source: INCREMENTAL_SOURCE_CANVAS_MUTATION,
        id: payload.id,
        type: CANVAS_CONTEXT_2D,
        commands: [
          { property: "clearRect", args: [0, 0, payload.width, payload.height] },
          {
            property: "drawImage",
            args: [
              {
                rr_type: "ImageBitmap",
                args: [{ rr_type: "Blob", data: [{ rr_type: "ArrayBuffer", base64: payload.base64 }], type: payload.type }]
              },
              0,
              0,
              payload.width,
              payload.height
            ]
          }
        ],
        keyframe: { label: payload.label }
      }
    };
  };
  return {
    name: PLUGIN_NAME,
    options,
    observer,
    eventProcessor,
    getMirror: ({ nodeMirror }) => {
      mirror = nodeMirror;
    }
  };
}
export {
  PLUGIN_NAME,
  getRecordCanvasKeyframePlugin,
  requestCanvasKeyframe,
  setCanvasKeyframeBusy
};
