import { CaptionFullscreen } from "./fullscreen";
import { CaptionOverlay } from "./overlay";
import { isVisible, VideoPicker } from "./video-picker";
import { WordPopup } from "./word-popup";
import { VideoDiscovery } from "./video-discovery";
import { bindVideoEvents } from "./video-events";
import { CaptionNotice } from "./caption-notice";
import { SourceIdentity } from "./source-identity";
import { sameScope } from "../shared/transcript-state";
import type { CaptionWord, CaptureScope, TranscriptSnapshot } from "../shared/protocol";

let captionEnabled = false;
let languageHidden = false;
let activeVideo: HTMLVideoElement | null = null;
let activeSourceId: string | null = null;
let captureScope: CaptureScope | null = null;
let connected = false;
let userPickedVideo: HTMLVideoElement | null = null;
let overlayFrameId: number | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let healthTimer: ReturnType<typeof setTimeout> | undefined;
let restoreKey = "";
let healthGeneration = 0;
let activeVideoUrl = "";
const overlay = new CaptionOverlay();
const fullscreen = new CaptionFullscreen();
const wordPopup = new WordPopup();
const listeners = new Map<HTMLVideoElement, () => void>();
const sourceIds = new SourceIdentity();

function send(message: object): Promise<any> {
  return chrome.runtime.sendMessage(message);
}

const notice = new CaptionNotice((action, language) => {
  if (action === "hide") languageHidden = true;
  else {
    languageHidden = false;
    if (action === "choose") {
      notice.resetLanguage();
      void send({ type: "source-language", language: language ?? null }).catch(() => {});
    }
  }
  syncVisibility();
});
notice.element.dataset.captionAiOwned = "";
notice.element.hidden = true;
document.body.append(notice.element);
const picker = new VideoPicker(overlay.element, video => {
  userPickedVideo = video;
  reconcile();
});
overlay.setWordPickHandler(pick => void wordPopup.show(pick));

function sourceIdFor(video: HTMLVideoElement): string {
  return sourceIds.forVideo(video, location.origin + location.pathname + location.search);
}

function clock(): object {
  return { videoTime: activeVideo?.currentTime ?? 0, playbackRate: activeVideo?.playbackRate ?? 1,
    seeking: activeVideo?.seeking ?? false,
    playing: Boolean(activeVideo && !activeVideo.paused && !activeVideo.ended && !activeVideo.seeking && activeVideo.readyState >= 3) };
}

function notifySource(): void {
  if (!captionEnabled) return;
  void send({ type: "source-switch", sourceId: activeSourceId, ...clock() }).catch(() => {});
}

function syncVisibility(): void {
  // isVisible check: overlay only shows when video is in viewport, avoiding
  // unnecessary flicker when user scrolls away.
  if (captionEnabled && !languageHidden && activeVideo && (fullscreen.isActive() || isVisible(activeVideo))) overlay.show();
  else overlay.hide();
}

function reposition(): void {
  syncVisibility();
  if (!activeVideo) return;
  if (fullscreen.isActive()) fullscreen.repositionOverlay();
  else if (isVisible(activeVideo)) overlay.position(activeVideo.getBoundingClientRect());
  picker.position(activeVideo.getBoundingClientRect());
}

function updateOverlayNow(): void {
  if (activeVideo) overlay.update(activeVideo.currentTime);
}

function stopOverlayLoop(): void {
  if (overlayFrameId !== null) cancelAnimationFrame(overlayFrameId);
  overlayFrameId = null;
}

function startOverlayLoop(): void {
  if (!captionEnabled || !activeVideo || activeVideo.paused || overlayFrameId !== null) return;
  const tick = (): void => {
    overlayFrameId = null;
    if (!captionEnabled || !activeVideo || activeVideo.paused || activeVideo.readyState < 3) return;
    updateOverlayNow();
    overlayFrameId = requestAnimationFrame(tick);
  };
  overlayFrameId = requestAnimationFrame(tick);
}

function flushSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!activeVideoUrl || !captureScope) return;
  const history = overlay.finalizedHistory();
  if (!history.words.length) return;
  void send({ type: "snapshot-save", url: activeVideoUrl,
    snapshot: { version: 1, savedAt: Date.now(), ...history } }).catch(() => {});
}

function scheduleSave(): void {
  if (saveTimer !== undefined || !activeVideoUrl || !captureScope) return;
  saveTimer = setTimeout(flushSave, 1000);
}

async function restoreSnapshot(): Promise<void> {
  if (!connected || !captureScope || !activeVideoUrl || !activeSourceId) return;
  const url = activeVideoUrl;
  const scope = { ...captureScope };
  const key = `${scope.sessionId}:${scope.generation}:${scope.sourceId}:${url}`;
  if (restoreKey === key) return;
  // Lock before await to prevent parallel loads; release on error.
  restoreKey = key;
  try {
    const result = await send({ type: "snapshot-load", url });
    if (!captureScope || !sameScope(scope, captureScope) || scope.sourceId !== activeSourceId || activeVideoUrl !== url) return;
    const snapshot = result?.snapshot as TranscriptSnapshot | null;
    if (!result?.ok || !snapshot) return;
    // UUID preserves identity across refresh; only remap source and drop metrics from restore history.
    const words = snapshot.words.map(word => ({ ...word, sourceId: scope.sourceId,
      capturedAtEpochMs: undefined }));
    const translations = snapshot.translations.map(item => ({ ...item, sourceId: scope.sourceId }));
    // Backend returns canonical replay; merging at UI first would create two identities for the same history.
    await send({ type: "restore-snapshot", ...scope, words, translations });
  } catch (error) {
    if (restoreKey === key) restoreKey = "";
    console.warn("Caption AI: snapshot restore failed", error);
  }
}

async function pollHealth(generation: number): Promise<void> {
  if (!captionEnabled || generation !== healthGeneration) return;
  try {
    const state = await send({ type: "health-request" });
    if (captionEnabled && generation === healthGeneration) notice.setHealth(state);
  } catch {
    if (captionEnabled && generation === healthGeneration) notice.setHealth({ backend: "unavailable", sidecar: "unavailable" });
  }
  if (captionEnabled && generation === healthGeneration) healthTimer = setTimeout(() => void pollHealth(generation), 3000);
}

function startHealthPolling(): void {
  if (healthTimer !== undefined) clearTimeout(healthTimer);
  healthTimer = undefined;
  void pollHealth(healthGeneration);
}

function stopHealthPolling(): void {
  healthGeneration += 1;
  if (healthTimer !== undefined) clearTimeout(healthTimer);
  healthTimer = undefined;
}

chrome.runtime.onMessage.addListener(message => {
  if (!message) return;
  if (message.type === "capturing") {
    captionEnabled = true;
    languageHidden = false;
    captureScope = null;
    connected = false;
    restoreKey = "";
    overlay.clear();
    notice.resetLanguage();
    notice.element.hidden = false;
    reconcile();
    startHealthPolling();
    return;
  }
  if (message.type === "capture-ready") { notifySource(); return; }
  if (message.type === "capture-scope") {
    if (!captionEnabled || message.sourceId !== activeSourceId || typeof message.sessionId !== "string" || !Number.isSafeInteger(message.generation)) return;
    captureScope = { sessionId: message.sessionId, generation: message.generation, sourceId: message.sourceId };
    overlay.setScope(captureScope);
    void restoreSnapshot();
    return;
  }
  if (message.type === "status") {
    connected = message.state === "connected" ? true : message.state === "disconnected" ? false : connected;
    if (message.state === "connected") void restoreSnapshot();
    if (message.state === "disconnected" || message.state === "error") {
      notice.setHealth({ backend: "unavailable", sidecar: "unavailable", message: message.message });
    }
    return;
  }
  if (message.type === "captions-off") {
    flushSave();
    captionEnabled = false;
    connected = false;
    captureScope = null;
    stopHealthPolling();
    stopOverlayLoop();
    overlay.clear();
    wordPopup.hide();
    fullscreen.dispose();
    notice.element.hidden = true;
    picker.clear();
    syncVisibility();
    return;
  }
  if (!captionEnabled || !captureScope || message.sourceId !== activeSourceId) return;
  // Drop messages missing scope: new path always carries full session/generation.
  if (!sameScope(captureScope, message)) return;
  if ((message.type === "words" || message.type === "replay") && Array.isArray(message.words)) {
    if (message.mode === "streaming") {
      if (!overlay.applyUpdate(message)) return;
    } else if (message.mode === "windowed") {
      if (message.words.some((word: CaptionWord) => word.sourceId !== captureScope!.sourceId) ||
          !overlay.applyWindowedPatch(message)) return;
    } else if (message.type === "replay") overlay.mergeReplay(message.words);
    else return;
    if (Array.isArray(message.translations)) overlay.setTranslations(message.translations);
    if (typeof message.language === "string") notice.observeLanguage(message.language, Number(message.languageProbability), message.voiced === true);
    updateOverlayNow();
    scheduleSave();
  } else if (message.type === "translation" && Number.isFinite(message.captionStart)) {
    overlay.setTranslations([message]);
    scheduleSave();
  }
});

function bind(video: HTMLVideoElement): () => void {
  const active = (handler: () => void): EventListener => () => {
    if (captionEnabled && video === activeVideo) handler();
  };
  const playback = (state: string): void => {
    void send({ type: "playback", state, ...clock() }).catch(() => {});
    updateOverlayNow();
    if (state === "playing") startOverlayLoop();
    else stopOverlayLoop();
  };
  return bindVideoEvents(video, {
    play: () => { reconcile(); if (video === activeVideo && captionEnabled) playback("playing"); },
    playing: active(() => playback("playing")),
    pause: active(() => playback("paused")),
    ended: active(() => playback("ended")),
    // Clock freezes during buffering but tab audio may still play from other sources.
    waiting: active(() => playback("playing")),
    stalled: active(() => playback("playing")),
    seeking: active(() => {
      stopOverlayLoop();
      flushSave();
      void send({ type: "seek", seekTimeAtCapture: video.currentTime }).catch(() => {});
    }),
    seeked: active(() => {
      void send({ type: "playback", state: video.paused ? "paused" : "playing", ...clock() }).catch(() => {});
      updateOverlayNow(); reposition(); startOverlayLoop();
    }),
    ratechange: active(() => {
      void send({ type: "seek", seekTimeAtCapture: video.currentTime }).catch(() => {});
      void send({ type: "video-clock", ...clock() }).catch(() => {});
    }),
    timeupdate: active(() => {
      reconcile(); reposition();
      void send({ type: "video-clock", ...clock() }).catch(() => {});
    }),
    loadedmetadata: () => reconcile(),
    emptied: () => { sourceIds.invalidate(video); reconcile(); },
    loadstart: () => { sourceIds.invalidate(video); reconcile(); },
  });
}

const discovery = new VideoDiscovery(reconcile, element => element.hasAttribute("data-caption-ai-owned"));
function reconcile(): void {
  fullscreen.recoverIfBroken();
  const videos = discovery.videos();
  const found = new Set(videos);
  for (const [video, dispose] of listeners) {
    if (!found.has(video)) { dispose(); listeners.delete(video); }
  }
  for (const video of videos) if (!listeners.has(video)) listeners.set(video, bind(video));
  if (userPickedVideo && !found.has(userPickedVideo)) userPickedVideo = null;
  const next = userPickedVideo ?? videos.find(video => !video.paused && !video.ended) ??
    (activeVideo && found.has(activeVideo) ? activeVideo : null) ?? videos.find(isVisible) ?? videos[0] ?? null;
  const nextSource = next ? sourceIdFor(next) : null;
  if (next !== activeVideo || nextSource !== activeSourceId) {
    stopOverlayLoop();
    activeVideo = next;
    activeSourceId = nextSource;
    // Snapshot tracks durable URL, decoupled from session sourceId.
    activeVideoUrl = next ? (next.currentSrc || next.src) : "";
    captureScope = null;
    restoreKey = "";
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    overlay.clear();
    wordPopup.hide();
    notice.resetLanguage();
    languageHidden = false;
    notifySource();
  }
  if (captionEnabled && activeVideo && !fullscreen.isActive()) fullscreen.setTarget(activeVideo, overlay);
  picker.setVideos(captionEnabled ? videos : []);
  reposition();
  updateOverlayNow();
  startOverlayLoop();
}
discovery.start();
window.addEventListener("scroll", reposition, { capture: true, passive: true });
window.addEventListener("resize", reposition, { passive: true });
window.addEventListener("pagehide", () => {
  discovery.dispose();
  for (const dispose of listeners.values()) dispose();
  listeners.clear();
  stopOverlayLoop();
  if (healthTimer !== undefined) clearTimeout(healthTimer);
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  fullscreen.dispose();
  notice.dispose();
}, { once: true });
