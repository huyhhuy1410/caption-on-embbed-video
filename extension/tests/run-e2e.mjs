import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extension, '..');
const videoFile = resolve(process.env.CAPTION_E2E_VIDEO ?? join(root, 'test/video1.mp4'));
const output = join(root, '.tmp', 'e2e', new Date().toISOString().replace(/[:.]/g, '-'));
const events = [];
const samples = [];
const packets = [];
let context;
let server;
let page;
let worker;
let captureStarted = false;
let report;
let sampleTimer;
let sampling = false;

function record(kind, data) { events.push({ at: Date.now(), kind, ...data }); }

async function sample(phase) {
  if (sampling || !page || page.isClosed()) return;
  sampling = true;
  try {
    samples.push(await page.evaluate(phase => {
      const video = document.querySelector('video');
      const host = [...document.querySelectorAll('[data-caption-ai-owned]')]
        .find(element => element.shadowRoot?.querySelector('.lines'));
      const shadow = host?.shadowRoot;
      const lines = [...(shadow?.querySelectorAll('.line') ?? [])].map(line => ({
        key: line.getAttribute('data-caption-key'),
        active: line.classList.contains('line-active'),
        words: [...line.querySelectorAll('.line-en span')].map(span => ({
          text: span.textContent.trim(), index: Number(span.getAttribute('data-index')),
          wordId: span.getAttribute('data-word-id'), active: span.classList.contains('word-active'),
        })),
      }));
      return { at: Date.now(), phase, videoTime: video.currentTime, paused: video.paused,
        overlayVisible: Boolean(host && getComputedStyle(host).display !== 'none'), lines };
    }, phase));
  } catch (error) { record('sample-error', { message: String(error) }); }
  finally { sampling = false; }
}

function summarize() {
  const repeats = [];
  const jumps = [];
  const lateHighlights = [];
  const seenRepeats = new Set();
  const lastKeys = [];
  let previous;
  for (const sample of samples) {
    for (const line of sample.lines) {
      for (let i = 1; i < line.words.length; i++) {
        const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const word = normalize(line.words[i].text);
        const key = `${line.key}:${i}:${word}`;
        if (word && word === normalize(line.words[i - 1].text) && !seenRepeats.has(key)) {
          seenRepeats.add(key);
          repeats.push({ phase: sample.phase, videoTime: sample.videoTime, key: line.key,
            text: line.words.map(word => word.text).join(' ') });
        }
      }
    }
    const activeLine = sample.lines.find(line => line.active);
    if (previous && (sample.phase !== previous.phase || sample.videoTime < previous.videoTime)) lastKeys.length = 0;
    if (activeLine && lastKeys.at(-1)?.key !== activeLine.key) {
      lastKeys.push({ key: activeLine.key, time: sample.videoTime });
      if (lastKeys.length > 3) lastKeys.shift();
      if (lastKeys.length === 3 && lastKeys[0].key === lastKeys[2].key) {
        jumps.push({ phase: sample.phase, transitions: [...lastKeys] });
      }
    }
    const activeWord = activeLine?.words.find(word => word.active);
    if (activeWord) {
      const candidates = packets.filter(packet => packet.at <= sample.at).flatMap(packet => packet.words ?? [])
        .filter(word => word.w?.trim() === activeWord.text &&
          (activeWord.wordId ? word.wordId === activeWord.wordId :
            (word.captionId ?? `windowed:${word.captionStart}`) === activeLine.key));
      // Chỉ kết luận khi tất cả timing ứng viên đều đã hết; legacy không có wordId.
      if (candidates.length && candidates.every(word => Number.isFinite(word.videoEnd) && word.videoEnd + 0.15 < sample.videoTime)) {
        lateHighlights.push({ phase: sample.phase, videoTime: sample.videoTime,
          word: activeWord.text, latestEnd: Math.max(...candidates.map(word => word.videoEnd)) });
      }
    }
    previous = sample;
  }
  return { adjacentRepetitionCandidates: repeats, rowBacktrackCandidates: jumps,
    expiredHighlightSamples: lateHighlights.slice(0, 100),
    sampleCount: samples.length, receivedPacketCount: packets.length,
    caveats: ['Adjacent repetitions may be genuine speech; compare against the audio.',
      'Polling can miss sub-200ms transitions.',
      'Windowed arrival timing is not capture-to-render latency.',
      'No mocked capture, transcript, or ASR is used.'] };
}

try {
  const healthResponse = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(5000) });
  const health = await healthResponse.json();
  if (!healthResponse.ok || health.backend !== 'ready' || health.sidecar !== 'ready') {
    throw new Error(`E2E requires ready backend and sidecar: ${JSON.stringify(health)}`);
  }
  if (!existsSync(videoFile)) throw new Error(`Missing speech video: ${videoFile}`);
  const size = (await stat(videoFile)).size;
  await mkdir(output, { recursive: true });
  server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Caption E2E</title>
        <style>body{background:#222;color:white;font:16px system-ui;padding:24px}video{width:720px;max-width:65vw}</style>
        <h1>Caption AI — isolated E2E test</h1>
        <p>On this tab: click the extension toolbar icon, then Turn on Captions. The runner will play and seek automatically.</p>
        <video controls preload="auto" src="/video.mp4"></video></html>`);
      return;
    }
    if (request.url !== '/video.mp4') { response.writeHead(404).end(); return; }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return;
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(videoFile, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(join(output, 'profile'), {
    channel: 'chromium', headless: false, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--mute-audio'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const workerClient = await context.browser().newBrowserCDPSession();
  const targets = await workerClient.send('Target.getTargets');
  record('startup', { health, extensionId, targets: targets.targetInfos.map(target => ({ type: target.type, url: target.url })) });
  await workerClient.detach();
  // Listener quan sát không trả response, không thay đổi dữ liệu hay đường capture.
  await worker.evaluate(() => {
    globalThis.__captionE2EPackets = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message.target === 'service-worker' && ['words', 'replay', 'capture-scope', 'status'].includes(message.type)) {
        globalThis.__captionE2EPackets.push({ at: Date.now(), ...message });
      }
    });
  });
  page = context.pages()[0] ?? await context.newPage();
  page.on('console', message => record('console', { level: message.type(), text: message.text() }));
  page.on('pageerror', error => record('pageerror', { message: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, { timeout: 20000 });
  await page.bringToFront();
  console.log(`E2E_BROWSER_READY: Chromium opened with extension ${extensionId}.`);
  console.log('E2E_CAPTURE_REQUIRED: Click extension toolbar icon -> Turn on Captions on the Caption E2E tab within 120 seconds.');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const captured = await worker.evaluate(() => new Promise(resolve => chrome.tabCapture.getCapturedTabs(resolve)));
    if (captured.some(tab => tab.status === 'active')) { captureStarted = true; break; }
    await page.waitForTimeout(500);
  }
  if (!captureStarted) throw new Error('Capture not activated within 120 seconds; no ASR E2E ran.');
  console.log('E2E_CAPTURE_ACTIVE: Running real playback, then seek back and replay.');
  let phase = 'first-play';
  sampleTimer = setInterval(() => void sample(phase), 200);
  await page.locator('video').evaluate(video => video.play());
  await page.waitForTimeout(25000);
  await sample(phase);
  await page.screenshot({ path: join(output, 'first-play.png') });
  packets.push(...await worker.evaluate(() => globalThis.__captionE2EPackets.splice(0)));
  phase = 'seek-replay';
  record('seek', { target: 2 });
  await page.locator('video').evaluate(async video => {
    video.pause();
    await new Promise(resolve => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = 2; });
    await video.play();
  });
  await page.waitForTimeout(18000);
  await sample(phase);
  await page.screenshot({ path: join(output, 'seek-replay.png') });
  await page.locator('video').evaluate(video => video.pause());
  packets.push(...await worker.evaluate(() => globalThis.__captionE2EPackets.splice(0)));
  const evidence = summarize();
  if (!samples.some(sample => sample.overlayVisible && sample.lines.some(line => line.words.length))) {
    throw new Error('Capture activated but no rendered caption was observed; inspect events and packets.');
  }
  report = { status: 'completed-with-observations', health, ...evidence };
  console.log(`E2E_OBSERVATIONS: samples=${samples.length}, packets=${packets.length}, repetitions=${evidence.adjacentRepetitionCandidates.length}, rowBacktracks=${evidence.rowBacktrackCandidates.length}, expiredHighlights=${evidence.expiredHighlightSamples.length}`);
} catch (error) {
  report = { status: captureStarted ? 'failed' : 'blocked', error: String(error), ...summarize() };
  console.error(`E2E_${report.status.toUpperCase()}: ${error}`);
  process.exitCode = 1;
} finally {
  clearInterval(sampleTimer);
  if (context) {
    try {
      if (captureStarted && worker) {
        await worker.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ type: 'stop-audio-capture', target: 'offscreen' }, () => { void chrome.runtime.lastError; resolve(); })));
      }
    } catch (error) { record('cleanup-error', { message: String(error) }); }
    try { await context.tracing.stop({ path: join(output, 'trace.zip') }); } catch {}
    await context.close();
  }
  if (server) await new Promise(resolve => server.close(resolve));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'observations.json'), JSON.stringify({ report, events, packets, samples }, null, 2));
  console.log(`E2E_EVIDENCE: ${output}`);
}
