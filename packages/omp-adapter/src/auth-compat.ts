/**
 * One place for every call into OMP's credential store.
 *
 * OMP 18.3 rewrote `AuthStorage` from a flat class (`hasAuth`, `has`, `set`,
 * `login`, `logout`, `getCredentialOrigin`, `listDisabledCredentials`,
 * `fetchUsageReports`) into namespaces (`keys`, `credentials`, `oauth`,
 * `usage`, …). Every call site here reached the store through `any` with
 * optional chaining, so the rewrite type-checked cleanly and then answered
 * "not connected" for every provider — which the auth gate turns into
 * refusing every session, and which the picker renders as nothing usable.
 *
 * Each helper tries the namespaced API, then the flat one. Anything that
 * decides whether a session may run, or writes a credential, throws when
 * neither shape is present instead of quietly returning a default, so the
 * next reshaping fails a test rather than a user.
 */

/** Where a provider's working credential comes from, as OMP classifies it. */
export interface CredentialOrigin {
  kind: string;
  envVar?: string;
}

/** A tombstoned credential: OMP disabled it and recorded why. */
export interface DisabledCredential {
  provider: string;
  cause: string;
}

export class AuthApiUnavailableError extends Error {
  constructor(what: string) {
    super(`The embedded OMP's credential store has no recognised API for ${what}.`);
    this.name = "AuthApiUnavailableError";
  }
}

type AnyAuth = Record<string, any> | null | undefined;

function ns(
  auth: AnyAuth,
  name: "keys" | "credentials" | "oauth" | "usage",
): Record<string, any> | undefined {
  const v = auth?.[name];
  return v && typeof v === "object" ? v : undefined;
}

function fn(
  target: Record<string, any> | undefined,
  name: string,
): ((...a: any[]) => any) | undefined {
  const f = target?.[name];
  return typeof f === "function" ? f.bind(target) : undefined;
}

/**
 * Whether the provider has usable auth right now: runtime or config key,
 * an active (non-tombstoned) stored credential, the provider's own env var,
 * or a deliberately keyless configuration. Throws when OMP exposes no way
 * to ask — callers deciding availability must not read that as "no".
 */
export function providerHasAuth(auth: AnyAuth, provider: string): boolean {
  const keys = ns(auth, "keys");
  const source = fn(keys, "source");
  if (source) {
    if (source(provider) !== undefined) return true;
    const keyless = fn(keys, "keyless");
    return Boolean(keyless?.(provider));
  }
  const hasAuth = fn(auth ?? undefined, "hasAuth");
  if (hasAuth) return Boolean(hasAuth(provider));
  const has = fn(auth ?? undefined, "has");
  if (has) return Boolean(has(provider));
  throw new AuthApiUnavailableError("checking provider credentials");
}

/** Where the provider's auth comes from, or undefined when it has none. */
export function credentialOrigin(auth: AnyAuth, provider: string): CredentialOrigin | undefined {
  const source = fn(ns(auth, "keys"), "source") ?? fn(auth ?? undefined, "getCredentialOrigin");
  if (!source) return undefined;
  const origin = source(provider);
  if (!origin) return undefined;
  if (typeof origin === "string") return { kind: origin };
  if (typeof origin === "object" && typeof origin.kind === "string") {
    return {
      kind: origin.kind,
      envVar: typeof origin.envVar === "string" ? origin.envVar : undefined,
    };
  }
  return undefined;
}

/** Re-read the store so changes made by other processes are visible. */
export async function reloadCredentials(auth: AnyAuth): Promise<void> {
  const reload = fn(ns(auth, "credentials"), "reload") ?? fn(auth ?? undefined, "reload");
  if (reload) await reload();
}

/** Tombstoned credentials, optionally for one provider. Empty when OMP keeps none. */
export async function listDisabledCredentials(
  auth: AnyAuth,
  provider?: string,
): Promise<DisabledCredential[]> {
  const list =
    fn(ns(auth, "credentials"), "listDisabled") ?? fn(auth ?? undefined, "listDisabledCredentials");
  if (!list) return [];
  const rows = await list(provider);
  const out: DisabledCredential[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const cause = row?.cause ?? row?.disabledCause;
    if (row?.provider && cause) out.push({ provider: String(row.provider), cause: String(cause) });
  }
  return out;
}

/** Store an API key the way OMP's own `/login` does. Throws when unsupported. */
export async function storeApiKey(auth: AnyAuth, provider: string, key: string): Promise<void> {
  const set = fn(ns(auth, "credentials"), "set") ?? fn(auth ?? undefined, "set");
  if (!set) throw new AuthApiUnavailableError("storing an API key");
  await set(provider, { type: "api_key", key, source: "login" });
}

/** The provider's programmatic OAuth login, or undefined when OMP has none. */
export function oauthLogin(
  auth: AnyAuth,
): ((provider: string, ctrl: unknown) => Promise<unknown>) | undefined {
  return fn(ns(auth, "oauth"), "login") ?? fn(auth ?? undefined, "login");
}

/** Remove the provider's stored credentials. Throws when unsupported. */
export async function removeCredentials(auth: AnyAuth, provider: string): Promise<void> {
  const remove =
    fn(ns(auth, "credentials"), "remove") ??
    fn(auth ?? undefined, "logout") ??
    fn(auth ?? undefined, "remove");
  if (!remove) throw new AuthApiUnavailableError("removing credentials");
  await remove(provider);
}

/** OMP's own usage/quota reports. Empty when OMP reports none. */
export async function usageReports(auth: AnyAuth): Promise<unknown[]> {
  const reports = fn(ns(auth, "usage"), "reports") ?? fn(auth ?? undefined, "fetchUsageReports");
  if (!reports) return [];
  const r = await reports();
  return Array.isArray(r) ? r : r ? [r] : [];
}
