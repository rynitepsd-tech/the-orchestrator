/**
 * Minimal markdown renderer for assistant output.
 *
 * Builds React elements directly — there is no HTML string and no
 * dangerouslySetInnerHTML anywhere, so model output can never inject markup
 * into the webview. Covers the subset coding agents actually emit: headings,
 * fenced code, inline code, bold/italic, lists, blockquotes, links, tables.
 * Unrecognised syntax degrades to plain text, never to broken rendering.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX, ReactNode } from "react";
import { memo } from "react";
import { useStore } from "../store";

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * Does this inline-code span look like a file reference worth linking?
 * Slash-containing paths always qualify; bare names need a real extension so
 * `console.log` and `useStore.getState` stay plain code.
 */
const PATHY_RX =
  /^(~?[\w.@-]*(?:\/[\w.@-]+)+|[\w@-][\w.@-]*\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|md|rs|py|go|java|kt|rb|sh|zsh|bash|yml|yaml|toml|html|xml|svg|txt|lock|sql|swift|c|h|cpp|hpp|cs|php|vue|svelte|conf|ini|plist|png|jpe?g|gif|webp|pdf))(:\d+(?::\d+)?)?$/;

/** Open a file reference in the inspector preview pane. */
function openFileRef(ref: string, projectPath?: string): void {
  const lineMatch = /:(\d+)(?::\d+)?$/.exec(ref);
  const bare = ref.replace(/:\d+(?::\d+)?$/, "");
  const abs =
    bare.startsWith("/") || bare.startsWith("~")
      ? bare
      : projectPath
        ? `${projectPath}/${bare}`
        : undefined;
  if (!abs) return; // relative path with no project to resolve against
  useStore.getState().openFilePreview({
    path: abs,
    projectPath,
    line: lineMatch ? Number(lineMatch[1]) : undefined,
  });
}

/** A clickable inline-code file reference. */
function FileRef({ text, projectPath }: { text: string; projectPath?: string }): JSX.Element {
  return (
    <button
      type="button"
      className="file-ref file-ref-code"
      title="Click to preview"
      onClick={() => openFileRef(text, projectPath)}
    >
      {text}
    </button>
  );
}

const URL_RX = /https?:\/\/[^\s<>()]+/g;

/** Plain text, with bare URLs promoted to clickable links. */
function pushPlain(nodes: ReactNode[], text: string, keyBase: string, k: () => number): void {
  URL_RX.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RX.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    // Trailing punctuation belongs to the prose, not the URL.
    const href = m[0].replace(/[.,;:!?'")\]]+$/, "");
    nodes.push(
      <a
        key={`${keyBase}-u${k()}`}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          void openUrl(href);
        }}
      >
        {href}
      </a>,
    );
    last = m.index + href.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
}

/** Inline spans: `code`, **bold**, *italic*, [text](url), bare URLs, file refs. */
function renderInline(text: string, keyBase: string, projectPath?: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Tokenize by inline code first so markup inside code stays literal.
  const parts = text.split(/(`[^`\n]+`)/g);
  let kn = 0;
  const k = () => kn++;
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const code = part.slice(1, -1);
      nodes.push(
        PATHY_RX.test(code) ? (
          <FileRef key={`${keyBase}-c${k()}`} text={code} projectPath={projectPath} />
        ) : (
          <code key={`${keyBase}-c${k()}`}>{code}</code>
        ),
      );
      continue;
    }
    // bold / italic / links on the remaining text
    const rx = /(\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(part))) {
      if (m.index > last) pushPlain(nodes, part.slice(last, m.index), keyBase, k);
      const tok = m[0];
      if (tok.startsWith("**")) {
        nodes.push(<strong key={`${keyBase}-b${k()}`}>{tok.slice(2, -2)}</strong>);
      } else if (tok.startsWith("*")) {
        nodes.push(<em key={`${keyBase}-i${k()}`}>{tok.slice(1, -1)}</em>);
      } else {
        const lm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok);
        if (lm && isSafeHref(lm[2])) {
          const href = lm[2];
          nodes.push(
            <a
              key={`${keyBase}-a${k()}`}
              href={href}
              onClick={(e) => {
                // External links open in the system browser, never the webview.
                e.preventDefault();
                void openUrl(href);
              }}
            >
              {lm[1]}
            </a>,
          );
        } else if (lm && PATHY_RX.test(lm[2])) {
          // Markdown links to files, the way agents cite code: [foo.ts:42](src/foo.ts:42)
          const target = lm[2];
          nodes.push(
            <button
              type="button"
              key={`${keyBase}-a${k()}`}
              className="file-ref file-ref-link"
              onClick={() => openFileRef(target, projectPath)}
            >
              {lm[1]}
            </button>,
          );
        } else {
          nodes.push(tok);
        }
      }
      last = m.index + tok.length;
    }
    if (last < part.length) pushPlain(nodes, part.slice(last), keyBase, k);
  }
  return nodes;
}

interface Block {
  kind: "p" | "h" | "code" | "ul" | "ol" | "quote" | "table" | "hr";
  level?: number;
  lang?: string;
  lines: string[];
}

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({ kind: "code", lang, lines: body });
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1].length, lines: [h[2]] });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr", lines: [] });
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", lines: items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", lines: items });
      continue;
    }

    if (line.startsWith(">")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        items.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: items });
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const rows: string[] = [line];
      i += 2; // skip separator
      while (i < lines.length && lines[i].includes("|")) rows.push(lines[i++]);
      blocks.push({ kind: "table", lines: rows });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|>|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

function cells(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

export const Markdown = memo(function Markdown({
  text,
  projectPath,
}: {
  text: string;
  projectPath?: string;
}): JSX.Element {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "h": {
            const H = `h${Math.min(6, (b.level ?? 1) + 2)}` as unknown as "h3";
            return <H key={key}>{renderInline(b.lines[0] ?? "", key, projectPath)}</H>;
          }
          case "code":
            return (
              <pre key={key} className="md-code" data-lang={b.lang || undefined}>
                <code>{b.lines.join("\n")}</code>
              </pre>
            );
          case "ul":
            return (
              <ul key={key}>
                {b.lines.map((l, j) => (
                  <li key={j}>{renderInline(l, `${key}-${j}`, projectPath)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {b.lines.map((l, j) => (
                  <li key={j}>{renderInline(l, `${key}-${j}`, projectPath)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key}>
                {b.lines.map((l, j) => (
                  <p key={j}>{renderInline(l, `${key}-${j}`, projectPath)}</p>
                ))}
              </blockquote>
            );
          case "table": {
            const [head, ...rest] = b.lines;
            return (
              <div key={key} className="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {cells(head ?? "").map((c, j) => (
                        <th key={j}>{renderInline(c, `${key}-h${j}`, projectPath)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rest.map((r, j) => (
                      <tr key={j}>
                        {cells(r).map((c, jc) => (
                          <td key={jc}>{renderInline(c, `${key}-${j}-${jc}`, projectPath)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case "hr":
            return <hr key={key} />;
          default:
            return <p key={key}>{renderInline(b.lines.join(" "), key, projectPath)}</p>;
        }
      })}
    </div>
  );
});
