import type { ProjectDecision, SessionSearchHit } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { engine } from "../engine-client";
import { basename } from "../lib/prefs";

type Draft = {
  id?: string;
  projectPath: string;
  title: string;
  text: string;
  source: ProjectDecision["source"];
};

export function ProjectHistory({
  projectPath,
  onOpenHit,
}: {
  projectPath: string;
  onOpenHit: (hit: SessionSearchHit) => void;
}): JSX.Element {
  const id = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"project" | "all">(projectPath ? "project" : "all");
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [retry, setRetry] = useState(0);
  const [decisionProject, setDecisionProject] = useState(projectPath);
  const [decisions, setDecisions] = useState<ProjectDecision[]>([]);
  const [loadingDecisions, setLoadingDecisions] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const draftOpen = draft !== null;

  useEffect(() => {
    if (!draftOpen) return;
    titleRef.current?.scrollIntoView({ block: "center" });
    titleRef.current?.focus({ preventScroll: true });
  }, [draftOpen]);

  useEffect(() => {
    setDecisionProject(projectPath);
    setScope(projectPath ? "project" : "all");
    setDraft(null);
    setDeleteId(null);
    setActionError("");
    setNotice("");
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    setHits([]);
    setSearchError("");
    setTruncated(false);
    if (!query.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void engine
        .request("sessions.search", {
          query: query.trim(),
          projectPath: scope === "project" && projectPath ? projectPath : undefined,
          limit: 50,
        })
        .then((result) => {
          if (cancelled) return;
          setHits(result.hits);
          setTruncated(result.truncated);
        })
        .catch((error: unknown) => {
          if (!cancelled) setSearchError(String((error as { message?: string })?.message ?? error));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scope, projectPath, retry]);

  useEffect(() => {
    let cancelled = false;
    setDecisions([]);
    setDecisionError("");
    if (!decisionProject) {
      setLoadingDecisions(false);
      return;
    }
    setLoadingDecisions(true);
    void engine
      .request("project.decisions.list", { path: decisionProject })
      .then((result) => {
        if (!cancelled) setDecisions(result.decisions);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDecisionError(String((error as { message?: string })?.message ?? error));
      })
      .finally(() => {
        if (!cancelled) setLoadingDecisions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [decisionProject, revision]);

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await engine.request("project.decisions.save", {
        path: draft.projectPath,
        decision: { id: draft.id, title: draft.title, text: draft.text, source: draft.source },
      });
      setDecisionProject(draft.projectPath);
      setDraft(null);
      setRevision((value) => value + 1);
      setNotice("Decision saved. It is not automatically added to model context.");
    } catch (error) {
      setActionError(String((error as { message?: string })?.message ?? error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (decision: ProjectDecision) => {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await engine.request("project.decisions.delete", {
        path: decision.projectPath,
        id: decision.id,
      });
      setDeleteId(null);
      if (draft?.id === decision.id) setDraft(null);
      setRevision((value) => value + 1);
      setNotice("Decision deleted. The source transcript is unchanged.");
    } catch (error) {
      setActionError(String((error as { message?: string })?.message ?? error));
    } finally {
      setBusy(false);
    }
  };

  const openSource = async (decision: ProjectDecision) => {
    setActionError("");
    try {
      const result = await engine.request("sessions.source", decision.source);
      await onOpenHit(result.hit);
    } catch (error) {
      setActionError(String((error as { message?: string })?.message ?? error));
    }
  };

  return (
    <div className="project-history" style={{ display: "grid", gap: 20, minWidth: 0 }}>
      <section aria-labelledby={`${id}-search-heading`}>
        <h3 id={`${id}-search-heading`} style={{ marginBottom: 12 }}>
          Transcript search
        </h3>
        <div className="field">
          <label htmlFor={`${id}-query`}>Find in saved conversations</label>
          <input
            id={`${id}-query`}
            className="input"
            type="search"
            maxLength={1000}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search message content…"
          />
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor={`${id}-scope`}>Search scope</label>
          <select
            id={`${id}-scope`}
            className="select"
            value={scope}
            onChange={(event) => setScope(event.target.value === "all" ? "all" : "project")}
          >
            {projectPath && <option value="project">This project · {basename(projectPath)}</option>}
            <option value="all">All projects</option>
          </select>
        </div>
        <div role="status" aria-live="polite" className="hint" style={{ marginTop: 10 }}>
          {searching
            ? "Searching saved transcripts…"
            : !query.trim()
              ? "Search includes older messages, not just session titles."
              : !searchError
                ? `${hits.length} ${hits.length === 1 ? "matching message" : "matching messages"}`
                : ""}
        </div>
        {searchError && (
          <div role="alert">
            <p>{searchError}</p>
            <button className="btn" onClick={() => setRetry((value) => value + 1)}>
              Retry search
            </button>
          </div>
        )}
        {!searching && !searchError && query.trim() && !hits.length && (
          <div className="empty">
            No messages match. Try different words or search all projects.
          </div>
        )}
        {hits.map((hit) => (
          <article
            key={`${hit.sessionPath}:${hit.entryId}`}
            style={{
              padding: "14px 0",
              borderBottom: "1px solid var(--border)",
              overflowWrap: "anywhere",
            }}
          >
            <strong>{hit.title || "Untitled session"}</strong>
            <div className="hint">
              {basename(hit.projectPath)} · {hit.role === "user" ? "You" : "Assistant"}
              {hit.at && !Number.isNaN(Date.parse(hit.at))
                ? ` · ${new Date(hit.at).toLocaleDateString()}`
                : ""}
            </div>
            <p style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{hit.snippet}</p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button
                className="btn"
                onClick={() => {
                  setActionError("");
                  void Promise.resolve()
                    .then(() => onOpenHit(hit))
                    .catch((error: unknown) =>
                      setActionError(String((error as { message?: string })?.message ?? error)),
                    );
                }}
              >
                Open source
              </button>
              <button
                className="btn"
                disabled={busy || Boolean(draft)}
                onClick={() => {
                  setDecisionProject(hit.projectPath);
                  setActionError("");
                  setNotice("");
                  setDraft({
                    projectPath: hit.projectPath,
                    title: "",
                    text: "",
                    source: { sessionPath: hit.sessionPath, entryId: hit.entryId },
                  });
                }}
              >
                Save a decision…
              </button>
              {draft && draft.projectPath === hit.projectPath && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      source: { sessionPath: hit.sessionPath, entryId: hit.entryId },
                    })
                  }
                >
                  Use as source
                </button>
              )}
            </div>
          </article>
        ))}
        {truncated && (
          <p className="hint">
            Results are incomplete: more matches exist or a saved transcript could not be fully
            read. Refine your search.
          </p>
        )}
      </section>
      <section aria-labelledby={`${id}-decisions-heading`}>
        <h3 id={`${id}-decisions-heading`}>
          Project decisions{decisionProject ? ` · ${basename(decisionProject)}` : ""}
        </h3>
        <p className="hint">
          Notes you explicitly save, each linked to a source message. Never automatically injected
          into model context.
        </p>
        {projectPath && decisionProject !== projectPath && (
          <button
            className="btn"
            disabled={busy || Boolean(draft)}
            onClick={() => setDecisionProject(projectPath)}
          >
            Back to this project's decisions
          </button>
        )}
        {actionError && (
          <p role="alert" style={{ overflowWrap: "anywhere" }}>
            {actionError}
          </p>
        )}
        {notice && (
          <p role="status" className="hint">
            {notice}
          </p>
        )}
        {draft && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            style={{ display: "grid", gap: 12, margin: "16px 0" }}
          >
            <strong>{draft.id ? "Edit decision" : "New sourced decision"}</strong>
            <div className="field">
              <label htmlFor={`${id}-title`}>Title</label>
              <input
                ref={titleRef}
                id={`${id}-title`}
                className="input"
                required
                maxLength={160}
                value={draft.title}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-text`}>Decision and rationale</label>
              <textarea
                id={`${id}-text`}
                className="textarea"
                required
                maxLength={16000}
                rows={5}
                value={draft.text}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              />
            </div>
            <div className="hint" style={{ overflowWrap: "anywhere" }}>
              Source message: {draft.source.entryId}. To change it, search above and choose “Use as
              source”.
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || !draft.title.trim() || !draft.text.trim()}
              >
                {busy ? "Saving…" : "Save decision"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setActionError("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {loadingDecisions && (
          <p role="status" className="hint">
            Loading decisions…
          </p>
        )}
        {decisionError && (
          <div role="alert">
            <p>{decisionError}</p>
            <button className="btn" onClick={() => setRevision((value) => value + 1)}>
              Retry loading decisions
            </button>
          </div>
        )}
        {!loadingDecisions && !decisionError && !decisions.length && !draft && (
          <div className="empty">
            {decisionProject
              ? "No saved decisions. Search above, then choose Save a decision on a source message."
              : "Search all projects and select a source message to create a project decision."}
          </div>
        )}
        {decisions.map((decision) => (
          <article
            key={decision.id}
            style={{
              padding: "14px 0",
              borderBottom: "1px solid var(--border)",
              overflowWrap: "anywhere",
            }}
          >
            <strong>{decision.title}</strong>
            <p style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{decision.text}</p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="btn" onClick={() => void openSource(decision)}>
                Open source
              </button>
              <button
                className="btn"
                disabled={busy || Boolean(draft)}
                onClick={() => {
                  setDraft({ ...decision });
                  setActionError("");
                  setNotice("");
                }}
              >
                Edit
              </button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => setDeleteId(decision.id)}
              >
                Delete…
              </button>
            </div>
            {deleteId === decision.id && (
              <div style={{ marginTop: 10 }}>
                <p>Delete this saved decision? Its source transcript will remain.</p>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => void remove(decision)}
                  >
                    {busy ? "Deleting…" : "Delete decision"}
                  </button>
                  <button className="btn" disabled={busy} onClick={() => setDeleteId(null)}>
                    Keep decision
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
