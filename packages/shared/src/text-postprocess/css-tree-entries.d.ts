declare module 'css-tree/parser' {
  export interface CssLocationPoint {
    offset: number;
    line: number;
    column: number;
  }

  export interface CssLocation {
    source?: string;
    start: CssLocationPoint;
    end: CssLocationPoint;
  }

  export interface CssNode {
    type: string;
    loc?: CssLocation | null;
    name?: string;
    value?: string | CssNode;
    unit?: string;
    property?: string;
    important?: boolean;
    children?: { forEach(callback: (node: CssNode) => void): void };
    prelude?: CssNode | null;
    block?: CssNode | null;
    nth?: { type?: string; a?: string | null; b?: string | null } | null;
    selector?: CssNode | null;
    condition?: CssNode | null;
    modifier?: string | null;
    mediaType?: string | null;
    kind?: string;
  }

  export interface CssParseError extends Error {
    offset?: number;
    line?: number;
    column?: number;
  }

  export default function parse(
    source: string,
    options?: {
      context?: string;
      positions?: boolean;
      onParseError?: (error: CssParseError) => void;
      onComment?: (value: string) => void;
    }
  ): CssNode;
}

declare module 'css-tree/walker' {
  import type { CssNode } from 'css-tree/parser';

  export default function walk(node: CssNode, callback: (node: CssNode) => void): void;
}

declare module 'css-tree/generator' {
  import type { CssNode } from 'css-tree/parser';

  export default function generate(node: CssNode): string;
}
