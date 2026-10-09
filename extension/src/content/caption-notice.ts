import type { HealthState } from "../shared/protocol";
import { LanguageEvidence } from "./language-evidence";

export type LanguageAction = "hide" | "continue" | "choose";

// Whisper multilingual hỗ trợ các mã này; không đưa tên hiển thị vào source-language control.
export const SOURCE_LANGUAGES = [
  ["en", "English"],
  ["vi", "Vietnamese"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["fr", "French"],
  ["de", "German"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["th", "Thai"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["tr", "Turkish"],
  ["sv", "Swedish"],
] as const;

export class CaptionNotice {
  readonly element: HTMLElement;
  private readonly health: HTMLElement;
  private readonly healthTitle: HTMLElement;
  private readonly healthDetails: HTMLElement;
  private readonly healthMessage: HTMLElement;
  private readonly startHint: HTMLElement;
  private readonly languageNotice: HTMLElement;
  private readonly languageMessage: HTMLElement;
  private readonly chooser: HTMLElement;
  private readonly chooseButton: HTMLButtonElement;
  private readonly select: HTMLSelectElement;
  private readonly listeners = new AbortController();
  private readonly evidence = new LanguageEvidence();
  private dismissed = false;
  private disposed = false;
  private lastHealth = "";

  constructor(
    private readonly onLanguageAction: (
      action: LanguageAction,
      language?: string,
    ) => void,
  ) {
    this.element = document.createElement("div");
    this.element.dataset.captionNotice = "";
    this.element.tabIndex = -1;
    const root = this.element.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;
          width: 360px; max-width: calc(100vw - 32px); font: 14px/1.5 system-ui, sans-serif;
          color: #f4f4f5; pointer-events: none; color-scheme: dark; }
        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }
        section { padding: 12px; margin-bottom: 8px; border: 1px solid #71717a;
          border-radius: 8px; background: #18181b; pointer-events: auto; overflow-wrap: anywhere; }
        p { margin: 0 0 8px; } p:last-child { margin-bottom: 0; }
        .details { color: #d4d4d8; font-size: 12px; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; }
        button, select { font: inherit; color: inherit; background: #27272a; border: 1px solid #a1a1aa;
          border-radius: 4px; padding: 6px 8px; max-width: 100%; }
        button { cursor: pointer; } button:hover { background: #3f3f46; }
        button:focus-visible, select:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
        label { display: block; margin: 8px 0 4px; }
        form .actions { margin-top: 8px; }
        code { white-space: pre-wrap; font: 12px/1.5 ui-monospace, monospace; }
      </style>
      <section id="health" aria-label="Caption service status" tabindex="-1">
        <p id="health-title" role="status" aria-live="polite" aria-atomic="true"></p>
        <p id="health-details" class="details" hidden></p>
        <p id="health-message" hidden></p>
        <p id="start-hint" hidden></p>
      </section>
      <section id="language" aria-label="Source language notice" hidden>
        <p id="language-message" role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="actions">
          <button type="button" id="hide">Hide captions</button>
          <button type="button" id="continue">Continue anyway</button>
          <button type="button" id="choose" aria-expanded="false" aria-controls="chooser">Choose source language</button>
        </div>
        <form id="chooser" hidden>
          <label for="source-language">Source language</label>
          <select id="source-language"><option value="">Auto-detect</option></select>
          <div class="actions">
            <button type="submit">Apply language</button>
            <button type="button" id="cancel">Cancel</button>
          </div>
        </form>
      </section>`;
    const get = <T extends HTMLElement>(id: string): T =>
      root.getElementById(id) as T;
    this.health = get("health");
    this.healthTitle = get("health-title");
    this.healthDetails = get("health-details");
    this.healthMessage = get("health-message");
    this.startHint = get("start-hint");
    this.languageNotice = get("language");
    this.languageMessage = get("language-message");
    this.chooser = get("chooser");
    this.chooseButton = get("choose");
    this.select = get("source-language");
    for (const [code, name] of SOURCE_LANGUAGES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      this.select.append(option);
    }
    const options = { signal: this.listeners.signal };
    get("hide").addEventListener("click", () => this.act("hide"), options);
    get("continue").addEventListener(
      "click",
      () => this.act("continue"),
      options,
    );
    this.chooseButton.addEventListener(
      "click",
      () => {
        this.chooser.hidden = false;
        this.chooseButton.setAttribute("aria-expanded", "true");
        this.select.focus();
      },
      options,
    );
    get("cancel").addEventListener("click", () => this.closeChooser(), options);
    this.chooser.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.closeChooser();
        }
      },
      options,
    );
    this.chooser.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const language = this.select.value;
        if (language && !SOURCE_LANGUAGES.some(([code]) => code === language))
          return;
        // API frozen dùng undefined cho Auto; integrator chuyển thành null trên wire.
        this.act("choose", language || undefined);
      },
      options,
    );
    this.healthTitle.textContent = "Checking caption services…";
    // Thẻ trạng thái chiếm góc phải trên và chặn nút fixed của trang; giữ cảnh báo ngôn ngữ riêng.
    this.health.hidden = true;
  }

  setHealth(state: HealthState): void {
    if (this.disposed) return;
    const key = JSON.stringify(state);
    if (key === this.lastHealth) return;
    this.lastHealth = key;
    const backendDown = state.backend === "unavailable";
    const titles: Record<HealthState["sidecar"], string> = {
      ready: "Caption services ready.",
      loading:
        "Speech model is loading or downloading. Captions will start when it is ready.",
      error:
        "Speech model failed to load. Check the sidecar log and model configuration.",
      unavailable:
        "Speech sidecar is not running or is unreachable. Retrying automatically.",
    };
    this.healthTitle.textContent = backendDown
      ? "Caption backend is not running or is unreachable. Retrying automatically."
      : titles[state.sidecar];
    this.healthDetails.textContent = [
      state.model ? `Model: ${state.model}` : "",
      state.mode ? `Mode: ${state.mode}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    this.healthDetails.hidden = !this.healthDetails.textContent;
    this.healthMessage.textContent = state.message ?? "";
    this.healthMessage.hidden = !state.message;
    this.startHint.replaceChildren();
    this.startHint.hidden = !backendDown && state.sidecar !== "unavailable";
    if (!this.startHint.hidden) {
      const code = document.createElement("code");
      code.textContent = backendDown
        ? "cd backend && npm run start:dev"
        : "cd sidecar && python -m uvicorn app.main:app --host 127.0.0.1 --port 9000";
      this.startHint.append("From the project root, run: ", code);
    }
  }

  observeLanguage(
    language: string,
    probability: number,
    voiced: boolean,
  ): void {
    if (this.disposed || this.dismissed) return;
    const confirmed = this.evidence.observe(language, probability, voiced);
    if (!confirmed || !this.languageNotice.hidden) return;
    this.languageMessage.textContent = `Audio does not appear to be English (detected: ${confirmed}). Captions may be inaccurate.`;
    this.languageNotice.hidden = false;
    this.select.value = SOURCE_LANGUAGES.some(([code]) => code === confirmed)
      ? confirmed
      : "";
  }

  resetLanguage(): void {
    if (this.disposed) return;
    this.evidence.reset();
    this.dismissed = false;
    this.dismissNotice();
    this.select.value = "";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.abort();
    this.element.remove();
  }

  private closeChooser(): void {
    this.chooser.hidden = true;
    this.chooseButton.setAttribute("aria-expanded", "false");
    this.chooseButton.focus();
  }

  private dismissNotice(): void {
    const focused = this.element.shadowRoot?.activeElement;
    if (focused && this.languageNotice.contains(focused)) this.element.focus();
    this.languageNotice.hidden = true;
    this.chooser.hidden = true;
    this.chooseButton.setAttribute("aria-expanded", "false");
  }

  private act(action: LanguageAction, language?: string): void {
    if (this.disposed) return;
    this.dismissed = true;
    this.dismissNotice();
    this.onLanguageAction(action, language);
  }
}
