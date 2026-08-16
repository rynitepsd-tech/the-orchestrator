/**
 * Secret redaction.
 *
 * Applied at every boundary that leaves the engine: log lines, error details,
 * tool arguments, and tool output. The engine owns credentials; the frontend
 * and the log files must never see them.
 */

const REDACTED = "[redacted]";

/** Key names whose values are always replaced, regardless of shape. */
const SENSITIVE_KEY_RE =
  // snake/kebab compounds and exact words…
  // …plus camelCase compounds (authToken, clientSecret, userApiKey). The
  // camel arm requires the singular capitalised suffix so usage-counter keys
  // like `inputTokens`/`totalTokens` are never scrubbed. The compound prefix
  // accepts both separators (x-api-key as well as my_api_key).
  /^(?:(?:.*[-_])?(?:api[-_]?key|apikey|secret|password|passwd|token|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|authorization|auth|cookie|session[-_]?key|private[-_]?key|client[-_]?secret|credential[s]?)|[a-z][A-Za-z0-9]*(?:Token|Secret|Password|ApiKey))$/i;

/**
 * Value patterns that look like credentials even under an innocuous key.
 * Ordered most-specific first so a generic rule cannot mask a specific one.
 */
const VALUE_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Authorization headers
  { re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  // Common vendor key shapes
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { re: /\bgho_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: REDACTED },
  // Stripe / npm tokens
  { re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { re: /\bnpm_[A-Za-z0-9]{30,}/g, replace: REDACTED },
  // URL basic auth: scheme://user:password@host
  { re: /\b(https?:\/\/[^/\s:@]+:)[^/\s:@]+@/gi, replace: `$1${REDACTED}@` },
  // OAuth-style JSON bodies
  {
    re: /("(?:access|refresh|id)_token"\s*:\s*")[^"]{6,}(")/gi,
    replace: `$1${REDACTED}$2`,
  },
  // PEM / PGP private-key blocks. The body match is BOUNDED — an unclosed
  // BEGIN header in megabytes of output must not go quadratic (ReDoS).
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,20000}?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replace: REDACTED,
  },
  // key=value / key: value in free text. The prefix arm covers env-style
  // names (GITHUB_TOKEN=, MY_API_KEY:) where \b cannot sit after "_".
  {
    re: /\b([\w-]*(?:api[-_]?key|token|secret|password|authorization)\s*[=:]\s*)(["']?)[^\s"',;]{6,}\2/gi,
    replace: `$1${REDACTED}`,
  },
];

/** Redact secrets from a free-text string. */
export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { re, replace } of VALUE_PATTERNS) {
    // Reset lastIndex — these regexes are module-level and /g is stateful.
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Deep-redact a structure. Sensitive keys are replaced wholesale; every string
 * is additionally scanned for credential-shaped values.
 */
export function redactValue<T>(value: T, depth = 0): T {
  // Depth cap fails CLOSED: an over-deep subtree is dropped, never passed
  // through raw — depth-nesting a secret must not be an escape hatch.
  if (depth > 12) return "[redacted:depth]" as unknown as T;

  if (typeof value === "string") return redactText(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      // Only string-ish values can BE credentials. Replacing a boolean with
      // the truthy string "[redacted]" flips flags like `secret: false`
      // (extension inputs would all render as password fields).
      out[k] = typeof v === "string" || typeof v === "number" ? REDACTED : v;
    } else if (/^env$/i.test(k) && v && typeof v === "object") {
      // Environment maps: redact by key name, keep names visible for debugging.
      const env: Record<string, unknown> = {};
      for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
        env[ek] =
          SENSITIVE_KEY_RE.test(ek) || /KEY|TOKEN|SECRET|PASSWORD/i.test(ek)
            ? REDACTED
            : redactValue(ev, depth + 1);
      }
      out[k] = env;
    } else {
      out[k] = redactValue(v, depth + 1);
    }
  }
  return out as unknown as T;
}

/** Truncate FIRST, then redact — the size cap is the ReDoS guard, so the
 * regexes must only ever see capped input. */
export function sanitizeOutput(
  text: string,
  maxBytes = 256 * 1024,
): { output: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { output: redactText(text), truncated: false };
  }
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  return {
    output: `${redactText(buf.toString("utf8"))}\n… output truncated …`,
    truncated: true,
  };
}
