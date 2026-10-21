import { lineStarts, parseText, position, type Locs } from './parse';

export type Version = '2.0' | '3.0' | '3.1';

/** One parsed file of a spec. `path` is a POSIX path; relative `$ref`s resolve against it. */
export interface Doc {
  path: string;
  text: string;
  root: unknown;
  locs: Locs;
  lines?: number[];
}

export interface Spec {
  main: Doc;
  /** Every file reached through `$ref`, by path, the main one included. */
  docs: Map<string, Doc>;
  version: Version;
  /** The `openapi` / `swagger` field as written. */
  versionText: string;
  /** Things that didn't stop the comparison: unresolved or remote references. */
  warnings: string[];
  /** Schemas by URI, from `$id`, `$anchor` and `$dynamicAnchor` (JSON Schema 2020-12). Built on first use. */
  ids?: Map<string, N>;
}

/** A value and where it physically is: which file, and the chain of keys to it. */
export interface N {
  v: any;
  doc: Doc;
  parent?: N;
  key?: string;
}

/** Where a change is, for people and editors. Lines and columns are 0-based. */
export interface Loc {
  file: string;
  pointer: string;
  line: number;
  col: number;
}

export interface LoadError {
  message: string;
  file: string;
  line?: number;
  col?: number;
}

export type Reader = (path: string) => Promise<string | undefined>;

export const MAX_FILES = 500;

/**
 * For schemas made up from other parts of a spec (Swagger 2.0 form parameters): where each
 * property really is, by the made-up `properties` object.
 */
export const PLACED = new WeakMap<object, Map<string, N>>();

export function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function own(o: unknown, k: string): any {
  return isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

export const child = (n: N, key: string): N => ({
  v: n.v !== null && typeof n.v === 'object' && Object.prototype.hasOwnProperty.call(n.v, key) ? n.v[key] : undefined,
  doc: n.doc,
  parent: n,
  key,
});

export function keysOf(n: N): string[] {
  return isObj(n.v) ? Object.keys(n.v) : [];
}

export function pointerOf(n: N): string {
  const keys: string[] = [];
  for (let c: N | undefined = n; c?.key !== undefined; c = c.parent) keys.push(c.key);
  return keys.reverse().map((k) => '/' + k.replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

function segments(n: N): string[] {
  const keys: string[] = [];
  for (let c: N | undefined = n; c?.key !== undefined; c = c.parent) keys.push(c.key);
  return keys.reverse();
}

/** The line of a node: its key's line when it is a property, else where it starts. */
export function locate(n: N): Loc {
  const doc = n.doc;
  let obj: any = doc.root;
  let offset = 0;
  for (const k of segments(n)) {
    if (obj === null || typeof obj !== 'object') break;
    const at = doc.locs.get(obj)?.get(k);
    if (at === undefined) break;
    offset = at;
    obj = Array.isArray(obj) ? obj[Number(k)] : own(obj, k);
  }
  doc.lines ??= lineStarts(doc.text);
  const { line, col } = position(doc.lines, offset);
  return { file: doc.path, pointer: pointerOf(n), line, col };
}

export function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

/** `a/b/c.yaml` + `../d.yaml` → `a/d.yaml`. Returns undefined for remote references. */
export function resolvePath(base: string, rel: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) && !/^[a-z]:[\\/]/i.test(rel)) return undefined; // http:, https:, file:, urn:
  let r: string;
  try {
    r = decodeURIComponent(rel);
  } catch {
    r = rel;
  }
  r = r.replace(/\\/g, '/');
  const joined = r.startsWith('/') ? r : dirname(base) + r;
  const out: string[] = [];
  const lead = joined.startsWith('/') ? '/' : '';
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!lead) out.push('..');
    } else out.push(part);
  }
  return lead + out.join('/');
}

function decodePointer(fragment: string): string[] | undefined {
  let f = fragment;
  try {
    f = decodeURIComponent(f);
  } catch {
    /* keep as written */
  }
  if (f === '' || f === '/') return [];
  if (!f.startsWith('/')) return undefined; // anchors ($anchor / $id) are not supported
  return f
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function nodeAt(doc: Doc, keys: string[]): N | undefined {
  let n: N = { v: doc.root, doc };
  for (const k of keys) {
    n = child(n, k);
    if (n.v === undefined) return undefined;
  }
  return n;
}

/**
 * Follows `$ref` (local and to other files already loaded) until it reaches a value, or a
 * node `keep` says to stop at. A missing target is recorded once in `spec.warnings` and
 * resolves to undefined.
 */
export function deref(spec: Spec, n: N | undefined, keep?: (v: Record<string, any>) => boolean): N | undefined {
  let cur = n;
  for (let hops = 0; cur && isObj(cur.v) && typeof cur.v.$ref === 'string' && !keep?.(cur.v); hops++) {
    if (hops > 64) {
      warn(spec, `A chain of $ref is too long or loops: ${cur.v.$ref}`);
      return undefined;
    }
    cur = target(spec, cur, cur.v.$ref);
  }
  return cur;
}

const warned = new WeakMap<Spec, Set<string>>();
function warn(spec: Spec, msg: string) {
  let s = warned.get(spec);
  if (!s) warned.set(spec, (s = new Set()));
  if (s.has(msg)) return;
  s.add(msg);
  spec.warnings.push(msg);
}

function target(spec: Spec, from: N, ref: string): N | undefined {
  const doc = from.doc;
  const hash = ref.indexOf('#');
  const file = hash < 0 ? ref : ref.slice(0, hash);
  const frag = hash < 0 ? '' : ref.slice(hash + 1);
  const isPointer = frag === '' || frag.startsWith('/') || frag.startsWith('%2F') || frag.startsWith('%2f');
  // `$id` / `$anchor`: a reference to a URI that a schema in the spec declares.
  if ((file || !isPointer) && hasIds(spec)) {
    const found = byUri(spec, from, file, frag, isPointer);
    if (found) return found;
  }
  let d = doc;
  if (file) {
    const p = resolvePath(doc.path, file);
    if (p === undefined) {
      warn(spec, `Remote reference not followed: ${ref}`);
      return undefined;
    }
    const found = spec.docs.get(p);
    if (!found) {
      warn(spec, `Reference to a file that couldn't be read: ${ref} (in ${doc.path})`);
      return undefined;
    }
    d = found;
  }
  const keys = decodePointer(frag);
  if (!keys) {
    warn(spec, `Reference to an anchor that no schema declares: ${ref} (in ${doc.path})`);
    return undefined;
  }
  const n = nodeAt(d, keys);
  if (!n) warn(spec, `Reference to something that doesn't exist: ${ref} (in ${doc.path})`);
  return n;
}

// --- $id and $anchor -----------------------------------------------------------------------

const ID_KEYS = /"?\$(?:id|anchor|dynamicAnchor|self)"?\s*:/;

function hasIds(spec: Spec): boolean {
  if (!spec.ids) {
    spec.ids = new Map();
    for (const d of spec.docs.values()) if (ID_KEYS.test(d.text)) indexIds(spec, d);
  }
  return spec.ids.size > 0;
}

const docUri = (d: Doc) => 'file://' + encodeURI(d.path.startsWith('/') ? d.path : '/' + d.path).replace(/#/g, '%23').replace(/\?/g, '%3F');

function joinUri(ref: string, base: string): string | undefined {
  try {
    return new URL(ref, base).href;
  } catch {
    return undefined;
  }
}

const noFragment = (u: string) => {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
};

/**
 * Maps whose keys are names the spec author chose, not keywords: a property called
 * `example` or `default` is still a schema.
 */
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'schemas', 'responses', 'headers', 'parameters']);

/** Keywords whose values are data, never schemas: not searched for `$ref`s or `$id`s. */
const DATA_KEYS = new Set(['example', 'examples', 'x-examples']);
const VALUE_KEYS = new Set([...DATA_KEYS, 'enum', 'const', 'default']);

/** Records every `$id`, `$anchor` and `$dynamicAnchor` in a file under its absolute URI. */
function indexIds(spec: Spec, d: Doc) {
  let base = docUri(d);
  const self = own(d.root, '$self'); // OpenAPI 3.2
  if (typeof self === 'string') base = joinUri(self, base) ?? base;
  const seen = new Set<object>();
  const walk = (n: N, b: string, depth: number, names = false) => {
    const v = n.v;
    if (v === null || typeof v !== 'object' || seen.has(v) || depth > 400) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(child(n, String(i)), b, depth + 1);
      return;
    }
    let here = b;
    if (typeof v.$id === 'string') {
      const abs = joinUri(v.$id, b);
      if (abs) {
        here = noFragment(abs);
        if (!spec.ids!.has(here)) spec.ids!.set(here, n);
      }
    }
    for (const k of ['$anchor', '$dynamicAnchor']) {
      if (typeof v[k] === 'string' && !spec.ids!.has(`${here}#${v[k]}`)) spec.ids!.set(`${here}#${v[k]}`, n);
    }
    for (const k of Object.keys(v)) {
      if (!names && VALUE_KEYS.has(k)) continue;
      walk(child(n, k), here, depth + 1, !names && NAME_MAPS.has(k));
    }
  };
  walk({ v: d.root, doc: d }, base, 0);
}

/** The base URI in effect at a node: its file's, changed by every `$id` on the way to it. */
function baseOf(n: N): string {
  const chain: N[] = [];
  for (let c: N | undefined = n; c; c = c.parent) chain.push(c);
  let base = docUri(n.doc);
  const self = own(n.doc.root, '$self');
  if (typeof self === 'string') base = joinUri(self, base) ?? base;
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = own(chain[i].v, '$id');
    if (typeof id === 'string') base = noFragment(joinUri(id, base) ?? base);
  }
  return base;
}

function byUri(spec: Spec, from: N, file: string, frag: string, isPointer: boolean): N | undefined {
  const base = baseOf(from);
  const resource = file ? joinUri(file, base) : base;
  if (!resource) return undefined;
  const key = noFragment(resource);
  if (!isPointer) {
    let name = frag;
    try {
      name = decodeURIComponent(frag);
    } catch {
      /* keep */
    }
    const hit = spec.ids!.get(`${key}#${name}`);
    if (hit) return hit;
    // An anchor in the same file but under another base: unique names only.
    if (!file) {
      const same = [...spec.ids!.entries()].filter(([k, n]) => k.endsWith('#' + name) && n.doc === from.doc);
      if (same.length === 1) return same[0][1];
    }
    return undefined;
  }
  const root = spec.ids!.get(key);
  if (!root) return undefined;
  const keys = decodePointer(frag);
  if (!keys) return undefined;
  let n: N = root;
  for (const k of keys) {
    n = child(n, k);
    if (n.v === undefined) return undefined;
  }
  return n;
}

/** Every file part of the `$ref`s in a value. */
function refFiles(root: unknown): string[] {
  const out = new Set<string>();
  const seen = new Set<object>();
  // Each value with whether its keys are names (the inside of `properties`).
  const stack: Array<[unknown, boolean]> = [[root, false]];
  while (stack.length) {
    const [v, names] = stack.pop()!;
    if (v === null || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) stack.push([x, false]);
      continue;
    }
    for (const [k, x] of Object.entries(v)) {
      if (!names && k === '$ref' && typeof x === 'string') {
        const hash = x.indexOf('#');
        const file = hash < 0 ? x : x.slice(0, hash);
        if (file) out.add(file);
      } else if (names || !DATA_KEYS.has(k)) stack.push([x, !names && NAME_MAPS.has(k)]);
    }
  }
  return [...out];
}

export function detectVersion(root: unknown): { version?: Version; text?: string } {
  const oa = own(root, 'openapi');
  if (oa !== undefined) {
    const t = String(oa);
    // `openapi: 3.0` unquoted is the number 3.
    if (/^3(\.0(\.|$)|$)/.test(t)) return { version: '3.0', text: t === '3' ? '3.0' : t };
    if (/^3\.\d+/.test(t)) return { version: '3.1', text: t };
    return { text: t };
  }
  const sw = own(root, 'swagger');
  if (sw !== undefined) {
    const t = String(sw);
    return /^2(\.0)?$/.test(t) ? { version: '2.0', text: t } : { text: t };
  }
  return {};
}

function parseDoc(text: string, path: string): { doc?: Doc; error?: LoadError } {
  const r = parseText(text);
  if (r.error) {
    const { line, col } = position(lineStarts(text), r.error.offset);
    return { error: { message: r.error.message, file: path, line, col } };
  }
  return { doc: { path, text, root: r.value, locs: r.locs } };
}

/**
 * Parses a spec and every file its `$ref`s reach. `read` returns a file's text, or
 * undefined when it can't (or mustn't) be read; such references become warnings.
 */
export async function loadSpec(text: string, path: string, read?: Reader): Promise<{ spec?: Spec; error?: LoadError }> {
  const first = parseDoc(text, path);
  if (!first.doc) return { error: first.error };
  const main = first.doc;
  if (!isObj(main.root)) return { error: { message: 'Not an OpenAPI document: the file is not an object.', file: path, line: 0, col: 0 } };
  const { version, text: versionText } = detectVersion(main.root);
  if (!version)
    return {
      error: {
        message: versionText
          ? `Unsupported version ${JSON.stringify(versionText)}: OpenAPI 3.x and Swagger 2.0 are supported.`
          : 'Not an OpenAPI document: it has no `openapi` or `swagger` field.',
        file: path,
        line: 0,
        col: 0,
      },
    };
  const spec: Spec = { main, docs: new Map([[path, main]]), version, versionText: versionText!, warnings: [] };
  const queue: Doc[] = [main];
  const tried = new Set<string>([path]);
  while (queue.length) {
    const doc = queue.shift()!;
    for (const file of refFiles(doc.root)) {
      const p = resolvePath(doc.path, file);
      if (p === undefined || tried.has(p)) continue;
      tried.add(p);
      if (tried.size > MAX_FILES) {
        warn(spec, `More than ${MAX_FILES} referenced files; the rest were not read.`);
        break;
      }
      let t: string | undefined;
      try {
        t = read ? await read(p) : undefined;
      } catch {
        t = undefined;
      }
      if (t === undefined) continue; // reported when something actually uses it
      const r = parseDoc(t, p);
      if (!r.doc) {
        warn(spec, `${p}: ${r.error!.message} (line ${(r.error!.line ?? 0) + 1})`);
        continue;
      }
      spec.docs.set(p, r.doc);
      queue.push(r.doc);
    }
  }
  return { spec };
}
