/**
 * Prompt composer.
 *
 * Enter sends (steering a busy session), ⌘Enter queues as a follow-up,
 * Shift+Enter inserts a newline. Typing "/" surfaces the session's real slash
 * commands, discovered live from the worker (builtins, skills, extensions,
 * MCP prompts) — never a hardcoded list.
 */

import type { RunState } from "@orchestrator/protocol";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ClipboardEvent, DragEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { engine } from "../engine-client";
import type { SessionPreset } from "../lib/prefs";
import { isActive, useStore } from "../store";
import { BoltIcon } from "./icons";
import { PromptDialog } from "./PromptDialog";

interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}

export interface Attachment {
  kind: "image" | "file";
  name: string;
  path: string;
}

const IMAGE_EXT_RX = /\.(png|jpe?g|gif|webp)$/i;

function attachmentKind(name: string): "image" | "file" {
  return IMAGE_EXT_RX.test(name) ? "image" : "file";
}

/** Persist a pasted/dropped blob through the engine; returns an attachment. */
async function storeBlob(file: File): Promise<Attachment> {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const name = file.name || (file.type.startsWith("image/") ? "pasted-image.png" : "attachment");
  const res = await engine.request("attachments.store", { name, base64: btoa(bin) });
  return {
    kind: file.type.startsWith("image/") ? "image" : attachmentKind(name),
    name,
    path: res.path,
  };
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

  useEffect(() => {
    commandsCache.current = null;
    setSlash(null);
    setAttachments([]);
    // Switching sessions should land you ready to type, like every chat app.
    taRef.current?.focus();
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
            title="Preset for this session — picking one applies its model, effort, and fast mode"
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
                {p.name}
                {p.name === prefs.defaultPreset ? " (default)" : ""}
              </option>
            ))}
            <option value="__new">＋ New preset…</option>
          </select>
          {fastToggle}
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
