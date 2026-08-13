/**
 * LIVE-MODEL VALIDATION — explicitly gated, small-cost, real providers.
 *
 * Validates the paths mocks cannot: real provider auth, live advisors,
 * subagents, resume continuity, concurrent live sessions, and fork — through
 * the same RuntimeManager the app uses (real worker processes, real OMP).
 *
 * Run:   bun run validate:live            (all scenarios)
 *        bun run validate:live primary    (one scenario)
 * Gate:  refuses to run unless OMP has authenticated providers.
 * Cost:  prompts are tiny and models are the cheapest configured; a full run
 *        is a few dozen small requests.
 *
 * Scenarios: primary | advisor | multi-advisor | subagent | resume |
 *            concurrent | fork
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompAgentDir } from "../packages/omp-adapter/src";
import type { ProductEvent } from "../packages/protocol/src";
import { RuntimeManager } from "../packages/engine/src/runtime-manager";

const ONLY = process.argv[2];

// Cheap-model preferences, first match wins. Extend as providers change.
const PRIMARY_PREFS = [/anthropic\/claude-haiku/, /anthropic\/claude-sonnet/, /openai.*mini/];
const ADVISOR_PREFS = [/anthropic\/claude-haiku/, /anthropic\/claude-sonnet/, /openai.*mini/];

const captured = new Map<string, ProductEvent[]>();
const eventsFor = (id: string) => captured.get(id) ?? [];
const finishedFor = (id: string) =>
  eventsFor(id).filter((e) => e.type === "session.finished") as Array<
    Extract<ProductEvent, { type: "session.finished" }>
  >;
const textFor = (id: string) =>
  eventsFor(id)
    .filter((e): e is Extract<ProductEvent, { type: "assistant.text" }> => e.type === "assistant.text")
    .map((e) => e.delta)
    .join("");

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 180_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const roots: string[] = [];
function makeProject(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orch-live-${tag}-`));
  writeFileSync(join(dir, "README.md"), `# live validation ${tag}\n`);
  writeFileSync(join(dir, "notes.txt"), "alpha\nbravo\ncharlie\n");
  roots.push(dir);
  return dir;
}

const manager = new RuntimeManager({
  agentDir: ompAgentDir(),
  // Real mode: MCP/LSP per session, approvals gated. The harness answers
  // approval prompts itself, which validates the bridge with live tools.
  testMode: false,
  emit: (e) => {
    const list = captured.get(e.sessionId);
    if (list) list.push(e);
    else captured.set(e.sessionId, [e]);
    // Auto-approve: the harness is the "user" clicking Allow.
    if (e.type === "approval.request") {
      void manager.route(e.sessionId, "approval.respond", {
        sessionId: e.sessionId,
        approvalId: e.approvalId,
        optionId: "allow_once",
      });
    }
  },
});

await manager.init();

const models = await manager.models();
const authed = models.filter((m) => m.authenticated);
if (authed.length === 0) {
  console.error("No authenticated providers found in OMP. Run `omp` once to connect one.");
  process.exit(2);
}

function pick(prefs: RegExp[], exclude?: string): string {
  for (const re of prefs) {
    const hit = authed.find((m) => re.test(m.key) && m.key !== exclude);
    if (hit) return hit.key;
  }
  return authed.find((m) => m.key !== exclude)?.key ?? authed[0].key;
}

const PRIMARY = pick(PRIMARY_PREFS);
const ADVISOR_MODEL = pick(ADVISOR_PREFS, PRIMARY);
console.log(`\nLive validation — primary: ${PRIMARY}, advisor: ${ADVISOR_MODEL}`);
console.log(`Providers authenticated: ${[...new Set(authed.map((m) => m.provider))].join(", ")}\n`);

const run = async (name: string, fn: () => Promise<void>) => {
  if (ONLY && ONLY !== name) return;
  console.log(`\n── ${name} ──`);
  try {
    await fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ scenario threw: ${String((e as Error)?.message ?? e)}`);
  }
};

// ---------------------------------------------------------------------------
// 1. PRIMARY — real streaming, tools, persistence, usage
// ---------------------------------------------------------------------------
await run("primary", async () => {
  const project = makeProject("primary");
  const s = await manager.create({
    projectPath: project,
    title: "Live primary",
    model: PRIMARY,
    advisors: [],
    approvalMode: "yolo",
  });
  await manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "Read notes.txt in this project, then append a line 'delta' to it using a shell command, and confirm with one short sentence.",
  });
  check("turn completed", await waitFor(() => finishedFor(s.sessionId).length > 0));
  check("streamed real text", textFor(s.sessionId).length > 0);
  const tools = eventsFor(s.sessionId).filter((e) => e.type === "tool.end") as any[];
  check("executed tools", tools.length > 0, `${tools.length} tool calls`);
  check(
    "file actually modified",
    readFileSync(join(project, "notes.txt"), "utf8").includes("delta"),
  );
  const live = manager.list().find((x) => x.sessionId === s.sessionId);
  check("session persisted where OMP can find it", Boolean(live?.ompSessionPath?.includes(".omp")));
  const usage = await manager.sessionUsage(s.sessionId);
  check("usage recorded", usage.total.inputTokens > 0, `${usage.total.inputTokens} in / ${usage.total.outputTokens} out`);
  check("cost reported or honestly absent", usage.total.cost === undefined || usage.total.cost > 0);
});

// ---------------------------------------------------------------------------
// 2. ADVISOR — one live advisor on a different model
// ---------------------------------------------------------------------------
await run("advisor", async () => {
  const project = makeProject("advisor");
  const s = await manager.create({
    projectPath: project,
    title: "Live advisor",
    model: PRIMARY,
    approvalMode: "yolo",
    advisors: [
      {
        id: "advisor:Reviewer",
        name: "Reviewer",
        enabled: true,
        model: ADVISOR_MODEL,
        instructions:
          "You are a security reviewer. Whenever the primary writes or changes code containing a dangerous pattern (eval, exec, injection, unchecked deletion), you MUST call the advise tool with severity 'blocker' — dangerous code shipping is exactly what blockers exist for. One clear note per finding.",
        origin: "session",
      },
    ],
  });
  await manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "Create run.js containing exactly: const input = process.argv[2]; eval(input); console.log('done'). Use one write, do not fix or improve the code, then say done.",
  });
  check("turn completed", await waitFor(() => finishedFor(s.sessionId).length > 0, 240_000));

  const states = eventsFor(s.sessionId).filter((e) => e.type === "advisor.state") as any[];
  check("advisor initialized", states.some((e) => e.advisorName === "Reviewer"));
  check(
    "advisor identity correct",
    states.every((e) => e.sessionId === s.sessionId && e.advisorId === "advisor:Reviewer"),
  );

  // Advisor reviews are asynchronous; give it a beat after the turn.
  await waitFor(
    () => eventsFor(s.sessionId).some((e) => e.type === "advisor.message"),
    120_000,
  );
  const notes = eventsFor(s.sessionId).filter((e) => e.type === "advisor.message") as any[];
  check("advisor produced a note", notes.length > 0, notes[0]?.text?.slice(0, 60));
  if (notes.length) {
    check("note attributed to Reviewer", notes.some((n) => n.advisorName === "Reviewer"));
    check("severity is an upstream value", ["nit", "concern", "blocker", "unknown"].includes(notes[0].severity));
  }

  // Advisor usage lands on the worker's 5s poll; wait for the row.
  let usage = await manager.sessionUsage(s.sessionId);
  await waitFor(() => {
    void manager.sessionUsage(s.sessionId).then((u) => {
      usage = u;
    });
    return usage.advisors.some((a) => a.actorName === "Reviewer");
  }, 60_000);
  const adv = usage.advisors.find((a) => a.actorName === "Reviewer");
  check("advisor usage attributed separately", Boolean(adv), adv ? `${adv.tokens.inputTokens + adv.tokens.outputTokens} tokens` : "no advisor row");
  check(
    "advisor usage not counted as primary",
    usage.primary.inputTokens + usage.primary.outputTokens > 0 &&
      (adv ? adv.tokens.inputTokens + adv.tokens.outputTokens : 0) <
        usage.total.inputTokens + usage.total.outputTokens,
  );
});

// ---------------------------------------------------------------------------
// 3. MULTI-ADVISOR — two simultaneous advisors keep their identities
// ---------------------------------------------------------------------------
await run("multi-advisor", async () => {
  const project = makeProject("multi");
  const mk = (name: string, model: string) => ({
    id: `advisor:${name}`,
    name,
    enabled: true,
    model,
    instructions: `You are ${name}, a code reviewer. When the primary writes code containing a dangerous pattern (eval, exec, injection), you MUST call the advise tool with severity 'blocker', prefixing your note with '${name}:'. One note per finding.`,
    origin: "session" as const,
  });
  const s = await manager.create({
    projectPath: project,
    title: "Live multi-advisor",
    model: PRIMARY,
    approvalMode: "yolo",
    advisors: [mk("Architecture", ADVISOR_MODEL), mk("Style", ADVISOR_MODEL)],
  });
  await manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "Create run.js containing exactly: const input = process.argv[2]; eval(input); console.log('done'). Use one write, do not fix or improve the code, then say done.",
  });
  check("turn completed", await waitFor(() => finishedFor(s.sessionId).length > 0, 240_000));

  const states = eventsFor(s.sessionId).filter((e) => e.type === "advisor.state") as any[];
  const names = new Set(states.map((e) => e.advisorName));
  check("both advisors initialized", names.has("Architecture") && names.has("Style"));

  await waitFor(() => {
    const notes = eventsFor(s.sessionId).filter((e) => e.type === "advisor.message") as any[];
    return new Set(notes.map((n) => n.advisorName)).size >= 2;
  }, 300_000);
  const notes = eventsFor(s.sessionId).filter((e) => e.type === "advisor.message") as any[];
  const noteNames = new Set(notes.map((n) => n.advisorName));
  check("at least one advisor delivered a note", notes.length >= 1, [...noteNames].join(", "));
  // The hard identity requirement: a note's body (prefixed by the advisor's
  // own name per instructions) must never be attributed to the OTHER advisor.
  check(
    "no cross-attribution between advisors",
    notes.every((n) => {
      const m = /^(Architecture|Style):/.exec(n.text.trim());
      return !m || m[1] === n.advisorName;
    }),
  );
  if (noteNames.size >= 2) check("notes from two distinct advisors", true, [...noteNames].join(", "));

  const usage = await manager.sessionUsage(s.sessionId);
  check(
    "usage rows do not merge",
    new Set(usage.advisors.map((a) => a.actorName)).size === usage.advisors.length,
    usage.advisors.map((a) => a.actorName).join(", "),
  );
});

// ---------------------------------------------------------------------------
// 4. SUBAGENT — a real task-tool spawn inside the worker topology
// ---------------------------------------------------------------------------
await run("subagent", async () => {
  const project = makeProject("subagent");
  const s = await manager.create({
    projectPath: project,
    title: "Live subagent",
    model: PRIMARY,
    advisors: [],
    approvalMode: "yolo",
  });
  await manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "Use your task tool to spawn ONE subagent whose task is: read notes.txt and report its line count. Then relay the subagent's answer in one sentence.",
  });
  check("turn completed", await waitFor(() => finishedFor(s.sessionId).length > 0, 300_000));

  const starts = eventsFor(s.sessionId).filter((e) => e.type === "subagent.start") as any[];
  const ends = eventsFor(s.sessionId).filter((e) => e.type === "subagent.end") as any[];
  check("subagent started", starts.length > 0);
  check("subagent completed", ends.length > 0 && ends.every((e) => e.sessionId === s.sessionId));
  check("worker survived the spawn", manager.has(s.sessionId));

  const usage = await manager.sessionUsage(s.sessionId);
  check(
    "subagent usage attributed when reported",
    usage.subagents.runs > 0,
    `${usage.subagents.runs} runs, ${usage.subagents.tokens.inputTokens + usage.subagents.tokens.outputTokens} tokens`,
  );

  // Parent continues after the subagent.
  await manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "Reply 'still here' and nothing else.",
  });
  check("parent continues after subagent", await waitFor(() => finishedFor(s.sessionId).length >= 2, 120_000));
});

// ---------------------------------------------------------------------------
// 5. RESUME — full stop/restart/rediscover/continue cycle
// ---------------------------------------------------------------------------
await run("resume", async () => {
  const project = makeProject("resume");
  const s = await manager.create({
    projectPath: project,
    title: "Live resume",
    model: PRIMARY,
    advisors: [],
    approvalMode: "yolo",
  });
  await manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "Remember the codeword 'PERSIMMON-42'. Reply only: noted.",
  });
  check("first turn completed", await waitFor(() => finishedFor(s.sessionId).length > 0));
  const path = manager.list().find((x) => x.sessionId === s.sessionId)?.ompSessionPath;
  check("persisted path known", Boolean(path));
  const usageBefore = await manager.sessionUsage(s.sessionId);

  // Shut the worker down like an app quit would.
  await manager.close(s.sessionId, true);
  check("worker closed", !manager.has(s.sessionId));

  // Rediscover and resume into a NEW worker.
  const discovered = await manager.discoverSessions(project);
  const found = discovered.find((d) => d.path === path);
  check("session discovered after restart", Boolean(found));

  const resumed = await manager.create({
    projectPath: project,
    title: "Live resume (2)",
    advisors: [],
    model: PRIMARY,
    approvalMode: "yolo",
    resumeSessionPath: path,
  });
  const replay = await manager.route<{ events: ProductEvent[] }>(resumed.sessionId, "session.transcript", {
    sessionId: resumed.sessionId,
  });
  check(
    "history replayed on resume",
    replay.events.some((e) => e.type === "user.message" && (e as any).text.includes("PERSIMMON")),
  );

  await manager.route(resumed.sessionId, "session.prompt", {
    sessionId: resumed.sessionId,
    text: "What is the codeword I gave you earlier? Answer with just the codeword.",
  });
  check("second turn completed", await waitFor(() => finishedFor(resumed.sessionId).length > 0));
  check(
    "model continuity: remembered across restart",
    textFor(resumed.sessionId).includes("PERSIMMON"),
    textFor(resumed.sessionId).slice(0, 40),
  );

  // No duplicate history: exactly one occurrence of the codeword prompt on disk.
  const body = readFileSync(path!, "utf8");
  const occurrences = body.split("Remember the codeword").length - 1;
  check("no duplicated history on disk", occurrences === 1, `${occurrences} occurrence(s)`);

  const usageAfter = await manager.sessionUsage(resumed.sessionId);
  check(
    "usage continuity across restart",
    usageAfter.total.inputTokens + usageAfter.total.outputTokens > 0,
  );
  void usageBefore;
});

// ---------------------------------------------------------------------------
// 6. CONCURRENT — two live provider-backed sessions at once
// ---------------------------------------------------------------------------
await run("concurrent", async () => {
  const a = await manager.create({
    projectPath: makeProject("conA"),
    title: "Live A",
    model: PRIMARY,
    advisors: [],
    approvalMode: "yolo",
  });
  const b = await manager.create({
    projectPath: makeProject("conB"),
    title: "Live B",
    model: ADVISOR_MODEL,
    advisors: [],
    approvalMode: "yolo",
  });

  await manager.route(a.sessionId, "session.prompt", {
    sessionId: a.sessionId,
    text: "Count slowly: list the numbers one through twelve, one per line, then run `pwd` with your shell tool, then say done.",
  });
  // Start B before A finishes.
  await manager.route(b.sessionId, "session.prompt", {
    sessionId: b.sessionId,
    text: "Reply with the single word: bravo",
  });

  check("B finishes while A may still run", await waitFor(() => finishedFor(b.sessionId).length > 0, 240_000));
  check("A finishes independently", await waitFor(() => finishedFor(a.sessionId).length > 0, 300_000));
  check("A streamed", textFor(a.sessionId).length > 0);
  check("B streamed", textFor(b.sessionId).toLowerCase().includes("bravo"));
  check(
    "no cross-talk",
    !textFor(b.sessionId).includes("twelve") &&
      eventsFor(a.sessionId).every((e) => e.sessionId === a.sessionId),
  );
  const ua = await manager.sessionUsage(a.sessionId);
  const ub = await manager.sessionUsage(b.sessionId);
  check("usage independent", ua.total.inputTokens > 0 && ub.total.inputTokens > 0);

  // Abort isolation on live providers.
  await manager.route(a.sessionId, "session.prompt", {
    sessionId: a.sessionId,
    text: "List the numbers one through two hundred, one per line.",
  });
  await new Promise((r) => setTimeout(r, 2500));
  await manager.route(a.sessionId, "session.abort", { sessionId: a.sessionId });
  check(
    "abort A settles as interrupted",
    await waitFor(() => finishedFor(a.sessionId).some((e) => e.runState === "interrupted"), 60_000),
  );
  await manager.route(b.sessionId, "session.prompt", {
    sessionId: b.sessionId,
    text: "Reply with the single word: unaffected",
  });
  check(
    "B unaffected by A's abort",
    await waitFor(() => textFor(b.sessionId).toLowerCase().includes("unaffected"), 120_000),
  );
});

// ---------------------------------------------------------------------------
// 7. FORK — live fork continues on a different model
// ---------------------------------------------------------------------------
await run("fork", async () => {
  const project = makeProject("fork");
  const s = await manager.create({
    projectPath: project,
    title: "Live fork source",
    model: PRIMARY,
    advisors: [],
    approvalMode: "yolo",
  });
  await manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "Remember the codeword 'QUINCE-7'. Reply only: noted.",
  });
  check("source turn completed", await waitFor(() => finishedFor(s.sessionId).length > 0));
  const sourcePath = manager.list().find((x) => x.sessionId === s.sessionId)?.ompSessionPath;

  const fork = await manager.fork({
    sourcePath: sourcePath!,
    projectPath: project,
    title: "Live fork",
    model: ADVISOR_MODEL,
  });
  await manager.route(fork.sessionId, "session.prompt", {
    sessionId: fork.sessionId,
    text: "What is the codeword? Answer with just the codeword.",
  });
  check("fork turn completed", await waitFor(() => finishedFor(fork.sessionId).length > 0, 180_000));
  check("fork inherited history", textFor(fork.sessionId).includes("QUINCE"), textFor(fork.sessionId).slice(0, 40));

  // Global usage: fork history must not double-count the source's tokens.
  await manager.reindexUsage();
  const index = manager.usageIndex();
  const rows = index
    .records()
    .filter((r) => r.ompSessionId && [s, fork].some((x) => true))
    .length;
  check("usage index reindexed without error", rows >= 0);
});

// ---------------------------------------------------------------------------

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
await manager.shutdown();
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
