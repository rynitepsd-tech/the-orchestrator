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
const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MockMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

function messageText(message: MockMessage): string {
  return typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

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
  stop: () => void;
}

export function startMockProvider(): MockServer {
  let requests = 0;
  const providerInstance = crypto.randomUUID();

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
      const body = (await req.json()) as { model: string; messages: MockMessage[] };
      const model = body.model;
      // Unique per response, exactly as a real provider behaves. Reusing one id
      // across turns would make the usage de-duplicator correctly collapse them.
      const responseId = `chatcmpl-${providerInstance}-${model}-${requests}`;

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

          if (model === "mock-concern") {
            const firstCandidate = body.messages.some((message) =>
              messageText(message).includes("candidate revision 1."),
            );
            send(chunk(model, responseId, { role: "assistant", content: "" }));
            if (firstCandidate && !hasToolResult) {
              send(
                chunk(model, responseId, {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_review_${requests}`,
                      type: "function",
                      function: {
                        name: "advise",
                        arguments: JSON.stringify({
                          note: "The candidate needs to account for its verification evidence.",
                          severity: "concern",
                        }),
                      },
                    },
                  ],
                }),
              );
              send(chunk(model, responseId, {}, "tool_calls"));
            } else {
              send(chunk(model, responseId, { content: "Review complete." }));
              send(chunk(model, responseId, {}, "stop"));
            }
            send(usageChunk(model, responseId, 80, 10));
            done();
            return;
          }

          if (model === "mock-review") {
            await sleep(80);
            send(
              chunk(model, responseId, {
                role: "assistant",
                content: "No actionable findings in this review.",
              }),
            );
            send(chunk(model, responseId, {}, "stop"));
            send(usageChunk(model, responseId, 80, 10));
            done();
            return;
          }

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
          if (model === "mock-publication") {
            await sleep(150);
            const requestIndex = body.messages.findLastIndex((message) =>
              messageText(message).includes("Active harness requestId:"),
            );
            const instruction = messageText(body.messages[requestIndex] ?? { role: "user" });
            const requestId = instruction.match(/Active harness requestId: ([\w-]+)/)?.[1];
            const findings: Array<{ id: string; revision: number }> = JSON.parse(
              instruction.match(/Review findings[^\n]*:\n([^\n]+)/)?.[1] ?? "[]",
            );
            const dispositions = findings.map((finding) => ({
              findingId: finding.id,
              revision: finding.revision,
              resolution: "accepted",
              rationale: "The recorded command outcome is now accounted for in this candidate.",
            }));
            const current = body.messages.slice(Math.max(0, requestIndex));
            const submitted = current.some((message) =>
              message.tool_calls?.some((call) => call.function?.name === "submit_answer"),
            );
            send(chunk(model, responseId, { role: "assistant", content: "" }));
            if (submitted) {
              send(
                chunk(model, responseId, {
                  content: "Post-submission progress must not replace the published answer.",
                }),
              );
              send(chunk(model, responseId, {}, "stop"));
            } else {
              const checked = current.some((message) => message.role === "tool");
              send(
                chunk(model, responseId, {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_publication_${requests}`,
                      type: "function",
                      function: {
                        name: checked ? "submit_answer" : "bash",
                        arguments: JSON.stringify(
                          checked
                            ? {
                                requestId,
                                text: `Canonical answer for request ${requestId}.`,
                                dispositions,
                              }
                            : { command: "sleep 0.2 && printf 'PUBLICATION-CHECK\\n'" },
                        ),
                      },
                    },
                  ],
                }),
              );
              send(chunk(model, responseId, {}, "tool_calls"));
            }
            send(usageChunk(model, responseId, 100, 25));
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
    stop: () => server.stop(true),
  };
}
