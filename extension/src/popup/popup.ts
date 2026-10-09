import type { HealthState } from "../shared/protocol";

const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const serviceState = document.getElementById("service-state") as HTMLElement;

type CaptionResponse = { enabled?: boolean; state?: string; error?: string };

function renderResponse(response: CaptionResponse | undefined): void {
  // Callback vẫn chạy khi port đóng; không đổi label nếu capture chưa thành công.
  const error = chrome.runtime.lastError?.message ?? response?.error;
  if (error || !response) {
    serviceState.textContent = error ?? "No response from the extension.";
    return;
  }
  toggleBtn.textContent = response.enabled ? "Turn off Captions" : "Turn on Captions";
  serviceState.textContent = response.state ?? (response.enabled ? "Captions on" : "Captions off");
}

toggleBtn.addEventListener("click", () => {
  toggleBtn.disabled = true;
  chrome.runtime.sendMessage({ action: "caption:toggle" }, (response: CaptionResponse | undefined) => {
    renderResponse(response);
    toggleBtn.disabled = false;
  });
});

const infoBtn = document.getElementById("info") as HTMLButtonElement;
const info = document.getElementById("model-info")!;
const modelDetail = document.getElementById("model-detail")!;
let healthTimer: ReturnType<typeof setTimeout> | undefined;
let healthGeneration = 0;

function pollHealth(generation: number): void {
  chrome.runtime.sendMessage({ action: "caption:health" }, (health: HealthState | undefined) => {
    const error = chrome.runtime.lastError?.message;
    // Bỏ response của lần mở cũ, không tạo hai vòng polling khi đóng/mở nhanh.
    if (generation !== healthGeneration || info.hidden) return;
    modelDetail.textContent = error ?? (health
      ? `Backend: ${health.backend} · Sidecar: ${health.sidecar} · Model: ${health.model ?? "unknown"} · Mode: ${health.mode ?? "unknown"}${health.message ? ` — ${health.message}` : ""}`
      : "No health response from the extension.");
    healthTimer = setTimeout(() => pollHealth(generation), 3000);
  });
}

infoBtn.addEventListener("click", () => {
  info.hidden = !info.hidden;
  infoBtn.setAttribute("aria-expanded", String(!info.hidden));
  healthGeneration += 1;
  clearTimeout(healthTimer);
  if (!info.hidden) {
    modelDetail.textContent = "Checking caption services…";
    pollHealth(healthGeneration);
  }
});
window.addEventListener("pagehide", () => {
  healthGeneration += 1;
  clearTimeout(healthTimer);
});

chrome.runtime.sendMessage({ action: "caption:status" }, renderResponse);
