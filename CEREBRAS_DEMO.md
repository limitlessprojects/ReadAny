# ReadAny × Cerebras — Mobile Reading Demo

**Branch:** `cerebras-demo` (fork of [codedogQBY/ReadAny](https://github.com/codedogQBY/ReadAny), GPL-3.0 preserved)
**What it is:** the full ReadAny reader running in a **plain browser** (no Tauri shell) with a first-class **Cerebras** provider, live **streaming speed instrumentation** (TTFT / tok·s), and **read-aloud TTS with native Swahili voices** — the foundation for our #bigchipenergy competition demo.

---

## Why this branch exists

ReadAny's desktop app is Tauri-based. The competition needs a phone-screen, browser-run demo with:

1. Paper/PDF import → clean mobile reading (B)
2. Cerebras streaming answers with visible speed (C)
3. Iterative grounded follow-ups (C)
4. TTS that reads the generated explanation, in Swahili (D)
5. API key never shipped in the client (E)

Upstream already had the hard parts (IPlatformService seam, BM25 grounding path, chat Markdown, TTS engine abstraction, pdfjs). This branch adds the **web platform layer** that lets all of it run without Tauri:

| Piece | File | Notes |
|---|---|---|
| Virtual filesystem | `packages/app/src/lib/platform/web-vfs.ts` | OPFS-backed, memory fallback, object-URL cache for covers/fonts |
| SQLite in WASM | `packages/app/src/lib/platform/web-database.ts` | vendored `sql.js`, debounced persistence to WebVFS, per-path instance cache |
| Platform service | `packages/app/src/lib/platform/web-platform-service.ts` | full `IPlatformService` for the browser + Cerebras URL rewrite + WS relay rewrite |
| Tauri shims | `tauri-shim-fs.ts` / `tauri-shim-dialog.ts` / `tauri-shim-core.ts` / `tauri-shim-path.ts` | vite aliases (READANY_WEB=1) — import flow, hashing (WebCrypto SHA-256), path helpers work unmodified |
| Stream metrics | `packages/core/src/ai/stream-metrics.ts` | tees the SSE stream, measures **time-to-first-token** + total + chunk rate, broadcasts `readany-stream-metrics` |
| Chat UX deltas | `packages/app/src/components/chat/MessageList.tsx` | ⚡ TTFT badge on the latest answer + per-message **read-aloud** button (engine-aware, auto `sw-KE-RafikiNeural` when the answer is Swahili) |
| Cerebras preset | `packages/core/src/utils/api.ts` + `types/chat.ts` | first-class provider entry (`https://api.cerebras.ai`) |
| Edge TTS relay | `vite.config.ts` `edgeTtsRelayPlugin` | browsers can't open the Microsoft speech WebSocket; the dev server tunnels it with the right headers |

**Desktop/Tauri build is untouched** — every web-only behavior is gated behind `READANY_WEB=1` (vite aliases) or `IS_WEB` runtime detection.

---

## Run it

```bash
# 1. deps
pnpm install --filter app...

# 2. dev-only mock Cerebras (OpenAI-compatible SSE) — for offline/blocked networks
node scripts/mock-cerebras-server.mjs        # :8787, replies in EN or Swahili (detects prompt language)

# 3. web build (port 5183) — proxies /cerebras-api → mock by default
pnpm --filter app dev:web
```

Open `http://localhost:5183` → skip onboarding → **Add Book → Local Files** → pick a PDF/EPUB → open it → **Ask AI**.

### Demo day — real Cerebras (no mock)

```bash
export CEREBRAS_API_TARGET=https://api.cerebras.ai
export CEREBRAS_API_KEY=csk-...        # stays server-side (vite proxy injects the header)
pnpm --filter app dev:web
```

The browser calls `https://api.cerebras.ai/...` through the same-origin proxy — no CORS, and the key never enters client code or localStorage. In-app: pick the **Cerebras** provider, model `llama-3.3-70b` (or `gpt-oss-120b`).

> Container note: Cloudflare blocks `api.cerebras.ai` from some datacenter IPs (our CI sandbox is one). The demo machine/phone network is unaffected; the mock exists so every other pipeline piece stays testable anywhere.

---

## Demo video pipeline (`scripts/demo/`)

| Script | Purpose |
|---|---|
| `narration.mjs` | per-scene voice-over (Google TTS endpoint; EN + a Swahili segment), writes `durations.json` |
| `record-scenes.sh` / `rerecord-scenes.sh` | 420×900 browser recordings of the six golden-path scenes |
| `scene2-only.sh` | re-record just the import scene (reload-reset + in-recording reload trick) |
| `compose.py` | phone bezel (PIL) → per-scene pad/trim to narration length → narration mix → concat → closing overlay (`github.com/limitlessprojects/ReadAny` + `#bigchipenergy`) |
| `edge-tts-probe.mjs` | diagnostic for the Edge TTS WS handshake (Sec-MS-GEC / headers) |

Output: `/home/z/my-project/download/demo-video.mp4` — 1080×1920, ~97s, narrated end to end.

**Scene map (97s):** dense paper on a phone → local import → streaming answer + TTFT badge → grounded reader Q&A → **Swahili answer read aloud** → repo + hashtag close.

---

## Verified end-to-end (this branch)

- Boot: schema-ready before any store query (web DB gate in `getDB()`), zero console errors
- Import: dialog → VFS → hash → library card with extracted title metadata
- Reader: foliate renders the PDF, page nav, TTS button
- Chat: SSE streaming via provider proxy, Markdown, model badge, thread history
- Reader agent: grounded questions against the open book
- Speed badge: `⚡ TTFT Xms · N tok/s` measured on the real response stream
- TTS: Edge voice reads the answer through the WS relay; Swahili auto-voice works
- Swahili: streamed Swahili answer → read aloud with `sw-KE-RafikiNeural`

## Known limitations (honest list)

- No vector DB on web (Rust-backed) — grounding uses the first-class BM25 path; embeddings are a stretch goal
- Library grid sometimes needs a refresh after an import on web (upstream virtualization quirk) — the demo flow shows it via the reload beat
- `api.cerebras.ai` unreachable from some datacenter IPs (mock server provided; real target is one env var away)
- Edge TTS synthesis is IP-sensitive: the relay works from normal networks, and system/browser TTS remains available
- The mock server is for pipeline development only and labels itself as such in every reply

## Licence & attribution

- Upstream ReadAny: GPL-3.0 (© ReadAny Team) — this fork inherits it in full; no licence change.
- `sql.js` (vendored dependency): MIT — see `packages/app/src/lib/platform/vendor/LICENSE-sqljs.txt`.
- Demo narration uses publicly available TTS endpoints for build-time assets only; nothing ships in the app bundle.
- Cerebras API key handling: server-side env (`CEREBRAS_API_KEY`) or user-pasted at runtime in provider settings — never committed, never bundled.
