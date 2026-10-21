import type { Change, Counts, LoadError } from './core';

export type SideName = 'old' | 'new';

export interface SideInfo {
  label: string;
  /** Second line: "api/petstore.yaml at main", "working copy". */
  detail?: string;
  /** The main file's path as the engine saw it, to tell referenced files apart. */
  path: string;
  version?: string;
  error?: LoadError;
}

export interface Report {
  old: SideInfo;
  new: SideInfo;
  changes: Change[];
  counts: Counts;
  warnings: string[];
  /** What the comparison left out on purpose. */
  notes: string[];
  ms: number;
  /** "warnings as errors" is on. */
  strict: boolean;
}

export type ToWebview =
  | { type: 'loading' }
  | { type: 'report'; report: Report }
  /** What the serializer needs to reopen the report; the view stores it with its own state. */
  | { type: 'persist'; state: unknown }
  | { type: 'view'; view: ViewState };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'open'; side: SideName; file: string; line: number; col: number }
  | { type: 'copyMarkdown' }
  | { type: 'releaseNotes' }
  | { type: 'ignore'; index: number }
  | { type: 'swap' }
  | { type: 'refresh' };

/** What the view remembers across reloads: filters and folded groups. */
export interface ViewState {
  levels?: Record<string, boolean>;
  query?: string;
  collapsed?: string[];
}
