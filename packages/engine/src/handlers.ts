/**
 * Request handlers.
 *
 * One exhaustive switch over the protocol's request union, so adding a request
 * type without handling it is a type error rather than a runtime surprise.
 */
import {
  discoverSlashCommandsIn,
  gitChanges,
  gitDiff,
  inspectProject,
  projectIdFor,
} from "@orchestrator/omp-adapter";
import type {
  EngineRequest,
  RequestType,
  ResponsePayloads,
  UsageRecord,
} from "@orchestrator/protocol";
import type { EngineServer } from "./server";

export async function handleRequest(
  server: EngineServer,
  req: EngineRequest,
): Promise<ResponsePayloads[RequestType]> {
  const m = server.manager;
  const p = req.payload as any;

  switch (req.type as RequestType) {
    // --- engine ------------------------------------------------------------
    case "engine.hello":
      return server.info();

    case "engine.shutdown": {
      // Respond before tearing down so the host sees a clean acknowledgement.
      queueMicrotask(() => void server.shutdown());
      return { stopping: true };
    }

    case "engine.diagnostics": {
      const { engineLogPath } = await import("./logging");
      return {
        info: server.info(),
        sessions: m.list().length,
        activeSessions: m.activeCount(),
        logPath: engineLogPath(),
        warnings: [],
        workers: await m.workerStats(),
      };
    }

    // --- catalogue ---------------------------------------------------------
    case "models.list": {
      const models = await m.models(p?.refresh === true);
      return { models, defaultModel: undefined, roles: {} };
    }

    case "providers.list":
      return { providers: await m.providers() };

    case "providers.quota":
      return { quotas: await m.quotas() };

    case "providers.login":
      return m.login(String(p.provider), (e) => server.emitLifecycle(e));

    case "providers.logout":
      // Sign-out is deliberately not exposed: OMP owns credential lifecycle,
      // and revoking from a GUI that did not create the credential risks
      // breaking the user's CLI. Actionable message, not a silent no-op.
      throw Object.assign(
        new Error("Sign-out is managed by OMP. Run `omp logout` in a terminal."),
        { kind: "auth" },
      );

    // --- projects ----------------------------------------------------------
    case "project.open":
      return { project: await inspectProject(String(p.path)) };

    case "project.environment": {
      const path = String(p.path);
      const advisors = await m.projectAdvisors(path);
      const slashCommands = await discoverSlashCommandsIn(path);
      return {
        contextFiles: [],
        skills: 0,
        advisors,
        mcpServers: [],
        slashCommands,
        extensions: [],
        hasWatchdogConfig: advisors.length > 0,
      };
    }

    case "project.changes":
      return gitChanges(String(p.path));

    case "project.diff":
      return gitDiff(String(p.path), String(p.file));

    case "project.files": {
      const { listProjectFiles } = await import("@orchestrator/omp-adapter");
      return listProjectFiles(String(p.path), p.query ? String(p.query) : undefined, p.limit);
    }

    case "project.readFile": {
      const { readProjectFile } = await import("@orchestrator/omp-adapter");
      return readProjectFile(String(p.path), String(p.file));
    }

    case "attachments.store": {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
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

    case "path.open": {
      // Only user clicks reach here; the engine still refuses paths that don't
      // exist so a hallucinated path can't launch apps with garbage input.
      const { existsSync } = await import("node:fs");
      const target = String(p.path);
      if (!existsSync(target)) {
        throw Object.assign(new Error(`No such file: ${target}`), { kind: "configuration" });
      }
      const args = p.reveal ? ["open", "-R", target] : ["open", target];
      Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
      return { opened: true };
    }

    // --- sessions ----------------------------------------------------------
    case "sessions.discover":
      return { sessions: await m.discoverSessions(p?.projectPath) };

    case "sessions.create":
      return { session: await m.create(p) };

    case "sessions.close":
      await m.close(String(p.sessionId), p.dispose !== false);
      return { closed: true };

    case "sessions.list":
      return { sessions: m.list() };

    // --- one session -------------------------------------------------------
    case "session.prompt":
      return m.route(String(p.sessionId), "session.prompt", p) as never;

    case "session.abort":
      return m.route(String(p.sessionId), "session.abort", p) as never;

    case "session.compact":
      return m.route(String(p.sessionId), "session.compact", p) as never;

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
      return m.route(String(p.sessionId), "session.setModel", p) as never;

    case "session.setFastMode":
      return m.route(String(p.sessionId), "session.setFastMode", p) as never;

    case "session.setTitle":
      return m.route(String(p.sessionId), "session.setTitle", p) as never;

    case "session.setApprovalMode":
      return m.route(String(p.sessionId), "session.setApprovalMode", p) as never;

    case "session.transcript":
      return m.route(String(p.sessionId), "session.transcript", p) as never;

    case "session.advisors.set":
      return m.route(String(p.sessionId), "session.advisors.set", p) as never;

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
      const index = m.usageIndex();
      let records = index.records();
      if (p?.projectPath) {
        const pid = projectIdFor(String(p.projectPath));
        records = records.filter((r) => r.projectId === pid);
      }
      if (p?.provider) records = records.filter((r) => r.provider === p.provider);
      if (p?.model) records = records.filter((r) => r.model === p.model);
      if (p?.actorType) records = records.filter((r) => r.actorType === p.actorType);
      if (p?.since) {
        const since = String(p.since);
        records = records.filter((r) => (r.completedAt ?? "") >= since);
      }
      if (p?.until) {
        const until = String(p.until);
        records = records.filter((r) => (r.completedAt ?? "") <= until);
      }
      const { summarize } = await import("@orchestrator/usage");
      return { records: records as UsageRecord[], breakdown: summarize(records) };
    }

    case "usage.reindex":
      return m.reindexUsage();

    default: {
      const never: never = req.type as never;
      throw new Error(`Unhandled request type: ${String(never)}`);
    }
  }
}
