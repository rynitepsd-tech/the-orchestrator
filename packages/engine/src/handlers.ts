/**
 * Request handlers.
 *
 * One exhaustive switch over the protocol's request union, so adding a request
 * type without handling it is a type error rather than a runtime surprise.
 */
import {
  gitChanges,
  gitDiff,
  inspectProject,
  projectIdFor,
} from "@orchestrator/omp-adapter";
import type { EngineRequest, RequestType, ResponsePayloads } from "@orchestrator/protocol";
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
      // Provider onboarding is intentionally not implemented as a credential
      // pass-through: the engine must own secrets, and OMP owns the flows.
      throw Object.assign(
        new Error(
          "Provider sign-in from the GUI is not available in this build. Run `omp` once to connect a provider; The Orchestrator reuses those credentials.",
        ),
        { kind: "auth" },
      );

    case "providers.logout":
      throw Object.assign(new Error("Sign-out is managed by OMP."), { kind: "auth" });

    // --- projects ----------------------------------------------------------
    case "project.open":
      return { project: await inspectProject(String(p.path)) };

    case "project.environment": {
      const path = String(p.path);
      const advisors = await m.projectAdvisors(path);
      return {
        contextFiles: [],
        skills: 0,
        advisors,
        mcpServers: [],
        slashCommands: [],
        extensions: [],
        hasWatchdogConfig: advisors.length > 0,
      };
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
    case "session.prompt": {
      const rt = m.get(String(p.sessionId));
      const mode = await rt.prompt(String(p.text), p.whenBusy ?? "steer");
      return { accepted: true, mode };
    }

    case "session.abort":
      return { aborted: await m.get(String(p.sessionId)).abort() };

    case "session.compact":
      return { ok: await m.get(String(p.sessionId)).compact() };

    case "session.fork":
      throw Object.assign(new Error("Fork is not implemented in this build."), {
        kind: "configuration",
      });

    case "session.setModel": {
      const rt = m.get(String(p.sessionId));
      const ok = await rt.setModel(String(p.model), p.thinkingLevel);
      return { ok, model: String(p.model) };
    }

    case "session.setTitle": {
      m.get(String(p.sessionId)).setTitle(String(p.title));
      return { ok: true };
    }

    case "session.setApprovalMode":
      return { ok: false };

    case "session.transcript":
      return { events: [], sequence: 0 };

    case "session.advisors.set": {
      const rt = m.get(String(p.sessionId));
      return { advisors: await rt.applyAdvisors(p.advisors ?? []) };
    }

    case "session.advisors.get":
      return { advisors: m.get(String(p.sessionId)).advisors };

    // --- interaction bridges ----------------------------------------------
    case "approval.respond":
      return { ok: false };

    case "extension.ui.respond":
      return { ok: false };

    case "slash.list":
      return { commands: [] };

    // --- usage -------------------------------------------------------------
    case "usage.session":
      return { breakdown: m.get(String(p.sessionId)).usageBreakdown() };

    case "usage.query": {
      const acc = m.globalUsage();
      let records = acc.records();
      if (p?.projectPath) {
        const pid = projectIdFor(String(p.projectPath));
        records = records.filter((r) => r.projectId === pid);
      }
      if (p?.provider) records = records.filter((r) => r.provider === p.provider);
      if (p?.model) records = records.filter((r) => r.model === p.model);
      if (p?.actorType) records = records.filter((r) => r.actorType === p.actorType);
      const { summarize } = await import("@orchestrator/usage");
      return { records, breakdown: summarize(records) };
    }

    case "usage.reindex":
      return { indexed: 0, durationMs: 0 };

    default: {
      const never: never = req.type as never;
      throw new Error(`Unhandled request type: ${String(never)}`);
    }
  }
}

/** Exposed for the Changes panel; kept out of the switch to stay readable. */
export async function projectChanges(cwd: string) {
  return gitChanges(cwd);
}

export async function projectDiff(cwd: string, path: string) {
  return gitDiff(cwd, path);
}
