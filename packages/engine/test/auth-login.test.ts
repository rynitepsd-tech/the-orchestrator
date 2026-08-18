/**
 * The GUI login controller against OMP's real login contract.
 *
 * These encode the new-user regressions from OMP 17.3.4: the localhost launch
 * URL must not be what the host opens, and the paste-code fallback prompt must
 * neither fail a live browser flow nor send OMP's manual-input retry loop into
 * an unthrottled spin (the "90 GB during setup" failure).
 */
import { describe, expect, test } from "bun:test";
import { type AuthLifecycleEvent, createLoginController } from "../src/auth-login";

function collector(): { events: AuthLifecycleEvent[]; emit: (e: AuthLifecycleEvent) => void } {
  const events: AuthLifecycleEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

const settled = (p: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
  ]);

describe("createLoginController", () => {
  test("opens the https authorize URL, not the localhost launch route", () => {
    const { events, emit } = collector();
    const { ctrl } = createLoginController("anthropic", emit);
    ctrl.onAuth({
      url: "https://claude.ai/oauth/authorize?code=true&state=abc",
      launchUrl: "http://localhost:54545/launch",
      instructions: "Complete login in your browser.",
    });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("browser");
    expect(events[0].url).toBe("https://claude.ai/oauth/authorize?code=true&state=abc");
  });

  test("falls back to the launch URL when no authorize URL is given", () => {
    const { events, emit } = collector();
    const { ctrl } = createLoginController("anthropic", emit);
    ctrl.onAuth({ launchUrl: "http://localhost:54545/launch" });
    expect(events[0].url).toBe("http://localhost:54545/launch");
  });

  test("answers optional prompts (allowEmpty) with the default", async () => {
    const { emit } = collector();
    const { ctrl } = createLoginController("github-copilot", emit);
    // GitHub Copilot asks for an enterprise domain before anything else;
    // blank means github.com.
    await expect(
      ctrl.onPrompt({ message: "GitHub Enterprise URL/domain", allowEmpty: true }),
    ).resolves.toBe("");
  });

  test("parks the paste-code prompt while a browser flow is live", async () => {
    const { events, emit } = collector();
    const { ctrl, failure } = createLoginController("anthropic", emit);
    ctrl.onAuth({
      url: "https://claude.ai/oauth/authorize",
      launchUrl: "http://localhost:1/launch",
    });

    const prompt = ctrl.onPrompt({
      message: "Paste the authorization code (or full redirect URL):",
    });
    // Never settles (a rejection would spin OMP's manual-input retry loop),
    // and the login as a whole must not be failed.
    expect(await settled(prompt)).toBe(false);
    expect(await settled(failure)).toBe(false);
    expect(events.filter((e) => e.status === "failed")).toHaveLength(0);
    expect(events.filter((e) => e.status === "prompt")).toHaveLength(1);
  });

  test("fails fast — once — for paste-code-only flows with no callback server", async () => {
    const { events, emit } = collector();
    const { ctrl, failure } = createLoginController("gitlab-duo", emit);
    ctrl.onAuth({ url: "https://gitlab.com/oauth/authorize" }); // no launchUrl

    const prompt = ctrl.onPrompt({ message: "Paste the authorization code:" });
    expect(await settled(prompt)).toBe(false); // still never rejects the prompt itself
    await expect(failure).rejects.toThrow(/does not support .* Run `omp` in a terminal/);
    expect(ctrl.signal.aborted).toBe(true);
    expect(events.filter((e) => e.status === "failed")).toHaveLength(1);
  });

  test("collapses identical consecutive frames so upstream loops cannot flood the pipe", () => {
    const { events, emit } = collector();
    const { ctrl } = createLoginController("anthropic", emit);
    for (let i = 0; i < 10_000; i++) ctrl.onProgress("Waiting for browser authentication...");
    ctrl.onAuth({
      url: "https://claude.ai/oauth/authorize",
      launchUrl: "http://localhost:1/launch",
    });
    for (let i = 0; i < 10_000; i++) {
      void ctrl.onPrompt({ message: "Paste the authorization code:" });
    }
    expect(events.filter((e) => e.status === "progress")).toHaveLength(1);
    expect(events.filter((e) => e.status === "prompt")).toHaveLength(1);
  });
});
