/** Media events không nhất thiết composed; bind trực tiếp thay vì delegation qua document. */
export function bindVideoEvents(
  video: HTMLVideoElement,
  handlers: Partial<Record<string, EventListener>>,
): () => void {
  const bindings = Object.entries(handlers).filter(
    (entry): entry is [string, EventListener] => typeof entry[1] === "function",
  );
  for (const [name, handler] of bindings) video.addEventListener(name, handler);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [name, handler] of bindings) video.removeEventListener(name, handler);
  };
}
