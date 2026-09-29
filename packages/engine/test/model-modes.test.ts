/**
 * MODEL MODES — slow mode and extended context through real worker processes.
 *
 * Both are per-session: slow mode through `AgentSession.setSlowMode`, extended
 * context through a runtime-only override of OMP's `extendedContext` setting
 * (one session per worker makes that per-session). The mock provider has
 * neither a flex tier nor a larger window, which pins the honest-failure
 * paths: the UI is told the mode is unavailable instead of a silent no-op.
 */
import { describe, expect, test } from "bun:test";
import { useHarness, waitFor } from "./harness";

const h = useHarness({ prefix: "orch-modes", modelIds: ["mock-alpha"] });
const { eventsOfType, makeProject } = h;

describe("model modes", () => {
  test("a session announces slow mode and extended context state at boot", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("modes-boot"),
      title: "Modes",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    expect(await waitFor(() => eventsOfType(s.sessionId, "session.slowMode").length > 0)).toBe(
      true,
    );
    const slow = eventsOfType(s.sessionId, "session.slowMode")[0] as any;
    expect(slow.available).toBe(false);
    expect(slow.enabled).toBe(false);
    const ctx = eventsOfType(s.sessionId, "session.extendedContext")[0] as any;
    expect(ctx.enabled).toBe(false);
    expect(ctx.contextWindow).toBe(128_000);
  }, 60_000);

  test("slow mode on a model without one reports ok=false", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("modes-slow"),
      title: "Slow",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    const r = await h.manager.route<{ ok: boolean; enabled: boolean }>(
      s.sessionId,
      "session.setSlowMode",
      { sessionId: s.sessionId, enabled: true },
    );
    expect(r.ok).toBe(false);
    expect(r.enabled).toBe(false);
  }, 60_000);

  test("extended context toggles per session and launches on when asked", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("modes-ctx"),
      title: "Ctx",
      model: "mockprov/mock-alpha",
      advisors: [],
      extendedContext: true,
    });
    expect(
      await waitFor(() =>
        eventsOfType(s.sessionId, "session.extendedContext").some((e: any) => e.enabled),
      ),
    ).toBe(true);
    const off = await h.manager.route<{ ok: boolean; enabled: boolean }>(
      s.sessionId,
      "session.setExtendedContext",
      { sessionId: s.sessionId, enabled: false },
    );
    expect(off).toMatchObject({ ok: true, enabled: false });
    const summary = h.manager.list().find((x) => x.sessionId === s.sessionId);
    expect(summary?.extendedContext).toBeUndefined();
  }, 60_000);
});
