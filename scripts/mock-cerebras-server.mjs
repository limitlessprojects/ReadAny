#!/usr/bin/env node
/**
 * Mock Cerebras API server — OpenAI-compatible, SSE streaming.
 *
 * DEV/TEST ONLY. Used when api.cerebras.ai is unreachable from the build
 * environment (e.g. Cloudflare-blocked CI IPs) so the full streaming pipeline
 * can be exercised end to end. The real demo must run against
 * https://api.cerebras.ai via the vite proxy (CEREBRAS_API_TARGET).
 *
 * Usage: node scripts/mock-cerebras-server.mjs [port]   (default 8787)
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream: true → SSE; otherwise JSON)
 */

import http from "node:http";

const PORT = Number(process.argv[2] || process.env.MOCK_CEREBRAS_PORT || 8787);

const MODELS = [
  { id: "llama-3.3-70b", object: "model", owned_by: "Meta", context_window: 128000 },
  { id: "gpt-oss-120b", object: "model", owned_by: "OpenAI", context_window: 131072 },
  { id: "llama3.1-8b", object: "model", owned_by: "Meta", context_window: 128000 },
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

const SWAHILI_MARKERS = /\b(na|ya|wa|kwa|katika|nisaidie|eleza|muhtasari|tafadhali|asante|hii|ni)\b/i;

function makeReply(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  const prompt = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  const topic = prompt.replace(/\s+/g, " ").trim().slice(0, 160) || "(empty prompt)";

  if (SWAHILI_MARKERS.test(prompt)) {
    return [
      "**Hii ni seva ya majaribio ya Cerebras** — mnyororo unafanya kazi kikamilifu (ujaribio tu, si modeli halisi).",
      "",
      `Uliuliza: “${topic}”`,
      "",
      "### Kilichothibitishwa",
      "- Majibu yanafika tokeni kwa tokeni (SSE streaming)",
      "- Maandishi ya Markdown yanaonyeshwa vizuri",
      "- Sauti ya Kiswahili inaweza kusoma jibu hili kwa sauti",
      "",
      "Badilisha `CEREBRAS_API_TARGET=https://api.cerebras.ai` (pamoja na `CEREBRAS_API_KEY`) kuona modeli halisi.",
    ].join("\n");
  }

  return [
    "This is the **mock Cerebras endpoint** — the pipeline is working end to end (dev/test only, not a real model).",
    "",
    `You asked: “${topic}”`,
    "",
    "### What this validates",
    "- SSE streaming reaches the app token by token",
    "- Markdown renders in the chat surface",
    "- TTFT and total time are measurable end to end",
    "",
    "Swap `CEREBRAS_API_TARGET=https://api.cerebras.ai` (with `CEREBRAS_API_KEY`) to see the real thing.",
  ].join("\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, { object: "list", data: MODELS });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: { message: "invalid JSON body" } });
    }

    const id = `chatcmpl-mock-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? "llama-3.3-70b";
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
  console.log(`[mock-cerebras] listening on http://127.0.0.1:${PORT} (dev/test only)`);
});
