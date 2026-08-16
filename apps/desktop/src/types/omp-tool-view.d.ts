/**
 * <omp-tool-view> custom element (registered by vendor/tool-views.generated.js).
 * The payload goes in via the `data` PROPERTY — attributes are not observed,
 * so re-render means reassigning `.data`.
 */

import type { DetailedHTMLProps, HTMLAttributes } from "react";

export interface OmpToolViewData {
  name: string;
  args: Record<string, unknown>;
  result?: {
    content: unknown[];
    details?: Record<string, unknown>;
    isError?: boolean;
  };
  running?: boolean;
  partial?: string;
  defaultOpen?: boolean;
}

export interface OmpToolViewElement extends HTMLElement {
  data: OmpToolViewData | null;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "omp-tool-view": DetailedHTMLProps<HTMLAttributes<OmpToolViewElement>, OmpToolViewElement>;
    }
  }
}
