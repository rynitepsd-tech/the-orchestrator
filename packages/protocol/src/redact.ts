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
  /^(?:.*_)?(?:api[-_]?key|apikey|secret|password|passwd|token|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|authorization|auth|cookie|session[-_]?key|private[-_]?key|client[-_]?secret|credential[s]?)$/i;

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
  // PEM blocks
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  // key=value / key: value in free text
  {
    re: /\b((?:api[-_]?key|token|secret|password|authorization)\s*[=:]\s*)(["']?)[^\s"',;]{6,}\2/gi,
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
  if (depth > 12) return value;

  if (typeof value === "string") return redactText(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else if (/^env$/i.test(k) && v && typeof v === "object") {
      // Environment maps: redact by key name, keep names visible for debugging.
      const env: Record<string, unknown> = {};
      for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
        env[ek] = SENSITIVE_KEY_RE.test(ek) || /KEY|TOKEN|SECRET|PASSWORD/i.test(ek)
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

/** Redact and truncate a tool output body for transport. */
export function sanitizeOutput(
  text: string,
  maxBytes = 256 * 1024,
): { output: string; truncated: boolean } {
  const redacted = redactText(text);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) {
    return { output: redacted, truncated: false };
  }
  const buf = Buffer.from(redacted, "utf8").subarray(0, maxBytes);
  return { output: `${buf.toString("utf8")}\n… output truncated …`, truncated: true };
}
