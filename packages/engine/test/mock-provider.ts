/**
 * Deterministic mock provider.
 *
 * Speaks the OpenAI chat-completions SSE wire format so tests exercise OMP's
 * REAL provider, streaming, tool-parsing, and usage paths rather than bypassing
 * them with a stub stream function. No test ever spends real API credits.
 *
 * Scripted behaviour by model id:
 *   mock-<tag>   text -> bash tool call echoing <TAG> -> final text
 *   mock-slow    long slow stream, for abort/concurrency tests
 *   mock-error   immediate provider error
 */
import { AgentRegistry, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";

const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunk(
  model: string,
  responseId: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function usageChunk(model: string, responseId: string, input: number, output: number) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

export interface MockServer {
  url: string;
  /** Number of chat completions served, for assertions. */
  requests: () => number;
  stop: () => void;
}

export function startMockProvider(): MockServer {
  let requests = 0;

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") return Response.json({ data: [] });
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      requests++;
      const body = (await req.json()) as { model: string; messages: Array<{ role: string }> };
      const model = body.model;
      // Unique per response, exactly as a real provider behaves. Reusing one id
      // across turns would make the usage de-duplicator correctly collapse them.
      const responseId = `chatcmpl-${model}-${requests}`;

      if (model === "mock-error") {
        return Response.json(
          { error: { message: "mock provider failure", type: "server_error" } },
          { status: 500 },
        );
      }

      const tag = (model.split("-")[1] ?? "x").toUpperCase();
      const hasToolResult = body.messages.some((mm) => mm.role === "tool");

      const stream = new ReadableStream({
        async start(c) {
          const send = (o: unknown) => c.enqueue(new TextEncoder().encode(enc(o)));
          const done = () => {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          };

          if (model === "mock-slow") {
            send(chunk(model, responseId, { role: "assistant", content: "" }));
            for (let i = 0; i < 400; i++) {
              send(chunk(model, responseId, { content: `tick${i} ` }));
              await sleep(25);
            }
            send(chunk(model, responseId, {}, "stop"));
            send(usageChunk(model, responseId, 100, 400));
            done();
            return;
          }

          if (!hasToolResult) {
            send(chunk(model, responseId, { role: "assistant", content: "" }));
            for (const t of ["Working", " on", ` ${tag}`, ".\n"]) {
              send(chunk(model, responseId, { content: t }));
              await sleep(5);
            }
            send(
              chunk(model, responseId, {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${tag}`,
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        // The Vite-style "Local:" line exercises dev-server
                        // preview detection (session.preview) end to end.
                        command: `echo ${tag}-FROM-TOOL && echo "Local:   http://localhost:5199/" && pwd`,
                      }),
                    },
                  },
                ],
              }),
            );
            send(chunk(model, responseId, {}, "tool_calls"));
            send(usageChunk(model, responseId, 1000, 100));
          } else {
            send(chunk(model, responseId, { role: "assistant", content: "" }));
            for (const t of ["Done", " with", ` ${tag}`, "."]) {
              send(chunk(model, responseId, { content: t }));
              await sleep(5);
            }
            send(chunk(model, responseId, {}, "stop"));
            send(usageChunk(model, responseId, 1500, 50));
          }
          done();
        },
      });

      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    },
  });

  return {
    url: `${server.url.origin}/v1`,
    requests: () => requests,
    stop: () => server.stop(true),
  };
}

/** Register the mock models on a registry. */
export function registerMockModels(registry: ModelRegistry, baseUrl: string, ids: string[]): void {
  registry.registerProvider("mockprov", {
    baseUrl,
    apiKey: "mock-key",
    api: "openai-completions" as never,
    models: ids.map((id) => ({
      id,
      name: id,
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      supportsTools: true,
      // Non-zero so cost assertions exercise OMP's own cost computation.
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    })) as never,
  } as never);
}

export { AgentRegistry, ModelRegistry, SessionManager, Settings };
