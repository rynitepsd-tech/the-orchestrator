/**
 * SETTINGS OVERRIDES — runtime-only, per-session, and fail-closed.
 *
 * OMP 18.4 removed `Settings.override(path, value)`. The worker used to probe
 * for it and silently skip, which would have left `tools.approvalMode` at
 * OMP's default ("yolo") — "always ask" quietly becoming full access. These
 * tests pin the replacement against the real installed OMP, and pin that
 * every failure throws instead of passing silently.
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import {
  loadSettingLookup,
  type SettingHandle,
  settingOverrides,
} from "../src/worker/settings-override";

describe("settings overrides against the real OMP", () => {
  test("the registry lookup is available on the pinned OMP", async () => {
    expect(typeof (await loadSettingLookup())).toBe("function");
  });

  test("approval mode override takes effect and reads back", async () => {
    const settings = Settings.isolated();
    const o = settingOverrides(settings, await loadSettingLookup());
    // OMP's own default — the value a skipped override would leave in force.
    expect(o.read("tools.approvalMode")).toBe("yolo");
    for (const mode of ["always-ask", "write", "yolo"] as const) {
      o.overrideVerified("tools.approvalMode", mode);
      expect(o.read("tools.approvalMode")).toBe(mode);
    }
    o.overrideVerified("tools.approval", { bash: "allow", delete: "allow", move: "allow" });
    expect(o.read("tools.approval")).toEqual({ bash: "allow", delete: "allow", move: "allow" });
  });

  test("extended context override takes effect", async () => {
    const settings = Settings.isolated();
    const o = settingOverrides(settings, await loadSettingLookup());
    expect(o.read("extendedContext")).toBe(false);
    o.overrideVerified("extendedContext", true);
    expect(o.read("extendedContext")).toBe(true);
  });

  test("an override is never persisted to the global layer", async () => {
    const settings = Settings.isolated();
    const o = settingOverrides(settings, await loadSettingLookup());
    o.override("tools.approvalMode", "always-ask");
    const global = settings.getGlobalSettings() as Record<string, unknown>;
    expect(JSON.stringify(global)).not.toContain("always-ask");
  });

  test("the removed path-addressed method is really gone (why the helper exists)", () => {
    const settings = Settings.isolated() as unknown as Record<string, unknown>;
    expect(typeof settings.override).not.toBe("function");
  });
});

describe("settings overrides fail closed", () => {
  test("no registry handle and no legacy method throws", () => {
    const o = settingOverrides({}, () => undefined);
    expect(() => o.override("tools.approvalMode", "always-ask")).toThrow(/no way to override/);
  });

  test("an override that does not read back throws", () => {
    const inert: SettingHandle = { override() {}, get: () => "yolo" };
    const o = settingOverrides({}, () => inert);
    expect(() => o.overrideVerified("tools.approvalMode", "always-ask")).toThrow(
      /did not take effect/,
    );
  });

  test("falls back to the pre-18.4 path-addressed method", () => {
    const store: Record<string, unknown> = {};
    const legacy = {
      override(id: string, v: unknown) {
        store[id] = v;
      },
      get: (id: string) => store[id],
    };
    const o = settingOverrides(legacy, undefined);
    o.overrideVerified("tools.approvalMode", "write");
    expect(store["tools.approvalMode"]).toBe("write");
  });
});
