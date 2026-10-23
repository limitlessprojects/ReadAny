/**
 * Stream metrics — measures Cerebras-style speed where the demo can SEE it.
 *
 * Wraps the streaming fetch used by all LangChain providers: tees the SSE
 * body, counts chunks/bytes, and records:
 *   - TTFT  (time to first SSE chunk ≈ time to first token)
 *   - total wall time
 *   - chunk count and bytes
 *
 * The last completed measurement is broadcast on window as
 * `readany-stream-metrics` so the chat UI can badge the answer with real
 * numbers instead of claiming "fast".
 */

export interface StreamMetrics {
  ttftMs: number;
  totalMs: number;
  chunks: number;
  bytes: number;
  url: string;
  completedAt: number;
}

let lastMetrics: StreamMetrics | null = null;

export function getLastStreamMetrics(): StreamMetrics | null {
  return lastMetrics;
}

export const STREAM_METRICS_EVENT = "readany-stream-metrics";

/**
 * Wrap a fetch implementation so POST responses with text/event-stream bodies
 * get measured. Everything else passes through untouched.
 */
export function instrumentFetchForMetrics(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

    const response = await fetchImpl(input as RequestInfo, init);

    const isSSE =
      method === "POST" &&
      (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isSSE || !response.body) {
      return response;
    }

    const startedAt = performance.now();
    let ttftMs = 0;
    let chunks = 0;
    let bytes = 0;

    const reader = response.body.getReader();
    const measured = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            const totalMs = performance.now() - startedAt;
            lastMetrics = {
              ttftMs: Math.round(ttftMs),
              totalMs: Math.round(totalMs),
              chunks,
              bytes,
              url,
              completedAt: Date.now(),
            };
            if (typeof window !== "undefined" && chunks > 0) {
              window.dispatchEvent(
                new CustomEvent(STREAM_METRICS_EVENT, { detail: lastMetrics }),
              );
            }
            controller.close();
            return;
          }
          if (value) {
            if (ttftMs === 0) ttftMs = performance.now() - startedAt;
            chunks += 1;
            bytes += value.byteLength;
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    return new Response(measured, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
