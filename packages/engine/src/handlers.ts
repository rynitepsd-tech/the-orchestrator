/**
 * Request handlers.
 *
 * One exhaustive switch over the protocol's request union, so adding a request
 * type without handling it is a type error rather than a runtime surprise.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  gitChanges,
  gitDiff,
  inspectProject,
  isInsideRoot,
  listProjectFiles,
  projectIdFor,
  readProjectFile,
  realParentPath,
  shipChanges,
} from "@orchestrator/omp-adapter";
import type {
  EngineRequest,
  RequestType,
  ResponsePayloads,
  UsageRecord,
} from "@orchestrator/protocol";
import { appSupportDir, engineLogPath } from "./logging";
import type { EngineServer } from "./server";

/** Symlink-resolved project roots of live sessions — the read allowlist. */
function liveProjectRoots(m: EngineServer["manager"]): string[] {
  const roots = new Set<string>();
  for (const s of m.list()) {
    try {
      roots.add(realpathSync(s.projectPath));
    } catch {
      /* a vanished project dir guards itself */
    }
  }
  return [...roots];
}

export async function handleRequest(
  server: EngineServer,
  req: EngineRequest,
): Promise<ResponsePayloads[RequestType]> {
  const m = server.manager;
  const p = req.payload as any;

  // Project-scoped reads must target an OPEN project. The path arrives from
  // the webview, which is not trusted to define its own containment root.
  const requireOpenProject = (path: string): string => {
    let real: string;
    try {
      real = realpathSync(String(path));
    } catch {
      real = "";
    }
    if (!real || !liveProjectRoots(m).includes(real)) {
      throw Object.assign(new Error("Not an open project folder."), { kind: "configuration" });
    }
    return real;
  };

  switch (req.type as RequestType) {
    // --- engine ------------------------------------------------------------
    case "engine.hello":
      return server.info();

    case "engine.shutdown": {
      // The ack must be honest: the host quits the moment this resolves, so
      // responding before teardown made its 20s budget illusory — the OS then
      // SIGKILLed workers mid-dispose. Teardown completes first; the response
      // is written after, and the read loop ends via onStopped.
      await server.shutdown();
      return { stopping: true };
    }

    case "engine.diagnostics": {
      const warnings: string[] = [];
      if (server.testMode) {
        warnings.push(
          "TEST MODE is active: tool approvals are disabled. This must never appear in normal use.",
        );
      }
      return {
        info: server.info(),
        sessions: m.list().length,
        activeSessions: m.activeCount(),
        logPath: engineLogPath(),
        warnings,
        workers: await m.workerStats(),
      };
    }

    // --- catalogue ---------------------------------------------------------
    case "models.list":
      return { models: await m.models(p?.refresh === true) };

    case "providers.list":
      return { providers: await m.providers() };

    case "providers.quota":
      return { quotas: await m.quotas() };

    case "providers.login":
      return m.login(
        String(p.provider),
        (e) => server.emitLifecycle(e),
        p.apiKey !== undefined ? String(p.apiKey) : undefined,
      );

    case "providers.loginAnswer":
      return {
        ok: m.answerLoginPrompt(
          String(p.promptId),
          p.answer !== undefined ? String(p.answer) : undefined,
          p.cancel === true,
        ),
      };

    case "providers.logout":
      return m.logout(String(p.provider));

    // --- projects ----------------------------------------------------------
    case "project.open":
      return { project: await inspectProject(String(p.path)) };

    case "project.environment":
      return { advisors: await m.projectAdvisors(String(p.path)) };

    case "project.changes":
      return gitChanges(requireOpenProject(p.path));

    case "project.diff": {
      // The untracked-file fallback in gitDiff reads the file from disk, so
      // `file` must be contained the same way readProjectFile contains its
      // target — the boundary is engine-enforced, not a UI courtesy.
      const root = requireOpenProject(p.path);
      const real = realParentPath(resolve(root, String(p.file)));
      if (!isInsideRoot(real, root)) {
        throw Object.assign(new Error("File is outside the project folder."), {
          kind: "filesystem-permission",
        });
      }
      return gitDiff(root, String(p.file));
    }

    case "project.files":
      return listProjectFiles(
        requireOpenProject(p.path),
        p.query ? String(p.query) : undefined,
        p.limit,
      );

    case "project.readFile":
      return readProjectFile(requireOpenProject(p.path), String(p.file));

    case "project.ship":
      return shipChanges(requireOpenProject(p.path), {
        title: String(p.title),
        body: p.body ? String(p.body) : undefined,
      });

    case "attachments.store": {
      const b64 = String(p.base64 ?? "");
      // ~32MB of base64 ≈ 24MB of bytes — above every provider's image cap.
      if (b64.length > 32 * 1024 * 1024) {
        throw Object.assign(new Error("Attachment is too large (24MB max)."), {
          kind: "configuration",
        });
      }
      const safe = String(p.name ?? "attachment")
        .replace(/[^\w.-]+/g, "_")
        .slice(-80);
      const dir = join(tmpdir(), "orchestrator-attachments");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${Date.now().toString(36)}-${safe}`);
      writeFileSync(path, Buffer.from(b64, "base64"));
      return { path };
    }

    case "file.read": {
      // Preview of a clicked file link — confined to the open projects'
      // real (symlink-resolved) roots. "Click-gated" is a UI property, not a
      // protocol one; the engine enforces the boundary itself.
      let target = String(p.path);
      if (target.startsWith("~")) target = target.replace(/^~(?=$|\/)/, homedir());
      const roots = liveProjectRoots(m);
      if (!existsSync(target)) {
        // Missing files report as missing ONLY when they'd be in bounds —
        // the UI's locate-by-name fallback depends on that signal. The parent
        // is realpath'd so /var vs /private/var style aliases still match.
        const probe = realParentPath(resolve(target));
        const inBounds = roots.some((r) => isInsideRoot(probe, r));
        return inBounds ? { kind: "missing" } : { kind: "denied" };
      }
      try {
        target = realpathSync(target);
      } catch {
        return { kind: "missing" };
      }
      if (!roots.some((r) => isInsideRoot(target, r))) return { kind: "denied" };
      const stat = statSync(target);
      if (stat.isDirectory()) return { kind: "directory" };
      const ext = target.split(".").pop()?.toLowerCase() ?? "";
      const IMAGE_MIME: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        ico: "image/x-icon",
      };
      if (IMAGE_MIME[ext]) {
        // The webview renders these from a data: URI; cap what we inline.
        if (stat.size > 20 * 1024 * 1024) return { kind: "binary" };
        const bytes = await Bun.file(target).arrayBuffer();
        return {
          kind: "image",
          mime: IMAGE_MIME[ext],
          base64: Buffer.from(bytes).toString("base64"),
        };
      }
      if (ext === "pdf") {
        // Rendered by WKWebView in an <embed> fed from a blob URL.
        if (stat.size > 20 * 1024 * 1024) return { kind: "binary" };
        const bytes = await Bun.file(target).arrayBuffer();
        return {
          kind: "pdf",
          mime: "application/pdf",
          base64: Buffer.from(bytes).toString("base64"),
        };
      }
      if (stat.size > 4 * 1024 * 1024) return { kind: "binary" };
      const text = await Bun.file(target).text();
      if (text.includes("\0")) return { kind: "binary" };
      const LIMIT = 512 * 1024;
      const truncated = text.length > LIMIT;
      return { kind: "text", content: truncated ? text.slice(0, LIMIT) : text, truncated };
    }

    case "path.open": {
      // Only user clicks reach here; the engine still refuses paths that don't
      // exist so a hallucinated path can't launch apps with garbage input.
      const target = String(p.path);
      if (!existsSync(target)) {
        throw Object.assign(new Error(`No such file: ${target}`), { kind: "configuration" });
      }
      const args = p.reveal
        ? ["open", "-R", target]
        : p.app
          ? ["open", "-a", String(p.app), target]
          : ["open", target];
      Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
      return { opened: true };
    }

    // --- sessions ----------------------------------------------------------
    case "sessions.discover":
      return { sessions: await m.discoverSessions(p?.projectPath) };

    case "sessions.relocate": {
      // Re-home sessions whose project folder moved. The destination must be a
      // real directory; the source must actually be gone — when the recorded
      // folder still exists the sessions are resumable and "relocation" would
      // be a rename feature this request deliberately does not implement.
      const fromCwd = String(p.fromCwd);
      const toCwd = String(p.toCwd);
      if (!existsSync(toCwd) || !statSync(toCwd).isDirectory()) {
        throw Object.assign(new Error(`Folder not found: ${toCwd}`), {
          kind: "filesystem-permission",
        });
      }
      if (existsSync(fromCwd)) {
        throw Object.assign(
          new Error("The original folder still exists; sessions can be opened from it directly."),
          { kind: "configuration" },
        );
      }
      return m.relocateSessions(fromCwd, toCwd);
    }

    case "sessions.create":
      return { session: await m.create(p) };

    case "sessions.close":
      await m.close(String(p.sessionId));
      return { closed: true };

    case "sessions.list":
      return { sessions: m.list() };

    // --- one session -------------------------------------------------------
    case "session.prompt":
      // Auth gate: a dead OAuth grant must fail HERE, loudly — OMP's stale
      // token fallback otherwise keeps working and bills API credits.
      await m.assertSessionProvidersUsable(String(p.sessionId));
      return m.route(String(p.sessionId), "session.prompt", p) as never;

    case "session.abort":
      return m.route(String(p.sessionId), "session.abort", p) as never;

    case "session.compact":
      return m.route(String(p.sessionId), "session.compact", p) as never;

    case "session.rewindPoints":
      return m.route(String(p.sessionId), "session.rewindPoints", p) as never;

    case "session.rewind":
      return m.route(String(p.sessionId), "session.rewind", p) as never;

    case "session.fork": {
      // Fork a live session (by id) or a persisted file (by path).
      let sourcePath = p.sourcePath ? String(p.sourcePath) : undefined;
      let projectPath = p.projectPath ? String(p.projectPath) : undefined;
      if (!sourcePath && p.sessionId) {
        const live = m.list().find((s) => s.sessionId === String(p.sessionId));
        if (!live?.ompSessionPath) {
          throw Object.assign(
            new Error("This session has not been persisted yet, so it cannot be forked."),
            { kind: "configuration" },
          );
        }
        sourcePath = live.ompSessionPath;
        projectPath = projectPath ?? live.projectPath;
      }
      if (!sourcePath || !projectPath) {
        throw Object.assign(new Error("Fork needs a source session and a project folder."), {
          kind: "configuration",
        });
      }
      const session = await m.fork({
        sourcePath,
        projectPath,
        title: p.title ? String(p.title) : undefined,
        model: p.model ? String(p.model) : undefined,
        thinkingLevel: p.thinkingLevel ? String(p.thinkingLevel) : undefined,
      });
      return { session };
    }

    case "session.setModel":
      await m.assertProvidersUsable([String(p.model)], "Switching to this model");
      return m.route(String(p.sessionId), "session.setModel", p) as never;

    case "session.setFastMode":
      return m.route(String(p.sessionId), "session.setFastMode", p) as never;

    case "session.setTitle":
      return m.route(String(p.sessionId), "session.setTitle", p) as never;

    case "session.setApprovalMode":
      return m.route(String(p.sessionId), "session.setApprovalMode", p) as never;

    case "session.transcript":
      return m.route(String(p.sessionId), "session.transcript", p) as never;

    case "session.advisors.set": {
      const advisors = Array.isArray(p.advisors) ? p.advisors : [];
      await m.assertProvidersUsable(
        advisors.filter((a: any) => a?.enabled).map((a: any) => a?.model),
        "Enabling these advisors",
      );
      return m.route(String(p.sessionId), "session.advisors.set", p) as never;
    }

    case "session.advisors.get":
      return m.route(String(p.sessionId), "session.advisors.get", p) as never;

    // --- interaction bridges ----------------------------------------------
    case "approval.respond":
      return m.route(String(p.sessionId), "approval.respond", p) as never;

    case "extension.ui.respond":
      return m.route(String(p.sessionId), "extension.ui.respond", p) as never;

    case "slash.list":
      return m.route(String(p.sessionId), "slash.list", p) as never;

    case "mcp.status":
      return m.route(String(p.sessionId), "mcp.status", p) as never;

    case "mcp.reconnect":
      return m.route(String(p.sessionId), "mcp.reconnect", p) as never;

    // --- usage -------------------------------------------------------------
    case "usage.session":
      return { breakdown: await m.sessionUsage(String(p.sessionId)) };

    case "usage.query": {
      const pid = p?.projectPath ? projectIdFor(String(p.projectPath)) : undefined;
      const since = p?.since ? String(p.since) : undefined;
      const until = p?.until ? String(p.until) : undefined;
      const matches = (r: UsageRecord): boolean =>
        (pid === undefined || r.projectId === pid) &&
        (!p?.provider || r.provider === p.provider) &&
        (!p?.model || r.model === p.model) &&
        (!p?.actorType || r.actorType === p.actorType) &&
        (since === undefined || (r.completedAt ?? "") >= since) &&
        (until === undefined || (r.completedAt ?? "") <= until);
      const index = m.usageIndex();
      return { records: index.records().filter(matches), breakdown: index.breakdown(matches) };
    }

    case "usage.reindex":
      return m.reindexUsage();

    // --- UI preference storage --------------------------------------------
    // Prefs hold presets, aliases and session ordering — real data, so they
    // live in a file under Application Support instead of only WKWebView
    // localStorage, which the OS can wipe without warning.
    case "prefs.load": {
      const path = join(appSupportDir(), "prefs.json");
      if (!existsSync(path)) return {};
      try {
        return { prefs: JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        return {}; // corrupt file: the UI falls back to its defaults
      }
    }

    case "prefs.save": {
      const dir = appSupportDir();
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "prefs.json");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(p.prefs ?? {}, null, 2));
      renameSync(tmp, path);
      return { ok: true };
    }

    default: {
      const never: never = req.type as never;
      throw new Error(`Unhandled request type: ${String(never)}`);
    }
  }
}
