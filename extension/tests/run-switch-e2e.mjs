import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extension, '..');
const videoA = resolve(root, 'test/video1.mp4');
const videoB = resolve(root, '.tmp/e2e-assets/video2.mp4');
const output = join(root, '.tmp', 'e2e', `video-switch-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const files = { '/a.mp4': videoA, '/b.mp4': videoB };
const events = [];
const samples = [];
const packets = [];
let context, server, page, worker, timer, captureStarted = false, report;
function record(kind, data = {}) { events.push({ at: Date.now(), kind, ...data }); }
async function sample(phase) {
  try {
    samples.push(await page.evaluate(phase => {
      const host = [...document.querySelectorAll('[data-caption-ai-owned]')].find(e => e.shadowRoot?.querySelector('.lines'));
      const lines = [...(host?.shadowRoot?.querySelectorAll('.line') ?? [])].map(line => ({
        key: line.getAttribute('data-caption-key'), active: line.classList.contains('line-active'),
        text: [...line.querySelectorAll('.line-en span')].map(span => span.textContent.trim()).join(' '),
        activeText: [...line.querySelectorAll('.line-en span.word-active')].map(span => span.textContent.trim()).join(' '),
      }));
      const video = document.querySelector(`#${phase === 'video-a' ? 'a' : 'b'}`);
      return { at: Date.now(), phase, currentTime: video.currentTime, paused: video.paused,
        overlayVisible: Boolean(host && getComputedStyle(host).display !== 'none'), lines };
    }, phase));
  } catch (error) { record('sample-error', { message: String(error) }); }
}
try {
  const response = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(5000) });
  const health = await response.json();
  if (!response.ok || health.backend !== 'ready' || health.sidecar !== 'ready') throw new Error(`Services not ready: ${JSON.stringify(health)}`);
  for (const file of Object.values(files)) if (!existsSync(file)) throw new Error(`Missing test video: ${file}`);
  const sizes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([route, file]) => [route, (await stat(file)).size])));
  await mkdir(output, { recursive: true });
  server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Video switch E2E</title><style>body{font:16px system-ui;background:#222;color:white}video{width:45vw}#b{display:none}</style><h1>Video switch test</h1><p>Click extension toolbar → Turn on Captions. Test automatically plays A, stops it, then plays B.</p><video id="a" controls preload="auto" src="/a.mp4"></video><video id="b" controls preload="auto" src="/b.mp4"></video>`);
      return;
    }
    const size = sizes[req.url], file = files[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(join(output, 'profile'), { channel: 'chromium', headless: false,
    viewport: { width: 1280, height: 800 }, ignoreDefaultArgs: ['--mute-audio'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.tracing.start({ screenshots: true, snapshots: true });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  await worker.evaluate(() => {
    globalThis.__captionSwitchPackets = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message.target === 'service-worker' && ['words', 'replay', 'capture-scope', 'status'].includes(message.type)) globalThis.__captionSwitchPackets.push({ at: Date.now(), ...message });
    });
  });
  page = context.pages()[0] ?? await context.newPage();
  page.on('console', msg => record('console', { level: msg.type(), text: msg.text() }));
  page.on('pageerror', error => record('pageerror', { message: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.readyState >= 2), { timeout: 30000 });
  await page.bringToFront();
  console.log(`E2E_BROWSER_READY: isolated Chromium; extension ${extensionId}.`);
  console.log('E2E_CAPTURE_REQUIRED: Click extension toolbar icon → Turn on Captions on this test tab.');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const tabs = await worker.evaluate(() => new Promise(resolve => chrome.tabCapture.getCapturedTabs(resolve)));
    if (tabs.some(tab => tab.status === 'active')) { captureStarted = true; break; }
    await page.waitForTimeout(500);
  }
  if (!captureStarted) throw new Error('Capture not activated; no real ASR E2E ran.');
  console.log('E2E_CAPTURE_ACTIVE: playing video A, then switching to distinct video B.');
  let phase = 'video-a';
  timer = setInterval(() => void sample(phase), 200);
  await page.locator('#a').evaluate(v => v.play());
  await page.waitForTimeout(22000);
  await sample(phase);
  await page.screenshot({ path: join(output, 'video-a.png') });
  await page.locator('#a').evaluate(v => v.pause());
  await page.locator('#b').evaluate(v => { v.style.display = 'inline'; v.play(); });
  phase = 'video-b';
  record('video-switch', { from: 'A', to: 'B' });
  await page.waitForTimeout(22000);
  await sample(phase);
  await page.screenshot({ path: join(output, 'video-b.png') });
  await page.locator('#b').evaluate(v => v.pause());
  packets.push(...await worker.evaluate(() => globalThis.__captionSwitchPackets.splice(0)));
  const linesByPhase = Object.fromEntries(['video-a', 'video-b'].map(p => [p, [...new Set(samples.filter(s => s.phase === p).flatMap(s => s.lines.map(l => l.text).filter(Boolean)))]]));
  const bTime = Math.min(...samples.filter(s => s.phase === 'video-b').map(s => s.at));
  const bSamples = samples.filter(s => s.phase === 'video-b');
  const aKeys = new Set(samples.filter(s => s.phase === 'video-a').flatMap(s => s.lines.map(l => l.key)));
  const bKeys = new Set(bSamples.flatMap(s => s.lines.map(l => l.key)));
  const inheritedKeys = [...bKeys].filter(key => aKeys.has(key));
  const leakedText = bSamples.filter(s => s.lines.some(l => l.active && linesByPhase['video-a'].includes(l.text))).map(s => ({ at: s.at, time: s.currentTime, active: s.lines.filter(l => l.active).map(l => l.text) }));
  const switchedScope = packets.filter(p => p.type === 'capture-scope' && p.at >= bTime).map(p => ({ sourceId: p.sourceId, generation: p.generation }));
  report = { status: bSamples.length ? 'completed-with-observations' : 'inconclusive', health, sampleCount: samples.length, packetCount: packets.length,
    linesByPhase, sharedCaptionKeys: inheritedKeys, activeOldTextOnB: leakedText, sourceScopesAfterSwitch: switchedScope,
    caveats: ['The two clips have distinct source audio, but tiny ASR can make transcription errors.', '200 ms DOM polling can miss brief flashes.', 'A shared tab audio capture mixes sound only when multiple videos play simultaneously; this test pauses A before starting B.'] };
  console.log(`E2E_SWITCH_RESULT: samples=${samples.length}, packets=${packets.length}, sharedKeys=${inheritedKeys.length}, oldTextOnB=${leakedText.length}, bScopes=${switchedScope.length}`);
} catch (error) {
  report = { status: captureStarted ? 'failed' : 'blocked', error: String(error), sampleCount: samples.length, packetCount: packets.length };
  console.error(`E2E_SWITCH_${report.status.toUpperCase()}: ${error}`); process.exitCode = 1;
} finally {
  clearInterval(timer);
  if (context) {
    try { if (captureStarted && worker) await worker.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ type: 'stop-audio-capture', target: 'offscreen' }, () => { void chrome.runtime.lastError; resolve(); }))); } catch (error) { record('cleanup-error', { message: String(error) }); }
    try { await context.tracing.stop({ path: join(output, 'trace.zip') }); } catch {}
    await context.close();
  }
  if (server) await new Promise(resolve => server.close(resolve));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'observations.json'), JSON.stringify({ report, events, packets, samples }, null, 2));
  console.log(`E2E_SWITCH_EVIDENCE: ${output}`);
}
