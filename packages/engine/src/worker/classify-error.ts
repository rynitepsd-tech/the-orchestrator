/**
 * Map an upstream failure onto the product error taxonomy — never a raw stack.
 *
 * Lives apart from `worker/main.ts` because that module is a process entry
 * point: importing it to test this would boot a whole worker.
 */
import type { EngineErrorPayload, ErrorKind } from "@orchestrator/protocol";

/**
 * A provider refusing a model because the CLIENT is too old, not because the
 * model is missing or the account lacks entitlement.
 *
 * This is reachable in normal use: OMP discovers models from the provider's
 * live endpoint, so a model released after the pinned OMP appears in the
 * picker and is only rejected when it is first used. Anthropic answers with
 * `claude_code_version_too_old` and advises running `claude update` — a
 * different product, which nobody here has. Left unclassified it surfaced as
 * a raw 400 JSON blob carrying that misdirection.
 */
const CLIENT_TOO_OLD =
  /(version_too_old|does not support this model|requires? (a )?(newer|later) version|upgrade your client)/i;

/** Extract the provider's own human sentence from a JSON error envelope. */
function providerMessage(raw: string): string | undefined {
  const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

export function classifyError(e: unknown): EngineErrorPayload {
  const msg = String((e as Error)?.message ?? e);
  const lower = msg.toLowerCase();
  let kind: ErrorKind = "unknown";
  if (/abort/.test(lower)) kind = "unknown";
  else if (/(unauthorized|401|invalid api key|authentication|credential)/.test(lower))
    kind = "auth";
  else if (/(rate.?limit|quota|429|usage limit|overloaded)/.test(lower)) kind = "provider-quota";
  else if (CLIENT_TOO_OLD.test(msg)) {
    // Ranked above the generic "model not available" test: both can match, and
    // only this one can tell the user what would actually fix it.
    const detail = providerMessage(msg);
    return {
      kind: "model-unavailable",
      message:
        "This model needs a newer OMP than the one this build embeds. Update The Orchestrator, or pick another model.",
      detail: detail ? `${detail}\n\n${msg.slice(0, 4000)}` : msg.slice(0, 4000),
      retryable: false,
    };
  } else if (/(model .*not (found|available)|no such model|unknown model)/.test(lower))
    kind = "model-unavailable";
  else if (/(enoent|eacces|eperm|permission denied)/.test(lower)) kind = "filesystem-permission";
  else if (/mcp/.test(lower)) kind = "mcp";
  return {
    kind,
    message: msg.slice(0, 300),
    detail: msg.length > 300 ? msg.slice(0, 4000) : undefined,
    retryable: kind === "provider-quota",
  };
}
