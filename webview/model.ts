import type { Change } from '../src/core/diff';
import type { Level } from '../src/core/rules';

export const METHOD_ORDER = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE', 'QUERY'];
const methodRank = (m?: string) => {
  const i = METHOD_ORDER.indexOf(m ?? '');
  return i < 0 ? METHOD_ORDER.length : i;
};
const LEVEL_RANK: Record<Level, number> = { error: 0, warning: 1, info: 2 };

export interface Group {
  key: string;
  method?: string;
  path?: string;
  webhook?: boolean;
  /** Indexes into the report's change list. */
  items: number[];
}

export const groupKey = (c: Pick<Change, 'method' | 'path' | 'webhook'>) => (c.path ? `${c.webhook ? 'webhook ' : ''}${c.method} ${c.path}` : '');

/** Changes by endpoint: the whole API first, then paths in order, methods in the usual order. */
export function groupChanges(changes: Change[]): Group[] {
  const groups = new Map<string, Group>();
  changes.forEach((c, i) => {
    const k = groupKey(c);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: k, method: c.method, path: c.path, webhook: c.webhook, items: [] }));
    g.items.push(i);
  });
  const out = [...groups.values()];
  // Webhooks after the paths.
  out.sort((a, b) => {
    if (!a.path || !b.path) return a.path ? 1 : b.path ? -1 : 0;
    if (!!a.webhook !== !!b.webhook) return a.webhook ? 1 : -1;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return methodRank(a.method) - methodRank(b.method) || a.method!.localeCompare(b.method!);
  });
  // Within an endpoint, breaking first; otherwise keep the order they were found in.
  for (const g of out) g.items.sort((x, y) => LEVEL_RANK[changes[x].level] - LEVEL_RANK[changes[y].level] || x - y);
  return out;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Escapes a message and turns `code spans` into <code>, pairing fences of the same length
 * the way Markdown does (``a `b` c`` is one span).
 */
export function messageHtml(s: string): string {
  return esc(s).replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _f: string, body: string) => `<code>${/^ [\s\S]* $/.test(body) && body.trim() ? body.slice(1, -1) : body}</code>`);
}

/** Every word of the query appears in the change's endpoint, id or message. */
export function matchesQuery(c: Change, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${c.method ?? ''} ${c.path ?? 'whole api'} ${c.webhook ? 'webhook' : ''} ${c.movedFrom ? `${c.movedFrom.method} ${c.movedFrom.path}` : ''} ${c.id} ${c.message}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
