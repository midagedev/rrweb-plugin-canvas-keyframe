declare const PLUGIN_NAME = "rrweb/canvas-keyframe@1";
interface RrwebEvent {
    type: number;
    data: unknown;
    timestamp: number;
}
interface NodeMirror {
    getId(node: Node): number;
}
interface CanvasKeyframeOptions {
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
    /** Input events (listened on the window, capture phase) that count as interaction. */
    inputEvents?: string[];
    /** Requests made with `requestCanvasKeyframe` within this window collapse into the last one. Default 500. */
    requestCoalesceMs?: number;
    /** Extra busy check, called right before a canvas is read. Return true to skip the capture. */
    isBusy?: (win: Window) => boolean;
    /** Encode in a worker when possible. Falls back to the main thread if the worker cannot start. Default true. */
    useWorker?: boolean;
}
interface CanvasKeyframePayload {
    id: number;
    label: string;
    width: number;
    height: number;
    type: string;
    base64: string;
}
type ResolvedOptions = Required<Omit<CanvasKeyframeOptions, 'isBusy'>> & Pick<CanvasKeyframeOptions, 'isBusy'>;
/**
 * Ask the recorder to capture the canvases of `target` now (e.g. "case loaded",
 * "computation finished"). Safe to call when nothing is recording. Pass the
 * iframe's `contentWindow` when the canvas lives in an iframe.
 */
declare function requestCanvasKeyframe(label?: string, target?: Window): void;
/**
 * Tell the recorder that the app in `target` is busy (heavy computation, loading).
 * No canvas is read while busy. Safe to call when nothing is recording.
 */
declare function setCanvasKeyframeBusy(busy: boolean, target?: Window): void;
/**
 * rrweb record plugin for apps that render everything into a canvas.
 *
 * It reads the canvas only when the app is likely idle — after input settles,
 * on an explicit request, or on a slow heartbeat — never while the app reports
 * busy, and emits the frame as a native rrweb canvas event. Replay needs no
 * plugin: use `new Replayer(events, { UNSAFE_replayCanvas: true })`.
 */
declare function getRecordCanvasKeyframePlugin(userOptions?: CanvasKeyframeOptions): {
    name: string;
    options: ResolvedOptions;
    observer: (emit: (payload: CanvasKeyframePayload) => void, win: Window) => (() => void);
    eventProcessor: <T extends RrwebEvent>(event: T) => T;
    getMirror: ({ nodeMirror }: {
        nodeMirror: NodeMirror;
    }) => void;
};

export { type CanvasKeyframeOptions, type CanvasKeyframePayload, PLUGIN_NAME, getRecordCanvasKeyframePlugin, requestCanvasKeyframe, setCanvasKeyframeBusy };
