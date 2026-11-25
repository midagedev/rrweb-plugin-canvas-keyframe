import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'text/plain' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const origin = `http://localhost:${server.address().port}`;
const RRWEB = `/node_modules/${process.env.RRWEB_PACKAGE ?? 'rrweb'}/dist/rrweb.umd.cjs`;
const PLUGIN = '/dist/index.global.js';

const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal'],
});

const EXPECTED = { a: [255, 0, 0], b: [0, 255, 0], c: [0, 0, 255], d: [255, 255, 0] };
const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 24);
const isCanvasEvent = (e) => e.type === 3 && e.data.source === 9;

async function record(mode) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/test/${mode === 'iframe' ? 'host' : 'scene'}.html`);
  const scene = mode === 'iframe' ? page.frames().find((f) => f.url().endsWith('scene.html')) : page.mainFrame();
  await scene.waitForFunction(() => window.sceneReady);
  if ((await scene.evaluate(() => window.sceneReady)) !== 'ready') return null;

  // The recorder runs in the top page. In iframe mode the canvas lives in the child document.
  await page.addScriptTag({ url: RRWEB });
  await page.addScriptTag({ url: PLUGIN });
  await page.evaluate(() => {
    window.events = [];
    window.sceneWindow = () => document.querySelector('iframe')?.contentWindow ?? window;
    rrweb.record({
      emit: (event) => window.events.push(event),
      plugins: [
        rrwebPluginCanvasKeyframe.getRecordCanvasKeyframePlugin({
          settleMs: 150,
          minIntervalMs: 600,
          heartbeatMs: false,
          requestCoalesceMs: 50,
        }),
      ],
    });
  });
  const labels = () => page.evaluate(() => window.events.filter((e) => e.type === 3 && e.data.source === 9).map((e) => e.data.keyframe.label));
  const waitForLabels = (count) =>
    page.waitForFunction((n) => window.events.filter((e) => e.type === 3 && e.data.source === 9).length >= n, count, { timeout: 4000 });
  const marks = {};
  const mark = async (name) => {
    marks[name] = await page.evaluate(() => Date.now());
  };

  await waitForLabels(1); // 'init': colour a
  await page.waitForTimeout(150);
  await mark('a');

  await scene.evaluate(() => window.setColour('b'));
  await page.evaluate(() => rrwebPluginCanvasKeyframe.requestCanvasKeyframe('colour-b', window.sceneWindow()));
  await waitForLabels(2);
  await page.waitForTimeout(150);
  await mark('b');

  // Input settles -> capture. A burst of input must produce one frame, taken after the last event.
  await scene.evaluate(() => window.setColour('c'));
  for (let i = 0; i < 5; i += 1) {
    await scene.evaluate(() => window.dispatchEvent(new Event('pointerup')));
    await page.waitForTimeout(40);
  }
  await waitForLabels(3);
  await page.waitForTimeout(150);
  await mark('c');

  // Busy: neither a request nor settled input may read the canvas.
  await page.evaluate(() => rrwebPluginCanvasKeyframe.setCanvasKeyframeBusy(true, window.sceneWindow()));
  await scene.evaluate(() => window.setColour('d'));
  await page.evaluate(() => rrwebPluginCanvasKeyframe.requestCanvasKeyframe('while-busy', window.sceneWindow()));
  await scene.evaluate(() => window.dispatchEvent(new Event('pointerup')));
  await page.waitForTimeout(1200);
  const duringBusy = await labels();
  await page.evaluate(() => rrwebPluginCanvasKeyframe.setCanvasKeyframeBusy(false, window.sceneWindow()));
  await page.evaluate(() => rrwebPluginCanvasKeyframe.requestCanvasKeyframe('colour-d', window.sceneWindow()));
  await waitForLabels(4);
  await page.waitForTimeout(150);
  await mark('d');

  const events = await page.evaluate(() => window.events);
  await page.close();
  return { events, marks, duringBusy, errors };
}

async function replay(events, marks) {
  const page = await browser.newPage();
  await page.goto(`${origin}/test/replay.html`);
  await page.addScriptTag({ url: RRWEB });
  await page.evaluate((recorded) => {
    window.replayer = new rrweb.Replayer(recorded, { UNSAFE_replayCanvas: true, mouseTail: false });
    window.seek = (offsetMs) => window.replayer.pause(offsetMs);
    window.pixel = () => {
      const find = (doc) => {
        const canvas = doc.querySelector('canvas');
        if (canvas) return canvas;
        for (const frame of doc.querySelectorAll('iframe')) {
          const nested = frame.contentDocument && find(frame.contentDocument);
          if (nested) return nested;
        }
        return null;
      };
      const canvas = find(window.replayer.iframe.contentDocument);
      if (!canvas) return null;
      const probe = document.createElement('canvas');
      probe.width = canvas.width;
      probe.height = canvas.height;
      const context = probe.getContext('2d');
      context.drawImage(canvas, 0, 0);
      return Array.from(context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3));
    };
  }, events);
  // Playing once lets the Replayer preload every canvas image. Seeking a Replayer that has never
  // played decodes all pending frames concurrently and may draw an older one last (COLD=1 shows it).
  if (process.env.COLD !== '1') {
    await page.evaluate(async () => {
      window.replayer.play();
      await new Promise((r) => setTimeout(r, 800));
      window.replayer.pause();
    });
  }
  const start = events[0].timestamp;
  const seen = {};
  // forward, then backwards, then forwards again
  for (const name of ['b', 'd', 'a', 'c', 'b']) {
    await page.evaluate((t) => window.seek(t), marks[name] - start);
    // The Replayer decodes the frame asynchronously after a seek: wait for it rather than sleep.
    let pixel = null;
    for (let waited = 0; waited < 3000; waited += 50) {
      pixel = await page.evaluate(() => window.pixel());
      if (pixel && near(pixel, EXPECTED[name])) break;
      await page.waitForTimeout(50);
    }
    seen[`${name}@${Object.keys(seen).length}`] = { name, pixel };
  }
  await page.close();
  return seen;
}

let failed = false;
for (const mode of ['top', 'iframe']) {
  const recorded = await record(mode);
  if (!recorded) {
    console.log(`[${mode}] skipped: no WebGPU adapter`);
    continue;
  }
  const canvasEvents = recorded.events.filter(isCanvasEvent);
  const labels = canvasEvents.map((e) => e.data.keyframe.label);
  const bytes = canvasEvents.map((e) => Math.round((JSON.stringify(e).length / 1024) * 10) / 10);
  console.log(`[${mode}] labels`, labels, 'kB', bytes, 'plugin events left', recorded.events.filter((e) => e.type === 6).length);
  try {
    assert.deepEqual(recorded.errors, []);
    assert.deepEqual(labels, ['init', 'colour-b', 'input:settled', 'colour-d']);
    assert.deepEqual(recorded.duringBusy, ['init', 'colour-b', 'input:settled'], 'nothing is captured while busy');
    const seen = await replay(recorded.events, recorded.marks);
    for (const [step, { name, pixel }] of Object.entries(seen)) {
      assert.ok(pixel && near(pixel, EXPECTED[name]), `[${mode}] replay at ${step}: expected ${EXPECTED[name]}, got ${pixel}`);
    }
    console.log(`[${mode}] replay ok`, Object.values(seen).map((s) => `${s.name}:${s.pixel}`).join(' '));
  } catch (error) {
    failed = true;
    console.log(`[${mode}] FAIL`, error.message);
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
