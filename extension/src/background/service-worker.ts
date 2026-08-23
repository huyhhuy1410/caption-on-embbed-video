chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void startCapture(tab.id).catch((error: unknown) => {
    console.error('Could not start captioning:', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "start-captioning") return;

  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  console.info('Click the Caption AI toolbar icon to grant tab capture access.');
});

async function startCapture(tabId: number) {
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "Could not capture tab audio"));
        return;
      }
      resolve(id);
    });
  });

  await ensureOffscreenDocument();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  chrome.runtime.sendMessage({
    type: "start-audio-capture",
    streamId,
  });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({});
  const exists = contexts.some(
    (context) => context.contextType === "OFFSCREEN_DOCUMENT",
  );

  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "dist/offscreen/offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture tab audio for local transcription.",
    });
  }
}
