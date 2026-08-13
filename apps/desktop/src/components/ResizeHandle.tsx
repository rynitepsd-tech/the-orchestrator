/**
 * Drag handle for resizable side panels (sidebar, inspector).
 *
 * Pointer-capture based so the drag survives leaving the handle; width is
 * clamped and committed to prefs continuously (the prefs write is tiny).
 */

import type { JSX } from "react";
import { useRef, useState } from "react";

export function ResizeHandle({
  side,
  width,
  min,
  max,
  onResize,
}: {
  /** Which edge of its panel the handle sits on. */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width });

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window-splitter is a widget (WAI-ARIA separator), not an <hr>
    <div
      className={`resize-handle ${side}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (!dir) return;
        e.preventDefault();
        const next = width + dir * (side === "right" ? step : -step);
        onResize(Math.min(max, Math.max(min, next)));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const dx = e.clientX - start.current.x;
        // A right-edge handle grows its panel when dragged right; a left-edge
        // handle grows its panel when dragged left.
        const next = start.current.width + (side === "right" ? dx : -dx);
        onResize(Math.round(Math.min(max, Math.max(min, next))));
      }}
      onPointerUp={(e) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        setDragging(false);
      }}
    />
  );
}
