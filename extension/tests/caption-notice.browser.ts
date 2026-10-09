import { CaptionNotice } from "../src/content/caption-notice";

let assertions = 0;
const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
  assertions++;
};
const output = document.createElement("pre");
document.body.append(output);

try {
  const actions: Array<[string, string | undefined]> = [];
  const notice = new CaptionNotice((action, language) =>
    actions.push([action, language]),
  );
  document.body.append(notice.element);
  const root = notice.element.shadowRoot!;
  const get = <T extends HTMLElement>(id: string): T =>
    root.getElementById(id) as T;
  const text = () => root.textContent ?? "";
  const speech = (language = "vi") => {
    for (let i = 0; i < 3; i++) notice.observeLanguage(language, 0.95, true);
  };

  notice.setHealth({ backend: "unavailable", sidecar: "unavailable" });
  assert(text().includes("npm run start:dev"), "backend start command");
  assert(
    get("health-title").textContent?.includes("backend"),
    "backend down title",
  );
  notice.setHealth({
    backend: "ready",
    sidecar: "loading",
    model: "tiny",
    mode: "streaming",
  });
  assert(
    get("health-title").textContent?.includes("loading or downloading"),
    "loading not unavailable",
  );
  assert(get("health").hidden, "service/model status stays out of the page overlay");
  assert(
    get("health-details").textContent === "Model: tiny · Mode: streaming",
    "model/mode visible",
  );
  assert(get("start-hint").hidden, "loading is not a start-service hint");
  notice.setHealth({
    backend: "ready",
    sidecar: "error",
    message: "<img src=x onerror=alert(1)>",
  });
  assert(
    get("health-title").textContent?.includes("failed to load"),
    "model error distinct",
  );
  assert(
    get("health-message").textContent === "<img src=x onerror=alert(1)>",
    "messages remain plain text",
  );
  assert(!root.querySelector("img"), "message HTML never interpreted");
  notice.setHealth({ backend: "ready", sidecar: "unavailable" });
  assert(
    text().includes("--host 127.0.0.1 --port 9000"),
    "sidecar explicit port start command",
  );
  notice.setHealth({
    backend: "ready",
    sidecar: "ready",
    model: "small",
    mode: "windowed",
  });
  assert(
    get("health-title").textContent === "Caption services ready.",
    "health recovers",
  );
  assert(
    get("start-hint").hidden && get("health-message").hidden,
    "stale health hints cleared",
  );

  for (let i = 0; i < 5; i++) notice.observeLanguage("vi", 0.99, false);
  assert(get("language").hidden, "silence does not warn");
  notice.observeLanguage("vi", 0.95, true);
  assert(get("language").hidden, "one sample does not warn");
  notice.observeLanguage("vi", 0.95, true);
  notice.observeLanguage("vi", 0.99, false);
  notice.observeLanguage("vi", 0.95, true);
  assert(!get("language").hidden, "three voiced samples warn");
  assert(actions.length === 0, "notice never auto-disables captions");
  assert(
    get("language-message").getAttribute("role") === "status",
    "nonblocking status announcement",
  );
  get("choose").click();
  assert(!get("chooser").hidden, "chooser opens");
  assert(
    root.activeElement === get("source-language"),
    "chooser takes keyboard focus",
  );
  assert(
    get("choose").getAttribute("aria-expanded") === "true",
    "expanded state",
  );
  get("source-language").dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert(get("chooser").hidden, "escape closes chooser");
  assert(root.activeElement === get("choose"), "escape restores focus");
  assert(actions.length === 0, "cancel never changes ASR language");
  get("choose").click();
  get<HTMLSelectElement>("source-language").value = "ja";
  get("chooser").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  assert(
    actions[0]?.[0] === "choose" && actions[0]?.[1] === "ja",
    "choose invokes actual language callback",
  );
  assert(get("language").hidden, "apply dismisses warning");
  assert(
    document.activeElement === notice.element,
    "dismissal preserves a visible focus target",
  );
  speech();
  assert(get("language").hidden, "dismissal sticks for this source");

  notice.resetLanguage();
  speech("ko");
  assert(!get("language").hidden, "new source can warn again");
  get("choose").click();
  get<HTMLSelectElement>("source-language").value = "";
  get("chooser").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  assert(
    actions[1]?.[0] === "choose" && actions[1]?.[1] === undefined,
    "auto uses undefined for null wire normalization",
  );
  notice.resetLanguage();
  speech();
  get("hide").click();
  assert(
    actions[2]?.[0] === "hide" && actions[2]?.[1] === undefined,
    "hide callback",
  );
  notice.resetLanguage();
  speech();
  get("continue").click();
  assert(
    actions[3]?.[0] === "continue" && actions[3]?.[1] === undefined,
    "continue never forces English",
  );

  const retainedButton = get("hide");
  notice.dispose();
  notice.dispose();
  assert(!notice.element.isConnected, "dispose removes host");
  retainedButton.click();
  assert(actions.length === 4, "dispose aborts listeners");
  notice.setHealth({ backend: "unavailable", sidecar: "unavailable" });
  speech();
  assert(get("language").hidden, "disposed instance remains inert");
  output.dataset.result = "passed";
  output.textContent = `${assertions} assertions passed`;
} catch (error) {
  output.dataset.result = "failed";
  output.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
