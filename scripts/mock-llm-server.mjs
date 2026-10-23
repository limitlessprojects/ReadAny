#!/usr/bin/env node
/**
 * Mock LLM server — OpenAI-compatible, SSE streaming, Gemini-shaped.
 *
 * DEV/TEST ONLY. Serves the same wire shape as Gemini's OpenAI-compatible
 * endpoint (POST /v1beta/openai/chat/completions) so the app's streaming
 * pipeline can be exercised end to end when generativelanguage.googleapis.com
 * is unreachable (e.g. geo-blocked CI sandboxes — HK egress hits
 * "User location is not supported"). Replies are natural, product-quality
 * reading-assistant answers in English or Swahili (detected from the prompt) —
 * the mock must never leak dev/env/debug chatter into the UI.
 *
 * Usage: node scripts/mock-llm-server.mjs [port]   (default 8787)
 *
 * Endpoints (path-suffix matched, so /v1/... and /v1beta/openai/... both work):
 *   GET  any path ending in /models
 *   POST any path ending in /chat/completions  (stream: true → SSE; otherwise JSON)
 */

import http from "node:http";

const PORT = Number(process.argv[2] || process.env.MOCK_LLM_PORT || 8787);

const MODELS = [
  { id: "gemini-3.8-flash", object: "model", owned_by: "google", context_window: 1048576 },
  { id: "gemini-3.8-flash-lite", object: "model", owned_by: "google", context_window: 1048576 },
  { id: "gemini-3-pro", object: "model", owned_by: "google", context_window: 1048576 },
];

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Split into small token-ish chunks to simulate real streaming pacing. */
function tokenize(text) {
  return text.match(/\s*\S+/g) ?? [text];
}

const SWAHILI_MARKERS = /\b(na|ya|wa|kwa|katika|nisaidie|eleza|muhtasari|tafadhali|asante|hii|ni|unaweza|soma|hati|waraka)\b/i;

/** Last user text, flattening LangChain-style content arrays. */
function lastUserPrompt(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
      .join(" ");
  }
  return String(content ?? "");
}

function topicOf(prompt) {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  const withoutContext = cleaned.split(/\n\n+/).pop() || cleaned;
  return withoutContext.slice(0, 120);
}

function makeReply(messages) {
  const prompt = lastUserPrompt(messages);
  const topic = topicOf(prompt) || "hii";
  const isSwahili = SWAHILI_MARKERS.test(prompt);

  if (isSwahili) {
    return [
      `Karibu! Kuhusu **${topic}** — hii ni muhtasari mfupi.`,
      "",
      "### Mambo makuu",
      "- Waraka huu unaeleza mada kwa undani, na sehemu za kwanza zinaongelea misingi ya somo.",
      "- Waandishi wanatoa mifano halisi inayosaidia kuelewa dhana kwa urahisi.",
      "- Hitimisho lina mapendekezo ya vitendo unayoweza kutekeleza sasa.",
      "",
      "Ungependa nikusome sehemu fulani kwa sauti, au nikupeleke kwa lugha nyingine?",
    ].join("\n");
  }

  return [
    `Happy to help with **${topic}** — here's a quick rundown.`,
    "",
    "### Key points",
    "- The document opens by framing the core problem, then walks through the method step by step.",
    "- The middle sections back each claim with real examples and numbers you can verify.",
    "- The conclusion wraps up with practical takeaways you can act on right away.",
    "",
    "Want me to read this aloud, translate it, or dig deeper into any section?",
  ].join("\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "GET" && path.endsWith("/models")) {
    return json(res, 200, { object: "list", data: MODELS });
  }

  if (req.method === "POST" && path.endsWith("/chat/completions")) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: { message: "invalid JSON body" } });
    }

    const id = `chatcmpl-mock-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? "gemini-3.8-flash";
    const reply = makeReply(body.messages);

    if (!body.stream) {
      await new Promise((r) => setTimeout(r, 120));
      return json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: Math.ceil((body.messages?.map((m) => String(m.content).length).join("") ?? "").length / 4),
          completion_tokens: Math.ceil(reply.length / 4),
          total_tokens: 0,
        },
        time_info: { queue_time: 0.001, prompt_time: 0.01, completion_time: 0.05, total_time: 0.12 },
      });
    }

    // SSE streaming
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "x-accel-buffering": "no",
    });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id, object: "chat.completion.chunk", created, model };

    // first chunk: role
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });

    const tokens = tokenize(reply);
    const pacing = Number(body.__mock_pace_ms ?? 12);
    let i = 0;
    for (const token of tokens) {
      if (res.closed) return;
      send({ ...base, choices: [{ index: 0, delta: { content: token }, finish_reason: null }] });
      i += 1;
      if (i % 8 === 0) await new Promise((r) => setTimeout(r, pacing));
    }

    send({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 42, completion_tokens: tokens.length, total_tokens: 42 + tokens.length },
    });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  return json(res, 404, { error: { message: `mock: no route for ${req.method} ${url.pathname}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT} (dev/test only — Gemini-shaped)`);
});
