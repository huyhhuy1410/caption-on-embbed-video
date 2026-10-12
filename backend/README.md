# Caption AI — Backend

NestJS service that bridges the browser extension and the Whisper sidecar.

- **WS gateway** (port 8000) — accepts audio + video-clock messages from the extension's offscreen document, forwards PCM to the sidecar, aligns word timestamps to the video clock, and streams caption packets back.
- **Transcript cache** — bounded in-memory store keyed by video source; replays already-watched ranges instantly on seek.
- **AI layer** — `/translate` and `/explain-word` behind pluggable `TranslationProvider` / `ExplainProvider` interfaces. First adapter is Google Gemini; the provider key lives in `.env` and never reaches the extension.

## Setup

```bash
npm install
```

Create `backend/.env` (gitignored) with the provider settings:

| Variable | Purpose |
| --- | --- |
| `AI_PROVIDER` | `gemini` (default) or another registered provider |
| `AI_API_KEY` | Provider key — stays here, never enters the extension bundle |
| `AI_MODEL` | Optional; overrides the provider's default cheap tier |
| `AI_BASE_URL` | Optional; overrides the provider endpoint |
| `AI_MAX_RPM` | Optional; throttle ceiling (Gemini free tier is 15) |
| `CAPTION_MODE` | Optional; `windowed` (default) or `streaming` |
| `PORT` | Optional; defaults to 8000 |

## Run

Start the whole stack (sidecar + backend) from the repo root with `./dev.sh`. To run the backend alone:

```bash
npm run start:dev
```

## Test

```bash
npm run test        # unit specs (src/**/*.spec.ts)
npm run test:cov    # with coverage
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/audio/` | WS gateway, video-clock alignment, transcript cache |
| `src/ai/` | Provider abstraction, translation/explanation endpoints, rate limiter |
| `src/health/` | `/health` aggregation over backend + sidecar state |
