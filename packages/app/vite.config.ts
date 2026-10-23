import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  plugins: [react(), tailwindcss()],
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
