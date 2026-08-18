/**
 * The GUI login controller against OMP's real login contract.
 *
 * These encode the new-user regressions from OMP 17.3.4: the localhost launch
 * URL must not be what the host opens; questions from the flow (API keys,
 * paste-code fallback, enterprise domain) are bridged to the UI as prompt
 * events and answered via providers.loginAnswer; and `onPrompt` must never
 * reject, because OMP's manual-input race retries a rejection in an
 * unthrottled loop (the "90 GB during setup" failure).
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

  test("bridges a prompt to the UI and resolves it with the typed answer", async () => {
    const { events, emit } = collector();
    const { ctrl, answerPrompt } = createLoginController("aiand", emit);
    // API-key providers ask for the key through onPrompt (like the CLI).
    const pending = ctrl.onPrompt({ message: "Enter your aiand API key", allowEmpty: false });

    const prompt = events.find((e) => e.status === "prompt");
    expect(prompt?.promptId).toBeTruthy();
    expect(prompt?.message).toBe("Enter your aiand API key");
    expect(prompt?.allowEmpty).toBe(false);

    expect(answerPrompt(prompt!.promptId!, "sk-test-123", false)).toBe(true);
    await expect(pending).resolves.toBe("sk-test-123");
  });

  test("carries allowEmpty through so optional questions can take the default", async () => {
    const { events, emit } = collector();
    const { ctrl, answerPrompt } = createLoginController("github-copilot", emit);
    const pending = ctrl.onPrompt({
      message: "GitHub Enterprise URL/domain (blank for github.com)",
      allowEmpty: true,
    });
    const prompt = events.find((e) => e.status === "prompt");
    expect(prompt?.allowEmpty).toBe(true);
    expect(answerPrompt(prompt!.promptId!, "", false)).toBe(true);
    await expect(pending).resolves.toBe("");
  });

  test("cancel aborts the flow without ever rejecting the prompt promise", async () => {
    const { events, emit } = collector();
    const { ctrl, failure, answerPrompt } = createLoginController("anthropic", emit);
    const pending = ctrl.onPrompt({ message: "Paste the authorization code:" });
    const prompt = events.find((e) => e.status === "prompt");

    expect(answerPrompt(prompt!.promptId!, undefined, true)).toBe(true);
    await expect(failure).rejects.toThrow(/cancelled/);
    expect(ctrl.signal.aborted).toBe(true);
    // A rejection here would spin OMP's manual-input retry loop.
    expect(await settled(pending)).toBe(false);
  });

  test("returns false for a stale or already-answered promptId", () => {
    const { events, emit } = collector();
    const { ctrl, answerPrompt } = createLoginController("aiand", emit);
    void ctrl.onPrompt({ message: "Enter key" });
    const id = events.find((e) => e.status === "prompt")!.promptId!;
    expect(answerPrompt(id, "value", false)).toBe(true);
    expect(answerPrompt(id, "value", false)).toBe(false);
    expect(answerPrompt("nonsense", "value", false)).toBe(false);
  });

  test("collapses identical consecutive frames so upstream loops cannot flood the pipe", () => {
    const { events, emit } = collector();
    const { ctrl } = createLoginController("anthropic", emit);
    for (let i = 0; i < 10_000; i++) ctrl.onProgress("Waiting for browser authentication...");
    expect(events.filter((e) => e.status === "progress")).toHaveLength(1);
  });

  test("caps stacked unanswered prompts instead of flooding the UI", () => {
    const { events, emit } = collector();
    const { ctrl } = createLoginController("anthropic", emit);
    for (let i = 0; i < 10_000; i++) {
      void ctrl.onPrompt({ message: "Paste the authorization code:" });
    }
    expect(events.filter((e) => e.status === "prompt").length).toBeLessThanOrEqual(4);
  });
});
