import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, type Document, type Node as YNode } from 'yaml';
import { parseJson } from './json';

/** For every object and array: where each of its properties (the key) or items starts. */
export type Locs = WeakMap<object, Map<string, number>>;

export interface ParseError {
  message: string;
  offset: number;
}

export interface ParseResult {
  value?: unknown;
  locs: Locs;
  error?: ParseError;
}

/** JSON when it looks like JSON (fast, exact positions), YAML otherwise. */
export function parseText(text: string): ParseResult {
  const start = text.replace(/^﻿/, '').trimStart()[0];
  if (start === '{' || start === '[') {
    const r = parseJson(text);
    if (!r.error) return r;
    // JSON with comments or trailing commas is still valid-enough YAML for some files.
    const y = parseYaml(text);
    return y.error ? r : y;
  }
  return parseYaml(text);
}

export function parseYaml(text: string): ParseResult {
  const locs: Locs = new WeakMap();
  let doc: Document;
  try {
    doc = parseDocument(text, { merge: true, uniqueKeys: false, prettyErrors: false, strict: false });
  } catch (e) {
    return { locs, error: { message: e instanceof Error ? e.message : String(e), offset: 0 } };
  }
  const err = doc.errors[0];
  if (err) return { locs, error: { message: err.message.split('\n')[0], offset: err.pos[0] } };

  const seen = new Map<YNode, unknown>();
  const convert = (node: unknown, depth: number): unknown => {
    if (node == null) return null;
    if (depth > 2000) throw new Error('Nested too deeply');
    if (isAlias(node)) {
      const target = node.resolve(doc);
      return target ? convert(target, depth + 1) : null;
    }
    if (isScalar(node)) return node.value === undefined ? null : node.value;
    const yn = node as YNode;
    if (seen.has(yn)) return seen.get(yn);
    if (isMap(node)) {
      const obj: Record<string, unknown> = {};
      const at = new Map<string, number>();
      seen.set(yn, obj);
      locs.set(obj, at);
      const merges: unknown[] = [];
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const k = pair.key as YNode | null;
        // yaml marks merge keys with a symbol.
        const kv = isScalar(k) ? k.value : undefined;
        const merge = kv === '<<' || (typeof kv === 'symbol' && kv.description === '<<');
        const key = isScalar(k) ? String(typeof kv === 'symbol' ? kv.description : kv) : k == null ? '' : String(k);
        if (merge && (isAlias(pair.value) || isSeq(pair.value) || isMap(pair.value))) {
          merges.push(pair.value);
          continue;
        }
        Object.defineProperty(obj, key, { value: convert(pair.value, depth + 1), enumerable: true, writable: true, configurable: true });
        const offset = (k as YNode | null)?.range?.[0] ?? (pair.value as YNode | null)?.range?.[0];
        if (offset !== undefined) at.set(key, offset);
      }
      // Merge keys (<<: *base): explicit keys win.
      for (const m of merges) {
        const sources = isSeq(m) ? m.items : [m];
        for (const s of sources) {
          const src = convert(s, depth + 1);
          if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
          const srcAt = locs.get(src);
          for (const [k, v] of Object.entries(src)) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) continue;
            Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
            const o = srcAt?.get(k);
            if (o !== undefined) at.set(k, o);
          }
        }
      }
      return obj;
    }
    if (isSeq(node)) {
      const arr: unknown[] = [];
      const at = new Map<string, number>();
      seen.set(yn, arr);
      locs.set(arr, at);
      for (const item of node.items) {
        const offset = (item as YNode | null)?.range?.[0];
        if (offset !== undefined) at.set(String(arr.length), offset);
        arr.push(convert(item, depth + 1));
      }
      return arr;
    }
    return null;
  };
  try {
    return { value: convert(doc.contents, 0), locs };
  } catch (e) {
    return { locs, error: { message: e instanceof Error ? e.message : String(e), offset: 0 } };
  }
}

/** Offsets where each line starts, for turning offsets into line numbers. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 0-based line and column of an offset. */
export function position(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo] };
}
