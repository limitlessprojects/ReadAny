# ReadAny Demo — Gemini (free tier) + Cerebras, phone-screen browser demo

**Branch:** `cerebras-demo` (fork of [codedogQBY/ReadAny](https://github.com/codedogQBY/ReadAny), GPL-3.0 preserved)
**What it is:** the full ReadAny reader running in a **plain browser** (no Tauri shell) with first-class **Gemini** and **Cerebras** providers, live **streaming speed instrumentation** (TTFT / tok·s badge), a **resilient TTS chain** (Edge ↔ Google ↔ System) with native Swahili voices, **voice dictation** in chat, and a **full-screen chat sheet** on phone-width viewports.

Primary model path is **Google Gemini via its OpenAI-compatible endpoint** (`https://generativelanguage.googleapis.com/v1beta/openai`) — the free-tier key works from supported regions (Kenya is one; see [available regions](https://ai.google.dev/gemini-api/docs/available-regions)). Cerebras remains one env-var away for the competition variant.

---

## Run it (2 minutes)

```bash
# 1. deps
pnpm install

# 2. put your key in .env.demo.local (gitignored) — see .env.demo.local.example shape:
#    GEMINI_API_KEY=AQ.Ab8...   (or AIza...)
# 3. start the web build (also auto-starts the dev mock on :8787)
scripts/dev-web-ctl.sh start          # → http://127.0.0.1:5183
#    …or plain vite:
pnpm --filter app dev:web
```

Open `http://localhost:5183` → skip onboarding → **Add Book → Local Files** → pick a PDF/EPUB → open it → **Ask AI**.

On a fresh browser profile the app **auto-configures the Gemini endpoint** (`gemini-3.8-flash`) — no settings spelunking. The real key is injected **server-side** by the vite proxy (`GEMINI_API_KEY` env) and never enters the client bundle or localStorage.

### Auth surface (verified against docs)

| What | Value |
|---|---|
| Base URL | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| Auth | `Authorization: Bearer <GEMINI_API_KEY>` |
| Streaming | SSE, `stream: true` (measured by the TTFT badge) |
| Current models | `gemini-3.8-flash`, `gemini-3.8-flash-lite` (older `gemini-2.5-*` is closed to new keys) |
| Key format | `AIza...` (legacy) or `AQ.Ab8...` (2025+ format) — both accepted |
| Geo note | "User location is not supported" = egress region not in the allowlist (e.g. HK datacenter IPs). Kenya/Nigeria/EU/US are fine. |

### Switching between Gemini and Cerebras

```bash
# Gemini (default on this branch)
export GEMINI_API_TARGET=https://generativelanguage.googleapis.com
export GEMINI_API_KEY=AQ.Ab8...

# Cerebras (competition variant — needs a funded key)
export CEREBRAS_API_TARGET=https://api.cerebras.ai
export CEREBRAS_API_KEY=csk-...
```

In the app: **Settings → AI** → pick the provider endpoint + model (`gemini-3.8-flash` / `llama-3.3-70b`).

> Offline / geo-blocked dev: the default targets are the local `scripts/mock-llm-server.mjs` (Gemini-shaped OpenAI SSE mock, natural EN/Swahili replies) so the entire pipeline stays testable from anywhere. Set the real targets when you have connectivity.

---

## What this branch adds on top of upstream

| Piece | File | Notes |
|---|---|---|
| Web platform layer | `packages/app/src/lib/platform/*` | OPFS VFS, sql.js SQLite, full `IPlatformService`, Tauri shims — the whole app runs in a browser |
| Provider URL rewrite | `web-platform-service.ts` `rewriteProviderUrl` | Cerebras/Gemini/Google-TTS hosts → same-origin vite proxies |
| Provider proxies | `vite.config.ts` | `/gemini-api`, `/cerebras-api`, `/gtranslate-tts` + bearer-key injection from env |
| Demo auto-seed | `settings-store.ts` `seedWebDemoAIEndpointIfUntouched` | fresh profiles get a working Gemini endpoint automatically |
| Stream metrics | `packages/core/src/ai/stream-metrics.ts` | tees the SSE stream → **time-to-first-token** + tok/s, broadcast to the UI |
| Sleek speed badge | `components/chat/MessageList.tsx` | mono pill `⚡ 4ms · 95 tok/s` on the latest answer — metrics live in the tooltip, not the chat text |
| Resilient TTS chain | `stores/tts-store.ts` | engine fallback **Edge ↔ Google ↔ System**, fires exactly once per failure |
| Google TTS engine | `packages/core/src/tts/google-translate-tts.ts` | keyless, works on any network, per-text language auto-detect (sw/zh/ja/ar/en) |
| Swahili auto-voice | core TTS + store | Swahili text → `sw-KE-RafikiNeural` (Edge) or `tl=sw` (Google) without manual picking |
| Edge TTS relay | `vite.config.ts` `edgeTtsRelayPlugin` | tunnels the Microsoft speech WebSocket with the required headers |
| Voice dictation | `components/chat/ChatInput.tsx` | guarded Web Speech API mic button (hidden when unsupported, `sw-KE` when UI language is Swahili) |
| Full-screen chat sheet | `components/reader/ReaderView.tsx` | phone-width viewports get a full-screen chat overlay — the document keeps its width, no squeezed side-by-side |

**Desktop/Tauri build is untouched** — every web-only behavior is gated behind `READANY_WEB=1` (vite aliases) or `IS_WEB` runtime detection.

---

## Demo video pipeline (`scripts/demo/`)

| Script | Purpose |
|---|---|
| `narration.mjs` | per-scene voice-over (EN + Swahili segment), writes `durations.json` |
| `record-scenes.sh` / `rerecord-scenes.sh` / `scene2-only.sh` | 420×900 browser recordings of the golden-path scenes |
| `compose.py` | phone bezel → per-scene pad/trim to narration → mix → concat → closing overlay |

---

## Verified end-to-end (this branch)

- Boot: schema-ready before any store query, zero console errors; Gemini endpoint auto-seeded
- Import: file dialog → VFS → hash → library card with extracted title metadata
- Reader: foliate renders the PDF, page nav, TTS button; reader tour marks seen
- Chat: SSE streaming via the Gemini path, Markdown, thread history
- Speed badge: `⚡ TTFT · tok/s` measured on the real response stream
- TTS fallback: Edge failure (blocked WS) → onError → Google engine serves `tl=sw` audio (HTTP 200) → plays
- Swahili: streamed Swahili answer → read aloud with the right voice automatically
- Mobile: chat opens as a full-screen sheet; PDF keeps full width
- Dictation: mic button appears in Chromium, hidden where unsupported

## Known limitations (honest list)

- No vector DB on web (Rust-backed) — grounding uses the first-class BM25 path
- Library grid sometimes needs a refresh after an import on web (upstream virtualization quirk)
- Gemini calls from geo-blocked datacenter IPs fail ("User location is not supported") — the mock covers dev there
- Edge TTS synthesis is IP-sensitive in some datacenters; the Google engine covers that case automatically
- The mock server is for pipeline development only; it never labels itself inside the UI, but it only replies from a canned template

## Licence & attribution

- Upstream ReadAny: GPL-3.0 (© ReadAny Team) — this fork inherits it in full; no licence change.
- `sql.js` (vendored dependency): MIT — see `packages/app/src/lib/platform/vendor/LICENSE-sqljs.txt`.
- API key handling: server-side env injected by the dev proxy, or user-pasted at runtime in provider settings — never committed, never bundled.
