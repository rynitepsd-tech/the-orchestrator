/**
 * AUTH COMPAT — the credential store as OMP actually ships it.
 *
 * OMP 18.3 moved `AuthStorage` to namespaces. The adapter reached it through
 * `any`, so the change type-checked and then reported every provider as not
 * connected — the auth gate would have refused every session. These tests
 * run the adapter's helpers against a real OMP store in a temp directory, so
 * the next reshaping fails here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import {
  AuthApiUnavailableError,
  credentialOrigin,
  listDisabledCredentials,
  providerAuthHealth,
  providerHasAuth,
  removeCredentials,
  storeApiKey,
  usageReports,
} from "../src";

// A provider id no real env var or stored credential on a dev machine uses.
const P = "orchestrator-test-provider";

describe("auth helpers against a real OMP credential store", () => {
  let dir: string;
  let auth: AuthStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-auth-"));
    auth = await AuthStorage.create(join(dir, "agent.db"));
  });
  afterEach(() => {
    auth.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("no credential reads as not connected, with no origin", () => {
    expect(providerHasAuth(auth, P)).toBe(false);
    expect(credentialOrigin(auth, P)).toBeUndefined();
  });

  test("a stored API key reads as connected, with its origin", async () => {
    await storeApiKey(auth, P, "sk-test-not-a-real-key");
    expect(providerHasAuth(auth, P)).toBe(true);
    expect(credentialOrigin(auth, P)?.kind).toBe("api_key");
    expect((await providerAuthHealth(auth as never, P)).usable).toBe(true);
  });

  test("a tombstoned credential is unusable and reports its cause (billing gate)", async () => {
    await storeApiKey(auth, P, "sk-test-not-a-real-key");
    const row = auth.credentials.list(P)[0];
    expect(row).toBeDefined();
    expect(await auth.credentials.disable(row!.id, "refresh token revoked")).toBe(true);
    expect(providerHasAuth(auth, P)).toBe(false);
    const health = await providerAuthHealth(auth as never, P);
    expect(health.usable).toBe(false);
    expect(health.disabledCause).toBe("refresh token revoked");
    expect(await listDisabledCredentials(auth, P)).toEqual([
      { provider: P, cause: "refresh token revoked" },
    ]);
  });

  test("removing credentials disconnects the provider", async () => {
    await storeApiKey(auth, P, "sk-test-not-a-real-key");
    await removeCredentials(auth, P);
    expect(providerHasAuth(auth, P)).toBe(false);
  });

  test("usage reports resolve without throwing", async () => {
    expect(Array.isArray(await usageReports(auth))).toBe(true);
  });
});

describe("auth helpers on the pre-18.3 flat API and on nothing", () => {
  test("flat hasAuth / getCredentialOrigin / set / logout still work", async () => {
    const stored = new Set<string>();
    const flat = {
      hasAuth: (p: string) => stored.has(p),
      getCredentialOrigin: (p: string) => (stored.has(p) ? { kind: "api_key" } : undefined),
      set: async (p: string) => void stored.add(p),
      logout: async (p: string) => void stored.delete(p),
    };
    await storeApiKey(flat, P, "k");
    expect(providerHasAuth(flat, P)).toBe(true);
    expect(credentialOrigin(flat, P)).toEqual({ kind: "api_key", envVar: undefined });
    await removeCredentials(flat, P);
    expect(providerHasAuth(flat, P)).toBe(false);
  });

  test("an unrecognised store throws instead of answering 'not connected'", async () => {
    expect(() => providerHasAuth({}, P)).toThrow(AuthApiUnavailableError);
    await expect(providerAuthHealth({} as never, P)).rejects.toThrow(AuthApiUnavailableError);
    await expect(storeApiKey({}, P, "k")).rejects.toThrow(AuthApiUnavailableError);
    await expect(removeCredentials({}, P)).rejects.toThrow(AuthApiUnavailableError);
  });
});
