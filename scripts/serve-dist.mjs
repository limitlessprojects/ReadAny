#!/usr/bin/env node
/**
 * Local production simulator — rehearses the exact Netlify topology:
 *
 *   /               → landing page
 *   /app/<file>     → static SPA files from dist/app/
 *   /app/<anything> → SPA fallback to dist/app/index.html
 *   /gemini-api/*   → provider proxy (same code as the edge function)
 *   /cerebras-api/*, /anthropic-api/*, /openai-api/*, /gtranslate-tts/*
 *
 * Env comes from the repo-root .env (GEMINI_API_KEY + *_API_TARGET overrides)
 * — identical key-custody semantics to Netlify env vars.
 *
 * Usage: node scripts/serve-dist.mjs [--port 8788] [--dist dist]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { handleProviderProxy } from "../netlify/edge-functions/proxy-core.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---- args ----
let PORT = 8788;
let DIST = path.join(ROOT, "dist");
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") PORT = Number(argv[++i]);
  if (argv[i] === "--dist") DIST = path.resolve(argv[++i]);
}
if (!existsSync(path.join(DIST, "app", "index.html"))) {
  console.error(`[serve-dist] missing ${path.join(DIST, "app", "index.html")} — run scripts/netlify-build.sh first`);
  process.exit(1);
}

// ---- env (repo-root .env, same contract as Netlify env vars) ----
const envMap = new Map();
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) envMap.set(k, v);
}
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !envMap.has(m[1])) envMap.set(m[1], m[2]);
  }
}
const envAdapter = { get: (k) => envMap.get(k) ?? null };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const PROXY_PREFIXES = ["/gemini-api", "/cerebras-api", "/anthropic-api", "/openai-api", "/gtranslate-tts"];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else if (typeof v === "string") headers.set(k, v);
      }
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const bodyBuf = hasBody ? await readBody(req) : undefined;
      const proxied = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
        method: req.method,
        headers,
        body: bodyBuf,
      });
      const proxiedRes = await handleProviderProxy(proxied, envAdapter);
      res.writeHead(proxiedRes.status, Object.fromEntries(proxiedRes.headers));
      if (proxiedRes.body) {
        Readable.fromWeb(proxiedRes.body).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    // Static with SPA fallback — mirrors the netlify.toml redirects.
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const candidate = path.join(DIST, safePath);
    let filePath = null;
    if (candidate.startsWith(DIST)) {
      try {
        const s = await stat(candidate);
        if (s.isFile()) filePath = candidate;
        else if (s.isDirectory()) {
          const idx = path.join(candidate, "index.html");
          if (existsSync(idx)) filePath = idx;
        }
      } catch {
        /* not found — fall through */
      }
    }
    if (!filePath) {
      filePath = pathname === "/app" || pathname.startsWith("/app/")
        ? path.join(DIST, "app", "index.html")
        : path.join(DIST, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const isAsset = filePath.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("[serve-dist]", err);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[serve-dist] http://127.0.0.1:${PORT}/  (landing)  /app/  (web app)`);
  console.log(`[serve-dist] GEMINI_API_KEY ${envAdapter.get("GEMINI_API_KEY") ? "loaded" : "MISSING"} from .env / environment`);
});
