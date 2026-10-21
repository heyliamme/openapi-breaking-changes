import type { Change } from './diff';
import { LEVEL_ORDER, type Level } from './rules';

export interface IgnoreRule {
  id?: string;
  path?: string;
  method?: string;
  reason?: string;
}

export interface Policy {
  ignore: IgnoreRule[];
  warningsAsErrors: boolean;
}

/** Settings files can hold anything: keep the entries that make sense. */
export function readIgnore(raw: unknown): IgnoreRule[] {
  if (!Array.isArray(raw)) return [];
  const out: IgnoreRule[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && x.trim()) out.push({ id: x.trim() });
    else if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      const rule: IgnoreRule = {};
      for (const k of ['id', 'path', 'method', 'reason'] as const) if (typeof o[k] === 'string' && (o[k] as string).trim()) rule[k] = (o[k] as string).trim();
      if (rule.id || rule.path || rule.method) out.push(rule);
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `*` matches any run of characters. */
export function idMatcher(pattern: string): RegExp {
  return new RegExp('^' + pattern.split('*').map(escape).join('.*') + '$');
}

/** `*` matches one path segment, `**` any number of them (including none); `\*` is a `*`. */
export function pathMatcher(pattern: string): RegExp {
  const p = pattern.trim().replace(/(.)\/+$/, '$1');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\' && i + 1 < p.length) re += escape(p[++i]);
    else if (p.startsWith('/**', i)) {
      re += '(?:/[^/]*)*';
      i += 2;
    } else if (p.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (p[i] === '*') re += '[^/]*';
    else re += escape(p[i]);
  }
  return new RegExp('^' + re + '/?$');
}

/** A path as written in a spec, as a pattern that matches only that path. */
export const escapePath = (path: string) => path.replace(/[\\*]/g, '\\$&');

/** An endpoint that moved matches rules for where it was as well as where it is. */
export function matches(rule: IgnoreRule, c: Change): boolean {
  if (rule.id && !idMatcher(rule.id).test(c.id)) return false;
  const at = [{ method: c.method, path: c.path }, ...(c.movedFrom ? [c.movedFrom] : [])];
  return at.some((e) => {
    if (rule.method && (!e.method || rule.method.toUpperCase() !== e.method)) return false;
    if (rule.path && (!e.path || !pathMatcher(rule.path).test(e.path))) return false;
    return true;
  });
}

/** Marks ignored changes and applies "warnings as errors". Returns new objects. */
export function applyPolicy(changes: Change[], policy: Policy): Change[] {
  return changes.map((c) => {
    const out: Change = { ...c };
    if (policy.warningsAsErrors && out.level === 'warning') out.level = 'error';
    const hit = policy.ignore.find((r) => matches(r, c));
    if (hit) out.ignored = hit.reason ?? '';
    else delete out.ignored;
    return out;
  });
}

export interface Counts {
  error: number;
  warning: number;
  info: number;
  ignored: number;
}

export function count(changes: Change[]): Counts {
  const c: Counts = { error: 0, warning: 0, info: 0, ignored: 0 };
  for (const x of changes) {
    if (x.ignored !== undefined) c.ignored++;
    else c[x.level]++;
  }
  return c;
}

export function atLeast(level: Level, min: Level) {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[min];
}
