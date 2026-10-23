import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// @ts-expect-error vite config runs in CJS context
const require2 = createRequire(__filename);
// ws export shape varies by version (v7: root = WebSocket + .Server;
// v8: root = WebSocketServer + .WebSocket) — normalize both.
const wsRoot = require2("ws");
const UpstreamWS = wsRoot.WebSocket ?? wsRoot.default?.WebSocket ?? wsRoot;
const WebSocketServer = wsRoot.WebSocketServer ?? wsRoot.Server ?? wsRoot.default?.WebSocketServer;

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Web build mode: alias @tauri-apps/plugin-fs + plugin-dialog to OPFS-backed
// shims (used with `pnpm --filter app dev:web`).
// @ts-expect-error process is a nodejs global
const WEB_SHIM = process.env.READANY_WEB === "1";
const pdfjsDist = path.resolve(__dirname, "../../node_modules/pdfjs-dist");

// Cerebras API proxy: browser can't reach api.cerebras.ai cross-origin (and
// keys stay server-side when CEREBRAS_API_KEY is exported). Target defaults
// to the local OpenAI-compatible mock server; set CEREBRAS_API_TARGET to
// https://api.cerebras.ai for the real thing.
// @ts-expect-error process is a nodejs global
const CEREBRAS_TARGET = process.env.CEREBRAS_API_TARGET || "http://127.0.0.1:8787";
// @ts-expect-error process is a nodejs global
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || "";

/**
 * Edge TTS relay plugin — browsers can't open the Microsoft speech WebSocket
 * (the upgrade request needs specific Origin/UA headers the platform won't
 * send). The web build connects to ws://<dev>/edge-tts-relay/... and this
 * plugin tunnels the frames to wss://speech.platform.bing.com with the
 * headers Edge expects. Only active in READANY_WEB=1 mode.
 */
function edgeTtsRelayPlugin(): Plugin {
  const UPSTREAM = "wss://speech.platform.bing.com";
  const HEADERS = {
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  };
  const wss = new WebSocketServer({ noServer: true });
  return {
    name: "edge-tts-relay",
    configureServer(server) {
      server.httpServer.on("upgrade", (req, socket, head) => {
        const url = req.url || "";
        if (!url.startsWith("/edge-tts-relay/")) return;
        const upstreamPath = url.replace("/edge-tts-relay", "");
        wss.handleUpgrade(req, socket, head, (client) => {
          let upstream: InstanceType<typeof UpstreamWS>;
          try {
            upstream = new UpstreamWS(UPSTREAM + upstreamPath, { headers: HEADERS });
          } catch (err) {
            client.close(1011, "relay connect failed");
            return;
          }
          const closeBoth = () => {
            try { client.close(); } catch { /* already closed */ }
            try { upstream.close(); } catch { /* already closed */ }
          };
          upstream.on("open", () => {
            client.on("message", (data) => {
              if (upstream.readyState === UpstreamWS.OPEN) upstream.send(data);
            });
            upstream.on("message", (data, isBinary) => {
              if (client.readyState === UpstreamWS.OPEN) {
                // ws message handler signature: (data, isBinary)
                client.send(data, { binary: isBinary });
              }
            });
          });
          upstream.on("error", closeBoth);
          client.on("error", closeBoth);
          upstream.on("close", (code, reason) => {
            try { client.close(code, reason); } catch { /* already closed */ }
          });
          client.on("close", (code, reason) => {
            try { upstream.close(code, reason); } catch { /* already closed */ }
          });
        });
      });
    },
  };
}

// The About dialog shows the Tauri framework version. @tauri-apps/api releases
// in lockstep but can differ by a patch, and its package.json is not importable
// (exports map), so read the version the app actually builds against from the
// lockfile. Empty string = the card renders without a version.
function readTauriVersion(): string {
  try {
    const lock = fs.readFileSync(path.resolve(__dirname, "src-tauri/Cargo.lock"), "utf-8");
    return lock.match(/^name = "tauri"\r?\nversion = "([^"]+)"/m)?.[1] ?? "";
  } catch {
    return "";
  }
}

// Same pattern for the TypeScript toolchain version: application source must
// not import a dev-only package's manifest for one field. Resolve through
// Node so hoisting cannot break the path.
function readTypeScriptVersion(): string {
  try {
    const require = createRequire(path.resolve(__dirname, "package.json"));
    return require("typescript/package.json").version ?? "";
  } catch {
    return "";
  }
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  define: {
    __TAURI_VERSION__: JSON.stringify(readTauriVersion()),
    __TS_VERSION__: JSON.stringify(readTypeScriptVersion()),
  },
  plugins: [react(), tailwindcss(), ...(WEB_SHIM ? [edgeTtsRelayPlugin()] : [])],
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      ...(WEB_SHIM
        ? {
            "@tauri-apps/plugin-fs": path.resolve(__dirname, "src/lib/platform/tauri-shim-fs.ts"),
            "@tauri-apps/plugin-dialog": path.resolve(
              __dirname,
              "src/lib/platform/tauri-shim-dialog.ts",
            ),
            "@tauri-apps/api/core": path.resolve(__dirname, "src/lib/platform/tauri-shim-core.ts"),
            "@tauri-apps/api/path": path.resolve(__dirname, "src/lib/platform/tauri-shim-path.ts"),
          }
        : {}),
      "@": path.resolve(__dirname, "./src"),
      "pdfjs-dist/build/pdf.worker.mjs": path.join(pdfjsDist, "build/pdf.worker.mjs"),
      "pdfjs-dist": pdfjsDist,
      // Map @pdfjs/* to foliate-js vendored pdfjs (v4.7, compatible with foliate-js)
      "@pdfjs": path.resolve(__dirname, "../../foliate-js/vendor/pdfjs"),
    },
    dedupe: ["i18next", "react-i18next", "react", "react-dom"],
  },
  optimizeDeps: {
    // Exclude foliate-js pdf.js from pre-bundling so that @pdfjs alias works
    exclude: [
      "foliate-js/pdf.js",
      // Tauri plugins import @tauri-apps/api/core internally; when the WEB_SHIM
      // alias redirects that specifier to a source file, esbuild dep scanning
      // fails. Serving them unbundled keeps per-request alias resolution.
      "@tauri-apps/api",
      "@tauri-apps/plugin-fs",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-http",
      "@tauri-apps/plugin-websocket",
      "@tauri-apps/plugin-clipboard-manager",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-process",
      "@tauri-apps/plugin-updater",
      "@tauri-apps/plugin-window-state",
      "@tauri-apps/plugin-sql",
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/cerebras-api": {
        target: CEREBRAS_TARGET,
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/cerebras-api/, ""),
        // Keep SSE streams unbuffered.
        headers: { "X-Accel-Buffering": "no" },
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (CEREBRAS_KEY) {
              const auth = proxyReq.getHeader("authorization");
              const hasKey = typeof auth === "string" && auth.length > "Bearer ".length;
              if (!hasKey) proxyReq.setHeader("Authorization", `Bearer ${CEREBRAS_KEY}`);
            }
          });
        },
      },
    },
  },
}));
