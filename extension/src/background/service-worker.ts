import { SnapshotStore } from "../shared/snapshot-store";
import { serializeTranscript } from "../content/transcript-export";
import type { HealthState } from "../shared/protocol";

const SESSION_KEY = "captionSession";
const LAST_TAB_KEY = "lastCaptionTab";
const BACKEND_URL = "http://127.0.0.1:8000";
const snapshots = new SnapshotStore();
// Snapshots are SW-only; content scripts don't get full storage access.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void storageReady.catch(error => console.warn("Caption AI: storage access restriction failed", error));
type CaptionSession = { tabId: number };
type ExplainResult =
  | { ok: true; explanation: unknown }
  | { ok: false; kind: "throttled"; retryAfterMs: number }
  | { ok: false; kind: "unavailable" }
  | { ok: false; kind: "error"; message: string };

async function requestExplanation(word: string, context: string): Promise<ExplainResult> {
  try {
    const response = await fetch(`${BACKEND_URL}/explain-word`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word, context, lang: "vi" }), signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429) {
      const body = await response.json();
      return { ok: false, kind: "throttled", retryAfterMs: Number(body.retryAfterMs) || 0 };
    }
    if (response.status === 503) return { ok: false, kind: "unavailable" };
    if (!response.ok) return { ok: false, kind: "error", message: `HTTP ${response.status}` };
    return { ok: true, explanation: await response.json() };
  } catch (error) {
    return { ok: false, kind: "error", message: String(error) };
  }
}

async function readSession(): Promise<CaptionSession | undefined> {
  const value = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  return value && Number.isInteger(value.tabId) ? value : undefined;
}

// `captions-off` clears session before content script flushes snapshot, so the
// captured tab must still be allowed to write. Only trust tabs the SW itself recorded.
async function readTrustedTabId(senderTabId: number): Promise<boolean> {
  const value = (await chrome.storage.session.get(LAST_TAB_KEY))[LAST_TAB_KEY];
  return Number.isInteger(value) && value === senderTabId;
}

async function requestHealth(): Promise<HealthState> {
  try {
    const response = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    if (state.backend !== "ready" || !["ready", "loading", "error", "unavailable"].includes(state.sidecar)) {
      throw new Error("Invalid health response");
    }
    return state;
  } catch {
    return { backend: "unavailable", sidecar: "unavailable" };
  }
}

function toOffscreen(message: object): Promise<unknown> {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

// Toolbar click is the only gesture that grants activeTab for tabCapture.
let toggles: Promise<void> = Promise.resolve();
chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  toggles = toggles.then(async () => {
    const session = await readSession();
    if (session) await stopCapture(session.tabId);
    if (session?.tabId !== tabId) await startCapture(tabId);
  }).catch(error => console.error("Caption AI: capture toggle failed", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") return;
  if (message.target === "service-worker") {
    if (sender.tab || sender.url !== chrome.runtime.getURL("dist/offscreen/offscreen.html")) return;
    void readSession().then(async session => {
      if (!session) return;
      if (!["words", "replay", "translation", "capture-scope", "capture-ready", "status", "error"].includes(message.type)) return;
      await chrome.tabs.sendMessage(session.tabId, message).catch(() => {});
    });
    return;
  }
  // Popup has no sender.tab; handle before the content-script guard.
  const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("dist/popup/popup.html");
  if (fromPopup && message.action === "caption:toggle") {
    toggles = toggles.then(async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) throw new Error("No active tab");
        const session = await readSession();
        if (session?.tabId === tab.id) {
          await stopCapture(tab.id);
          await chrome.storage.local.set({ captionEnabled: false });
          sendResponse({ enabled: false });
        } else {
          if (session) await stopCapture(session.tabId);
          await startCapture(tab.id);
          await chrome.storage.local.set({ captionEnabled: true });
          sendResponse({ enabled: true });
        }
      } catch (error) {
        console.error("Caption AI: popup capture toggle failed", error);
        sendResponse({ enabled: false, error: String(error) });
      }
    });
    return true;
  }
  if (fromPopup && message.action === "caption:status") {
    void readSession()
      .then(session => sendResponse({ enabled: Boolean(session), state: session ? "Captions on" : "Captions off" }))
      .catch(error => sendResponse({ state: "Unavailable", error: String(error) }));
    return true;
  }
  if (fromPopup && message.action === "caption:health") {
    void requestHealth().then(sendResponse);
    return true;
  }
  // Only accept control from the capture tab's top frame; other tabs can't change source/clock.
  if (!sender.tab?.id || (sender.frameId ?? 0) !== 0) return;
  if (message.type === "explain-popup-request") {
    void requestExplanation(String(message.word ?? ""), String(message.context ?? "")).then(sendResponse);
    return true;
  }
  if (message.type === "health-request") {
    void requestHealth().then(sendResponse);
    return true;
  }
  const controls = ["video-clock", "source-switch", "seek", "source-language", "playback", "restore-snapshot"];
  const requests = ["snapshot-load", "snapshot-save", "export-transcript"];
  if (!controls.includes(message.type) && !requests.includes(message.type)) return;
  void (async () => {
    const session = await readSession();
    const senderTabId = sender.tab!.id!;
    if (session?.tabId !== senderTabId) {
      // Only exception is snapshot-save after session closed; other requests
      // from other tabs stay blocked as usual.
      if (message.type !== "snapshot-save" || !(await readTrustedTabId(senderTabId))) {
        throw new Error("No active capture for this tab");
      }
    }
    if (controls.includes(message.type)) {
      await toOffscreen(message);
      return { ok: true };
    }
    await storageReady;
    if (typeof message.url !== "string" || !message.url) throw new Error("Missing snapshot url");
    if (message.type === "snapshot-load") return { ok: true, snapshot: await snapshots.load(message.url) };
    if (message.type === "snapshot-save") {
      await snapshots.save(message.url, message.snapshot);
      return { ok: true };
    }
    if (!["srt", "vtt", "txt"].includes(message.format)) throw new Error("Invalid export format");
    const text = serializeTranscript(message.format, message.words, message.translations);
    if (text.length > 4 * 1024 * 1024) throw new Error("Export exceeds size limit");
    const id = await chrome.downloads.download({
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
      filename: `caption-ai.${message.format}`, saveAs: true,
    });
    return { ok: true, downloadId: id };
  })().then(sendResponse).catch(error => sendResponse({ ok: false, message: String(error) }));
  return true;
});

async function startCapture(tabId: number): Promise<void> {
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? "Could not capture tab audio"));
      else resolve(id);
    });
  });
  await ensureOffscreenDocument();
  await chrome.storage.session.set({ [SESSION_KEY]: { tabId }, [LAST_TAB_KEY]: tabId });
  try {
    await chrome.tabs.sendMessage(tabId, { type: "capturing" });
    await toOffscreen({ type: "start-audio-capture", streamId });
  } catch (error) {
    await stopCapture(tabId);
    throw error;
  }
}

async function stopCapture(tabId: number): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
  await toOffscreen({ type: "stop-audio-capture" }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { type: "captions-off" }).catch(() => {});
}

chrome.tabs.onRemoved.addListener(tabId => {
  void readSession().then(session => {
    if (session?.tabId === tabId) return stopCapture(tabId);
  });
});

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({});
  if (!contexts.some(context => context.contextType === "OFFSCREEN_DOCUMENT")) {
    await chrome.offscreen.createDocument({
      url: "dist/offscreen/offscreen.html", reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture tab audio for local transcription.",
    });
  }
}
