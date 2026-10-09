import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/background/service-worker.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
}).outputFiles[0].text;

function harness({ captureError = null, health = { backend: 'ready', sidecar: 'ready', model: 'small', mode: 'streaming' }, healthError = false } = {}) {
  let listener;
  const session = {};
  const sent = [];
  const runtime = {
    id: 'test-extension',
    getURL: path => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: callback => { listener = callback; } },
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async message => { sent.push(message); },
  };
  const chrome = {
    runtime,
    storage: {
      local: { setAccessLevel: async () => {}, set: async () => {} },
      session: {
        get: async key => ({ [key]: session[key] }),
        set: async values => Object.assign(session, values),
        remove: async key => { delete session[key]; },
      },
    },
    action: { onClicked: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 42 }],
      sendMessage: async (tabId, message) => { sent.push({ tabId, ...message }); },
      onRemoved: { addListener() {} },
    },
    tabCapture: { getMediaStreamId: (options, callback) => {
      assert.equal(options.targetTabId, 42);
      runtime.lastError = captureError ? { message: captureError } : undefined;
      callback('stream-42');
      runtime.lastError = undefined;
    } },
  };
  runInNewContext(code, {
    chrome, TextEncoder, AbortSignal,
    fetch: async url => {
      assert.equal(url, 'http://127.0.0.1:8000/health');
      if (healthError) throw new Error('Connection refused');
      return { ok: true, json: async () => health };
    },
    console: { warn() {}, error() {} },
  });
  const popup = { id: runtime.id, url: runtime.getURL('dist/popup/popup.html') };
  const request = (action, sender = popup) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No response')), 1000);
    const held = listener({ action }, sender, response => { clearTimeout(timeout); resolve(response); });
    assert.equal(held, true);
  });
  return { request, sent, popup, listener };
}

test('popup without sender.tab receives status', async () => {
  const h = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(await h.request('caption:status'))), { enabled: false, state: 'Captions off' });
});

test('popup starts actual capture on active tab and stops on second click', async () => {
  const h = harness();
  assert.equal((await h.request('caption:toggle')).enabled, true);
  assert.ok(h.sent.some(message => message.tabId === 42 && message.type === 'capturing'));
  assert.ok(h.sent.some(message => message.type === 'start-audio-capture'));
  assert.equal((await h.request('caption:status')).enabled, true);
  assert.equal((await h.request('caption:toggle')).enabled, false);
  assert.ok(h.sent.some(message => message.tabId === 42 && message.type === 'captions-off'));
});

test('capture failure is returned rather than falsely enabling captions', async () => {
  const h = harness({ captureError: 'Capture permission denied' });
  const response = await h.request('caption:toggle');
  assert.equal(response.enabled, false);
  assert.match(response.error, /Capture permission denied/);
  assert.equal((await h.request('caption:status')).enabled, false);
});

test('popup receives current model and service health without sender.tab', async () => {
  const h = harness();
  const response = await h.request('caption:health');
  assert.equal(response.model, 'small');
  assert.equal(response.mode, 'streaming');
  assert.equal(response.sidecar, 'ready');
});

test('popup health failure returns unavailable rather than closing message port', async () => {
  const h = harness({ healthError: true });
  const response = await h.request('caption:health');
  assert.equal(response.backend, 'unavailable');
  assert.equal(response.sidecar, 'unavailable');
});

test('untrusted sender cannot invoke popup capture controls', () => {
  const h = harness();
  let replied = false;
  assert.equal(h.listener({ action: 'caption:toggle' }, { ...h.popup, id: 'other-extension' }, () => { replied = true; }), undefined);
  assert.equal(replied, false);
  assert.equal(h.sent.length, 0);
});
