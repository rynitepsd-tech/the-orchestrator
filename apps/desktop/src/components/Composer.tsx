/**
 * Prompt composer.
 *
 * Enter sends (steering a busy session), ⌘Enter queues as a follow-up,
 * Shift+Enter inserts a newline. Typing "/" surfaces the session's real slash
 * commands, discovered live from the worker (builtins, skills, extensions,
 * MCP prompts) — never a hardcoded list.
 */

import type { AdvisorConfig, ApprovalMode, RunState } from "@orchestrator/protocol";
import { ask, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ClipboardEvent, DragEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { engine } from "../engine-client";
import { type Attachment, attachmentKind, storeBlob } from "../lib/attachments";
import type { SessionPreset } from "../lib/prefs";
import { isActive, modelBasename, useStore } from "../store";
import { EffortPicker } from "./EffortPicker";
import { BoltIcon } from "./icons";
import { ModelPicker } from "./ModelPicker";
import { PromptDialog } from "./PromptDialog";

export type { Attachment } from "../lib/attachments";

interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}

export function Composer({
  sessionId,
  runState,
  onSend,
  onAbort,
  disabled,
}: {
  sessionId?: string;
  runState: RunState;
  onSend: (text: string, whenBusy: "steer" | "queue", attachments: Attachment[]) => void;
  onAbort: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [slash, setSlash] = useState<SlashCommand[] | null>(null);
  const [slashSel, setSlashSel] = useState(0);
  const sentAt = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const commandsCache = useRef<SlashCommand[] | null>(null);
  /** ↑-history recall state; null while typing normally. */
  const historyRef = useRef<{ items: string[]; idx: number } | null>(null);

  const busy = isActive(runState);

  const fastMode = useStore((s) =>
    sessionId ? Boolean(s.sessions[sessionId]?.summary.fastMode) : false,
  );

  // Pre-flight contract, T3-style: the PRESET this session runs with sits on
  // the composer. Picking one applies its model/effort/fast mode live.
  const prefs = useStore((s) => s.prefs);
  const summary = useStore((s) => (sessionId ? s.sessions[sessionId]?.summary : undefined));
  const presetName = useStore((s) => (sessionId ? s.sessions[sessionId]?.presetName : undefined));
  const [presetDraft, setPresetDraft] = useState(false);

  const applyPreset = (p: SessionPreset) => {
    if (!sessionId) return;
    useStore.getState().setSessionPreset(sessionId, p.name);
    if (p.model) {
      void engine
        .request("session.setModel", {
          sessionId,
          model: p.model,
          thinkingLevel: p.thinkingLevel,
        })
        .catch((e) => useStore.getState().setEngineError(e));
    }
    if (Boolean(p.fastMode) !== fastMode) {
      void engine
        .request("session.setFastMode", { sessionId, enabled: Boolean(p.fastMode) })
        .catch(() => {});
    }
    // The preset is the whole launch contract, so its advisor roster applies
    // too — reviewers start/stop to match (an advisor-less preset stops them).
    // The store updates only after the worker confirms, from its echo.
    void engine
      .request("session.advisors.set", { sessionId, advisors: p.advisors.map((a) => ({ ...a })) })
      .then((r) => useStore.getState().setSessionAdvisors(sessionId, r.advisors))
      .catch((e) => useStore.getState().setEngineError(e));
  };

  const onPresetChange = (value: string) => {
    if (value === "__new") {
      setPresetDraft(true);
      return;
    }
    const p = prefs.presets.find((x) => x.name === value);
    if (p) applyPreset(p);
  };

  // "New preset…" captures the session's CURRENT contract under a name.
  const saveNewPreset = (name: string) => {
    if (!sessionId) return;
    const advisors = useStore.getState().sessions[sessionId]?.advisors ?? [];
    useStore.getState().addPreset({
      name,
      model: summary?.model,
      thinkingLevel: summary?.thinkingLevel,
      fastMode: fastMode || undefined,
      advisors,
    });
    useStore.getState().setSessionPreset(sessionId, name);
    setPresetDraft(false);
  };

  // Live model/effort switch (⌘⇧M): "this turn needs a bigger model" must
  // not require creating a preset. Same session.setModel presets use.
  const models = useStore((s) => s.models);
  const [modelPop, setModelPop] = useState(false);
  const [advisorPop, setAdvisorPop] = useState(false);
  const modelInfo = summary?.model ? models.find((m) => m.key === summary.model) : undefined;
  const efforts = modelInfo?.thinking?.efforts ?? [];

  const setLiveModel = (model: string, thinkingLevel?: string) => {
    if (!sessionId) return;
    void engine
      .request("session.setModel", { sessionId, model, thinkingLevel })
      .then((r) => {
        if (!r.ok) {
          useStore.getState().setEngineError({
            kind: "model-unavailable",
            message: `The model ${model} is not available.`,
          } as never);
        }
      })
      .catch((e) => useStore.getState().setEngineError(e));
  };

  useEffect(() => {
    const openModel = () => setModelPop(true);
    const openAdvisors = () => setAdvisorPop(true);
    window.addEventListener("orchestrator:change-model", openModel);
    window.addEventListener("orchestrator:configure-advisors", openAdvisors);
    return () => {
      window.removeEventListener("orchestrator:change-model", openModel);
      window.removeEventListener("orchestrator:configure-advisors", openAdvisors);
    };
  }, []);

  // Advisor roster for the popover: the session's current roster, toggled
  // live through the same session.advisors.set the presets use.
  const advisors = useStore((s) => (sessionId ? s.sessions[sessionId]?.advisors : undefined)) ?? [];
  const toggleAdvisor = (a: AdvisorConfig) => {
    if (!sessionId) return;
    const next = advisors.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x));
    void engine
      .request("session.advisors.set", { sessionId, advisors: next.map((x) => ({ ...x })) })
      .then((r) => useStore.getState().setSessionAdvisors(sessionId, r.advisors))
      .catch((e) => useStore.getState().setEngineError(e));
  };

  // Permission mode: how much the agent may do without asking. Server-side
  // enforcement (worker + OMP tier gate); this is just the switch.
  const approvalMode =
    useStore((s) => (sessionId ? s.sessions[sessionId]?.approvalMode : undefined)) ?? "always-ask";

  const setApproval = async (mode: ApprovalMode) => {
    if (!sessionId || mode === approvalMode) return;
    if (mode === "yolo") {
      const yes = await ask(
        "Full access lets the agent run commands and edit files without asking first. Enable for this session?",
        { title: "Full access", kind: "warning" },
      );
      if (!yes) return;
    }
    try {
      const r = await engine.request("session.setApprovalMode", { sessionId, mode });
      if (r.ok) useStore.getState().setSessionApproval(sessionId, mode);
    } catch (e) {
      useStore.getState().setEngineError(e as never);
    }
  };

  const toggleFast = () => {
    if (!sessionId) return;
    void engine
      .request("session.setFastMode", { sessionId, enabled: !fastMode })
      .then((r) => {
        if (!r.ok) {
          useStore.getState().setEngineError({
            kind: "engine",
            message: "The current model has no fast/priority tier to toggle.",
          } as never);
        }
      })
      .catch(() => {});
  };

  const fastToggle = (
    <button
      className={`ctl-chip fast-toggle${fastMode ? " on" : ""}`}
      title={
        fastMode
          ? "Fast mode is ON — responses are faster, but this uses your provider usage significantly faster. Click to turn off."
          : "Turn on fast mode (OpenAI/Anthropic priority tier). Faster responses — but it uses your provider usage significantly faster."
      }
      aria-pressed={fastMode}
      onClick={toggleFast}
      disabled={disabled}
    >
      <BoltIcon />
      {fastMode ? "Fast" : ""}
    </button>
  );

  // Live mirrors for the draft-parking cleanup below — an effect cleanup
  // closes over the state from when it ran, not the state at switch time.
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(() => {
    commandsCache.current = null;
    setSlash(null);
    historyRef.current = null;
    // Save-previous / restore-next, not clear-on-switch: switching sessions
    // is the app's most frequent action and routinely happens mid-thought
    // (visibleSessionId !== runningSessionIds is the documented core loop).
    // The old clear also kept the isolation guarantee the hard way — a draft
    // typed for one repo never SENDS to another, because it is parked under
    // its own session id and restored only there. In-memory only: drafts
    // survive switches, not relaunches.
    const draft = sessionId ? useStore.getState().drafts[sessionId] : undefined;
    setText(draft?.text ?? "");
    setAttachments(draft?.attachments ?? []);
    // Switching sessions should land you ready to type, like every chat app.
    taRef.current?.focus();
    return () => {
      if (sessionId) {
        useStore.getState().setDraft(sessionId, {
          text: textRef.current,
          attachments: attachmentsRef.current,
        });
      }
    };
  }, [sessionId]);

  // A rewound message comes back here for editing.
  const prefill = useStore((s) => s.composerPrefill);
  useEffect(() => {
    if (prefill && prefill.sessionId === sessionId) {
      setText(prefill.text);
      useStore.getState().setComposerPrefill(undefined);
      taRef.current?.focus();
    }
  }, [prefill, sessionId]);

  const pickFiles = async () => {
    const picked = await openFileDialog({ multiple: true, title: "Attach files" }).catch(
      () => null,
    );
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setAttachments((prev) => [
      ...prev,
      ...paths.map((p) => {
        const name = p.split("/").pop() ?? p;
        return { kind: attachmentKind(name), name, path: p };
      }),
    ]);
  };

  const addBlobs = async (files: File[]) => {
    for (const f of files) {
      try {
        const att = await storeBlob(f);
        setAttachments((prev) => [...prev, att]);
      } catch (e) {
        useStore.getState().setEngineError(e as never);
      }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.size > 0);
    if (files.length) {
      e.preventDefault();
      void addBlobs(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.size > 0);
    if (files.length) {
      e.preventDefault();
      void addBlobs(files);
    }
  };

  const refreshSlash = async (prefix: string) => {
    if (!sessionId) return;
    if (!commandsCache.current) {
      try {
        const res = await engine.request("slash.list", { sessionId });
        commandsCache.current = res.commands;
      } catch {
        commandsCache.current = [];
      }
    }
    const q = prefix.slice(1).toLowerCase();
    const matches = commandsCache.current
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 12);
    setSlash(matches.length ? matches : null);
    setSlashSel(0);
  };

  const onChange = (value: string) => {
    setText(value);
    const firstLine = value.split("\n", 1)[0];
    if (firstLine.startsWith("/") && !firstLine.includes(" ") && value === firstLine) {
      void refreshSlash(firstLine);
    } else if (slash) {
      setSlash(null);
    }
  };

  const acceptSlash = (cmd: SlashCommand) => {
    setText(`/${cmd.name} `);
    setSlash(null);
    taRef.current?.focus();
  };

  const send = (whenBusy: "steer" | "queue") => {
    const t = text.trim();
    // Attachments alone are a valid message (a screenshot IS the prompt).
    if ((!t && attachments.length === 0) || disabled || !sessionId) return;
    // Guard against double-submit from key-repeat or click+Enter races.
    if (Date.now() - sentAt.current < 300) return;
    sentAt.current = Date.now();
    onSend(t, whenBusy, attachments);
    setText("");
    setAttachments([]);
    setSlash(null);
    // The draft was delivered; a stale parked copy must not resurface later.
    useStore.getState().clearDraft(sessionId);
  };

  const canSend = Boolean(text.trim() || attachments.length);

  return (
    <div
      className={`composer${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {modelPop && (
        <div
          className="composer-pop"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setModelPop(false);
            }
          }}
        >
          <div className="pop-head">
            <span>Model for this session</span>
            <button className="btn btn-ghost" onClick={() => setModelPop(false)} aria-label="Close">
              ✕
            </button>
          </div>
          <ModelPicker
            models={models}
            value={summary?.model}
            startExpanded
            autoFocus
            onChange={(key) => {
              if (key) setLiveModel(key);
              setModelPop(false);
            }}
          />
          {efforts.length > 0 && (
            <div className="pop-row">
              <span className="hint">Effort</span>
              <EffortPicker
                efforts={efforts}
                value={summary?.thinkingLevel ?? ""}
                onChange={(lvl) => {
                  if (summary?.model) setLiveModel(summary.model, lvl || undefined);
                }}
              />
            </div>
          )}
        </div>
      )}
      {advisorPop && (
        <div
          className="composer-pop"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setAdvisorPop(false);
            }
          }}
        >
          <div className="pop-head">
            <span>Advisors for this session</span>
            <button
              className="btn btn-ghost"
              onClick={() => setAdvisorPop(false)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {advisors.length === 0 ? (
            <div className="empty">No advisors configured — pick a preset that includes some.</div>
          ) : (
            advisors.map((a) => (
              <label key={a.id} className="row check-row pop-row">
                <input type="checkbox" checked={a.enabled} onChange={() => toggleAdvisor(a)} />
                <span>{a.name}</span>
                {a.model && <span className="hint">· {modelBasename(a.model)}</span>}
              </label>
            ))
          )}
        </div>
      )}
      {slash && (
        <div className="slash-pop" role="listbox">
          {slash.map((c, i) => (
            <button
              key={c.name}
              className={`slash-item${i === slashSel ? " selected" : ""}`}
              onMouseEnter={() => setSlashSel(i)}
              onClick={() => acceptSlash(c)}
              role="option"
              aria-selected={i === slashSel}
            >
              <span className="mono">/{c.name}</span>
              {c.description && <span className="hint">{c.description}</span>}
              {c.source !== "builtin" && <span className="chip">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="composer-card">
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((a, i) => (
              <span key={`${a.path}-${i}`} className="chip attachment-chip" title={a.path}>
                {a.kind === "image" ? "🖼" : "📄"} {a.name}
                <button
                  className="attachment-remove"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="composer-input"
          onPaste={onPaste}
          placeholder={
            busy
              ? "Steer the agent (⌘Enter queues as follow-up)…"
              : "Ask anything — / for commands, paste or drop files…"
          }
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Mid-IME Enter confirms the composition, never sends — without
            // this a half-composed word fires as a prompt.
            if (e.nativeEvent.isComposing) return;
            if (slash) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashSel((n) => Math.min(slash.length - 1, n + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashSel((n) => Math.max(0, n - 1));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                acceptSlash(slash[slashSel]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlash(null);
                return;
              }
            }
            // ↑ on an empty composer recalls sent prompts, newest first; ↓
            // walks forward and clears past the newest. Any edit resets.
            if (e.key === "ArrowUp" && !text && sessionId) {
              const sent = (useStore.getState().sessions[sessionId]?.transcript ?? [])
                .filter((i) => i.kind === "user")
                .map((i) => (i as { text: string }).text);
              if (sent.length) {
                e.preventDefault();
                historyRef.current = { items: sent, idx: sent.length - 1 };
                setText(sent[sent.length - 1]);
              }
              return;
            }
            if (historyRef.current && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
              const h = historyRef.current;
              if (text === h.items[h.idx]) {
                e.preventDefault();
                if (e.key === "ArrowUp") {
                  if (h.idx > 0) {
                    h.idx -= 1;
                    setText(h.items[h.idx]);
                  }
                } else if (h.idx < h.items.length - 1) {
                  h.idx += 1;
                  setText(h.items[h.idx]);
                } else {
                  historyRef.current = null;
                  setText("");
                }
                return;
              }
              historyRef.current = null; // edited — stop hijacking arrows
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.metaKey || e.ctrlKey ? "queue" : "steer");
            }
            // The Stop button advertises Esc; honour it.
            if (e.key === "Escape" && busy) {
              e.preventDefault();
              onAbort();
            }
          }}
        />
        <div className="composer-controls">
          <button
            className="ctl-chip attach-chip"
            title="Attach images or files (or paste/drop them)"
            onClick={() => void pickFiles()}
            disabled={disabled || !sessionId}
          >
            +
          </button>
          <select
            className="ctl-chip ctl-select"
            value={presetName ?? ""}
            title="Preset for this session — picking one applies its model, effort, fast mode, and advisors."
            disabled={disabled || !sessionId}
            onChange={(e) => onPresetChange(e.target.value)}
          >
            {!presetName && (
              <option value="" disabled>
                Custom
              </option>
            )}
            {prefs.presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {modelBasename(p.model)}
                {p.name === prefs.defaultPreset ? " (default)" : ""}
              </option>
            ))}
            <option value="__new">＋ New preset…</option>
          </select>
          <button
            className="ctl-chip"
            title="Change model or effort for this session (⌘⇧M)"
            disabled={disabled || !sessionId}
            onClick={() => setModelPop((v) => !v)}
          >
            {modelBasename(summary?.model)}
            {summary?.thinkingLevel ? ` · ${summary.thinkingLevel}` : ""}
          </button>
          {fastToggle}
          <select
            className="ctl-chip ctl-select"
            value={approvalMode}
            title={
              approvalMode === "yolo"
                ? "Full access — tools run without prompts inside the project; anything outside it still asks. Server-enforced per session."
                : approvalMode === "write"
                  ? "Auto-accept edits — content edits run without prompts; commands, deletes and renames still ask."
                  : "Manual — every gated tool asks before running."
            }
            disabled={disabled || !sessionId}
            onChange={(e) => void setApproval(e.target.value as ApprovalMode)}
          >
            <option value="always-ask">Manual</option>
            <option value="write">Auto edits</option>
            <option value="yolo">Full access</option>
          </select>
          <span className="spacer" />
          {busy && canSend && (
            <>
              <button
                className="btn btn-ghost"
                onClick={() => send("steer")}
                title="Steer the current run (Enter)"
              >
                Steer
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => send("queue")}
                title="Queue as a follow-up (⌘Enter)"
              >
                Queue
              </button>
            </>
          )}
          {busy ? (
            <button className="send-circle stop" onClick={onAbort} title="Stop (Esc)">
              ◼
            </button>
          ) : (
            <button
              className="send-circle"
              onClick={() => send("steer")}
              disabled={!canSend || disabled}
              title="Send (Enter)"
            >
              ↑
            </button>
          )}
        </div>
      </div>
      {presetDraft && (
        <PromptDialog
          title="Save current setup as a preset"
          placeholder="Preset name"
          submitLabel="Save preset"
          onCancel={() => setPresetDraft(false)}
          onSubmit={saveNewPreset}
        />
      )}
    </div>
  );
}
