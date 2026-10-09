import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/popup/popup.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
}).outputFiles[0].text;

function harness() {
  const elements = new Map();
  for (const id of ['toggle', 'service-state', 'info', 'model-info', 'model-detail']) {
    elements.set(id, {
      hidden: id === 'model-info', textContent: '', disabled: false,
      attributes: {}, handlers: {},
      addEventListener(event, callback) { this.handlers[event] = callback; },
      setAttribute(key, value) { this.attributes[key] = value; },
    });
  }
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  const pageHandlers = {};
  const runtime = {
    sendMessage(message, callback) { requests.push({ message, callback }); },
    lastError: undefined,
  };
  runInNewContext(code, {
    chrome: { runtime },
    document: { getElementById: id => elements.get(id) },
    window: { addEventListener: (event, callback) => { pageHandlers[event] = callback; } },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => { timers.delete(id); },
  });
  return { elements, requests, timers, runtime, pageHandlers };
}

test('service info renders live health and polls only while expanded', () => {
  const h = harness();
  const info = h.elements.get('info');
  info.handlers.click();
  assert.equal(h.requests.at(-1).message.action, 'caption:health');
  h.requests.at(-1).callback({ backend: 'ready', sidecar: 'loading', model: 'medium', mode: 'streaming' });
  assert.match(h.elements.get('model-detail').textContent, /Sidecar: loading.*Model: medium.*Mode: streaming/);
  assert.equal(h.timers.size, 1);
  const poll = h.timers.values().next().value;
  h.timers.clear();
  poll();
  h.requests.at(-1).callback({ backend: 'ready', sidecar: 'ready', model: 'medium', mode: 'streaming' });
  assert.match(h.elements.get('model-detail').textContent, /Sidecar: ready/);
  info.handlers.click();
  assert.equal(h.timers.size, 0);
  assert.equal(h.elements.get('model-info').hidden, true);
});

test('rapid close and reopen ignores stale health response', () => {
  const h = harness();
  const click = h.elements.get('info').handlers.click;
  click();
  const old = h.requests.at(-1).callback;
  click();
  click();
  h.requests.at(-1).callback({ backend: 'ready', sidecar: 'ready', model: 'small' });
  old({ backend: 'unavailable', sidecar: 'unavailable' });
  assert.match(h.elements.get('model-detail').textContent, /Model: small/);
  assert.equal(h.timers.size, 1);
});

test('failed capture response shows error without false enabled label', () => {
  const h = harness();
  h.requests[0].callback({ enabled: false, state: 'Captions off' });
  h.elements.get('toggle').handlers.click();
  h.requests.at(-1).callback({ enabled: false, error: 'Capture permission denied' });
  assert.equal(h.elements.get('toggle').textContent, 'Turn on Captions');
  assert.equal(h.elements.get('toggle').disabled, false);
  assert.match(h.elements.get('service-state').textContent, /Capture permission denied/);
});
