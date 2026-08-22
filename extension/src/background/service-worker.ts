chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'start-captioning') return;
  void ensureOffscreenDocument();
});

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({});
  const exists = contexts.some((context) => context.contextType === 'OFFSCREEN_DOCUMENT');
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: 'dist/offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture tab audio for local transcription.',
    });
  }
}
