import { codeSpan } from './md';
import type { Dir, Level } from './rules';
import { child, deref, isObj, own, PLACED, type N, type Spec } from './spec';

/**
 * A change found inside a schema, relative to it: `rel` is the property path below the
 * schema (`[]` for array items, `*` for additionalProperties, `(Name)` for a oneOf/anyOf
 * option). The caller names the schema and turns `rule` into an id.
 */
export interface Raw {
  rule: string;
  level: Level;
  rel: string[];
  text: string;
  o?: N;
  n?: N;
}

interface Bound {
  v: number;
  ex: boolean;
}

interface View {
  n: N;
  types?: Set<string>;
  /** The types are only what the oneOf / anyOf options allow. */
  typesFromOptions?: boolean;
  nullable: boolean;
  format?: string;
  enumVals?: unknown[];
  props: Map<string, N>;
  required: Set<string>;
  /** Where `properties` is, for pointing at a property that isn't there any more. */
  propsAt?: N;
  additional: 'open' | 'closed' | N;
  items?: N;
  oneOf?: N[];
  anyOf?: N[];
  discriminator?: { prop: string; mapping: Map<string, string>; node: N };
  max?: Bound;
  min?: Bound;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
  maxProperties?: number;
  minProperties?: number;
  /** Every `multipleOf` in effect (allOf members each add theirs). */
  multiples: number[];
  uniqueItems: boolean;
  /** Every `pattern` in effect: a value must match all of them. */
  patterns: string[];
  hasDefault: boolean;
  default?: unknown;
  title?: string;
}

/** Keywords that say nothing about which values are valid. */
const ANNOTATIONS = new Set(['description', 'title', 'summary', '$comment', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs', 'xml', '$id', '$anchor', '$dynamicAnchor', '$schema', '$defs', 'definitions']);

/** Keywords that describe a value other than `null`. */
const SHAPE = ['properties', 'items', 'prefixItems', 'additionalProperties', 'allOf', 'oneOf', 'anyOf', 'not', '$ref', 'format', 'pattern'];

const code = (v: unknown) => codeSpan(typeof v === 'string' ? v : JSON.stringify(v));
const list = (vs: unknown[]) => {
  const shown = vs.slice(0, 8).map(code).join(', ');
  return vs.length > 8 ? `${shown} and ${vs.length - 8} more` : shown;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function typesOf(v: Record<string, any>): { types?: Set<string>; nullable: boolean } {
  const t = v.type;
  let nullable = v.nullable === true || v['x-nullable'] === true;
  let types: Set<string> | undefined;
  if (typeof t === 'string') types = new Set([t]);
  else if (Array.isArray(t)) types = new Set(t.filter((x): x is string => typeof x === 'string'));
  if (types?.has('null')) {
    nullable = true;
    types.delete('null');
    if (!types.size) types = undefined;
  }
  if (!types) {
    // No type: infer it from what the schema describes, so adding `type: object` next to
    // `properties` isn't reported as a change.
    if (isObj(v.properties) || v.additionalProperties !== undefined) types = new Set(['object']);
    else if (v.items !== undefined) types = new Set(['array']);
  }
  if (types?.has('integer') && types.has('number')) types.delete('integer');
  return { types, nullable };
}

function enumOf(v: Record<string, any>): unknown[] | undefined {
  const e = Array.isArray(v.enum) ? v.enum : v.const !== undefined ? [v.const] : undefined;
  return e?.filter((x) => x !== null);
}

const bound = (v: Record<string, any>, key: 'maximum' | 'minimum', exKey: 'exclusiveMaximum' | 'exclusiveMinimum'): Bound | undefined => {
  const plain = num(v[key]);
  const ex = v[exKey];
  if (typeof ex === 'number') {
    // 3.1: exclusiveMaximum is the bound itself; keep the tighter of the two.
    if (plain === undefined) return { v: ex, ex: true };
    const exTighter = key === 'maximum' ? ex <= plain : ex >= plain;
    return exTighter ? { v: ex, ex: true } : { v: plain, ex: false };
  }
  return plain === undefined ? undefined : { v: plain, ex: ex === true };
};

/** Comparison of two bounds: >0 when `b` is tighter than `a`. */
function tighter(a: Bound | undefined, b: Bound | undefined, isMax: boolean): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a.v !== b.v) return isMax ? a.v - b.v : b.v - a.v;
  return (b.ex ? 1 : 0) - (a.ex ? 1 : 0);
}

/** The tighter of two bounds. */
const tightest = (a: Bound | undefined, b: Bound | undefined, isMax: boolean) => (tighter(a, b, isMax) > 0 ? b : a);
const least = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
const most = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

const showBound = (b: Bound, isMax: boolean) => `${b.ex ? (isMax ? '<' : '>') : ''}${b.v}`;

function discriminatorOf(n: N): View['discriminator'] {
  const d = own(n.v, 'discriminator');
  // Swagger 2.0: `discriminator` is the property name itself.
  const prop = typeof d === 'string' ? d : own(d, 'propertyName');
  if (typeof prop !== 'string') return undefined;
  const mapping = new Map<string, string>();
  const m = own(d, 'mapping');
  if (isObj(m)) for (const [k, t] of Object.entries(m)) if (typeof t === 'string') mapping.set(k, t);
  return { prop, mapping, node: typeof d === 'string' ? child(n, 'discriminator') : child(n, 'discriminator') };
}

/** The last part of a reference or mapping target: `#/components/schemas/Dog` → `Dog`. */
const refName = (ref: string) => ref.split(/[/#]/).filter(Boolean).pop() ?? ref;

/** What an unnamed schema looks like, for matching options by structure. */
function features(v: unknown, spec: Spec, n: N): Set<string> {
  const out = new Set<string>();
  const d = deref(spec, n);
  const x: Record<string, any> = isObj(d?.v) ? d!.v : isObj(v) ? v : {};
  const { types } = typesOf(x);
  for (const t of types ?? []) out.add('t:' + t);
  if (typeof x.format === 'string') out.add('f:' + x.format);
  if (isObj(x.properties)) for (const k of Object.keys(x.properties)) out.add('p:' + k);
  if (Array.isArray(x.required)) for (const k of x.required) out.add('r:' + String(k));
  if (Array.isArray(x.enum)) for (const e of x.enum) out.add('e:' + JSON.stringify(e));
  if (x.const !== undefined) out.add('e:' + JSON.stringify(x.const));
  if (isObj(x.items)) {
    const it = typeof x.items.$ref === 'string' ? 'ref:' + refName(x.items.$ref) : 'type:' + String(x.items.type);
    out.add('i:' + it);
  }
  if (Array.isArray(x.allOf)) for (const m of x.allOf) if (typeof own(m, '$ref') === 'string') out.add('a:' + refName(m.$ref));
  return out;
}

/** What a schema describes, as a set, for finding the option most like it. */
function viewFeatures(v: View): Set<string> {
  const out = new Set<string>();
  for (const t of v.types ?? []) out.add('t:' + t);
  if (v.format) out.add('f:' + v.format);
  for (const k of v.props.keys()) out.add('p:' + k);
  for (const k of v.required) out.add('r:' + k);
  for (const e of v.enumVals ?? []) out.add('e:' + JSON.stringify(e));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

const WIDER_FORMAT: Record<string, string[]> = {
  int32: ['int64'],
  float: ['double'],
  'date-time': [],
};

/**
 * A pair of schemas, old and new, as seen from one direction: the changes at the pair
 * itself and the pairs one level down (properties, items, options).
 */
interface Pair {
  od: N;
  nd: N;
  raws: Raw[];
  edges: Array<{ seg: string; to: Pair }>;
  /** Pairs with an edge to this one. */
  from: Pair[];
  expanded: boolean;
  /** A change is reachable from here. */
  dirty: boolean;
  walk?: Raw[];
  /** Nullability was already judged one level up (a plain schema against a union's option). */
  noNull: boolean;
}

export class SchemaDiff {
  private pairs = new Map<string, WeakMap<object, WeakMap<object, Pair>>>();
  private views = new WeakMap<object, View>();
  private static TRUE = {};
  private static FALSE = { not: {} };

  constructor(
    private oldSpec: Spec,
    private newSpec: Spec,
  ) {}

  /**
   * Compares two schemas (either may be a `$ref`) as seen from `dir`. Every pair of
   * subschemas is compared once; then the pairs that lead to a change are walked breadth
   * first, so recursive schemas end and each change is reported at its shortest path.
   */
  diff(o: N | undefined, n: N | undefined, dir: Dir): Raw[] {
    const root = this.pair(o, n, dir);
    if (!root) return [];
    if (root.walk) return root.walk;
    this.expandFrom(root, dir);
    const out: Raw[] = [];
    if (root.dirty) {
      const seen = new Set<Pair>([root]);
      let level: Array<{ p: Pair; rel: string[] }> = [{ p: root, rel: [] }];
      while (level.length) {
        const next: typeof level = [];
        for (const { p, rel } of level) {
          for (const r of p.raws) out.push(rel.length ? { ...r, rel: [...rel, ...r.rel] } : r);
          for (const e of p.edges) {
            if (!e.to.dirty || seen.has(e.to)) continue;
            seen.add(e.to);
            next.push({ p: e.to, rel: [...rel, e.seg] });
          }
        }
        level = next;
      }
    }
    root.walk = out;
    return out;
  }

  private pair(o: N | undefined, n: N | undefined, dir: Dir, noNull = false): Pair | undefined {
    const od = this.resolve(this.oldSpec, o);
    const nd = this.resolve(this.newSpec, n);
    if (!od || !nd) return undefined;
    const ok = this.key(od.v);
    const nk = this.key(nd.v);
    const mode = noNull ? dir + '!' : dir;
    let byOld = this.pairs.get(mode);
    if (!byOld) this.pairs.set(mode, (byOld = new WeakMap()));
    let m = byOld.get(ok);
    if (!m) byOld.set(ok, (m = new WeakMap()));
    let p = m.get(nk);
    if (!p) m.set(nk, (p = { od, nd, raws: [], edges: [], from: [], expanded: false, dirty: false, noNull }));
    return p;
  }

  /** Compares every pair reachable from `root` that hasn't been compared yet. */
  private expandFrom(root: Pair, dir: Dir) {
    const stack = [root];
    while (stack.length) {
      const p = stack.pop()!;
      if (p.expanded) continue;
      p.expanded = true;
      p.raws = this.compare(p.od, p.nd, dir, p.noNull, (o, n, seg, noNull) => {
        const to = this.pair(o, n, dir, noNull);
        if (!to) return;
        p.edges.push({ seg, to });
        to.from.push(p);
        if (!to.expanded) stack.push(to);
      });
      if (p.raws.length) this.markDirty(p);
      for (const e of p.edges) if (e.to.dirty) this.markDirty(p);
    }
  }

  private markDirty(p: Pair) {
    if (p.dirty) return;
    p.dirty = true;
    const stack = [p];
    while (stack.length) {
      for (const f of stack.pop()!.from) {
        if (f.dirty) continue;
        f.dirty = true;
        stack.push(f);
      }
    }
  }

  private key(v: unknown): object {
    if (isObj(v)) return v;
    return v === false ? SchemaDiff.FALSE : SchemaDiff.TRUE;
  }

  /**
   * The schema a node stands for: `$ref`s followed, except in OpenAPI 3.1, where keywords
   * next to a `$ref` apply as well (the node is then viewed as both).
   */
  private resolve(spec: Spec, n: N | undefined): N | undefined {
    return deref(spec, n, (v) => this.siblings(spec, v));
  }

  /** A `$ref` with keywords of its own next to it, which OpenAPI 3.1 applies. */
  private siblings(spec: Spec, v: Record<string, any>): boolean {
    if (spec.version === '2.0' || spec.version === '3.0') return false;
    for (const k in v) if (k !== '$ref' && !ANNOTATIONS.has(k) && !k.startsWith('x-')) return true;
    return false;
  }

  /** An option that only allows `null`: `{type: 'null'}`, `{enum: [null]}`. */
  private nullOnly(spec: Spec, m: N): boolean {
    const d = deref(spec, m);
    if (!d || !isObj(d.v)) return false;
    const v = d.v;
    const nullEnum = (Array.isArray(v.enum) && v.enum.length > 0 && v.enum.every((x: unknown) => x === null)) || (own(v, 'const') === null);
    if (!nullEnum) {
      const { types, nullable } = typesOf(v);
      if (types || !nullable || v.enum !== undefined || v.const !== undefined) return false;
    }
    return !SHAPE.some((k) => v[k] !== undefined);
  }

  private view(spec: Spec, n: N, depth = 0): View {
    const cached = isObj(n.v) ? this.views.get(n.v) : undefined;
    if (cached) return cached;
    const v: Record<string, any> = isObj(n.v) ? n.v : {};
    const { types, nullable } = typesOf(v);
    const props = new Map<string, N>();
    const propsNode = child(n, 'properties');
    if (isObj(propsNode.v)) {
      const placed = PLACED.get(propsNode.v);
      for (const k of Object.keys(propsNode.v)) props.set(k, placed?.get(k) ?? child(propsNode, k));
    }
    const required = new Set<string>(Array.isArray(v.required) ? v.required.filter((x: unknown): x is string => typeof x === 'string') : []);
    const ap = v.additionalProperties;
    const out: View = {
      n,
      types,
      nullable,
      format: typeof v.format === 'string' ? v.format : undefined,
      enumVals: enumOf(v),
      props,
      required,
      propsAt: isObj(propsNode.v) ? propsNode : undefined,
      // `{}` (or only annotations) allows anything, the same as `true`.
      additional: ap === false ? 'closed' : isObj(ap) && Object.keys(ap).some((k) => !ANNOTATIONS.has(k) && !k.startsWith('x-')) ? child(n, 'additionalProperties') : 'open',
      items: v.items !== undefined && !Array.isArray(v.items) ? child(n, 'items') : undefined,
      oneOf: Array.isArray(v.oneOf) ? v.oneOf.map((_: unknown, i: number) => child(child(n, 'oneOf'), String(i))) : undefined,
      anyOf: Array.isArray(v.anyOf) ? v.anyOf.map((_: unknown, i: number) => child(child(n, 'anyOf'), String(i))) : undefined,
      discriminator: discriminatorOf(n),
      max: bound(v, 'maximum', 'exclusiveMaximum'),
      min: bound(v, 'minimum', 'exclusiveMinimum'),
      maxLength: num(v.maxLength),
      minLength: num(v.minLength) || undefined,
      maxItems: num(v.maxItems),
      minItems: num(v.minItems) || undefined,
      maxProperties: num(v.maxProperties),
      minProperties: num(v.minProperties) || undefined,
      multiples: num(v.multipleOf) && v.multipleOf > 0 ? [v.multipleOf] : [],
      uniqueItems: v.uniqueItems === true,
      patterns: typeof v.pattern === 'string' ? [v.pattern] : [],
      hasDefault: Object.prototype.hasOwnProperty.call(v, 'default'),
      default: v.default,
      title: typeof v.title === 'string' ? v.title : undefined,
    };
    if (depth < 32) {
      // OpenAPI 3.1: keywords next to a `$ref` (only such nodes get here) apply on top of its target.
      if (typeof v.$ref === 'string') {
        const t = deref(spec, n, (x) => x !== n.v && this.siblings(spec, x));
        if (t && t.v !== n.v) this.absorb(out, this.view(spec, t, depth + 1));
      }
      // allOf: one schema with the members' properties, required lists and constraints.
      if (Array.isArray(v.allOf)) {
        const allOf = child(n, 'allOf');
        for (let i = 0; i < v.allOf.length; i++) {
          const m = this.resolve(spec, child(allOf, String(i)));
          if (!m || m.v === n.v) continue;
          this.absorb(out, this.view(spec, m, depth + 1));
        }
      }
      // A `null` option (`anyOf: [X, {type: 'null'}]`, as pydantic writes Optional[X]) only
      // makes the schema nullable.
      for (const kind of ['oneOf', 'anyOf'] as const) {
        const opts = out[kind];
        if (!opts) continue;
        const real = opts.filter((m) => !this.nullOnly(spec, m));
        if (real.length === opts.length) continue;
        out.nullable = true;
        out[kind] = real.length ? real : undefined;
      }
      // One option left: the schema is that option.
      const only = !out.discriminator && (out.oneOf?.length === 1 && !out.anyOf ? out.oneOf[0] : out.anyOf?.length === 1 && !out.oneOf ? out.anyOf[0] : undefined);
      if (only) {
        out.oneOf = out.anyOf = undefined;
        const d = this.resolve(spec, only);
        if (d && d.v !== n.v) this.absorb(out, this.view(spec, d, depth + 1));
      }
    }
    // No type of its own, only options: it is any of their types (when they all say).
    if (!out.types && depth < 32) {
      const opts = out.oneOf ?? out.anyOf;
      if (opts?.length) {
        const union = new Set<string>();
        let known = true;
        for (const m of opts) {
          const d = this.resolve(spec, m);
          const t = d && d.v !== n.v ? this.view(spec, d, depth + 1) : undefined;
          if (!t?.types) {
            known = false;
            break;
          }
          for (const x of t.types) union.add(x);
          out.nullable ||= t.nullable;
        }
        if (known && union.size) {
          if (union.has('integer') && union.has('number')) union.delete('integer');
          out.types = union;
          out.typesFromOptions = true;
        }
      }
    }
    if (isObj(n.v)) this.views.set(n.v, out);
    return out;
  }

  /** Adds what another schema that also applies says (an allOf member, a `$ref` target). */
  private absorb(out: View, mv: View) {
    for (const [k, p] of mv.props) if (!out.props.has(k)) out.props.set(k, p);
    for (const k of mv.required) out.required.add(k);
    out.propsAt ??= mv.propsAt;
    if (!out.types && mv.types) {
      out.types = mv.types;
      out.typesFromOptions = mv.typesFromOptions;
    }
    out.nullable ||= mv.nullable;
    out.format ??= mv.format;
    // Both apply: only the values both allow are valid.
    if (out.enumVals && mv.enumVals) {
      const keep = new Set(mv.enumVals.map((x) => JSON.stringify(x)));
      out.enumVals = out.enumVals.filter((x) => keep.has(JSON.stringify(x)));
    } else out.enumVals ??= mv.enumVals;
    if (out.additional === 'open') out.additional = mv.additional;
    out.items ??= mv.items;
    out.oneOf ??= mv.oneOf;
    out.anyOf ??= mv.anyOf;
    out.discriminator ??= mv.discriminator;
    // Every member applies: the tightest limit is the one in effect.
    out.max = tightest(out.max, mv.max, true);
    out.min = tightest(out.min, mv.min, false);
    out.maxLength = least(out.maxLength, mv.maxLength);
    out.minLength = most(out.minLength, mv.minLength);
    out.maxItems = least(out.maxItems, mv.maxItems);
    out.minItems = most(out.minItems, mv.minItems);
    out.maxProperties = least(out.maxProperties, mv.maxProperties);
    out.minProperties = most(out.minProperties, mv.minProperties);
    for (const m of mv.multiples) if (!out.multiples.includes(m)) out.multiples = [...out.multiples, m];
    out.uniqueItems ||= mv.uniqueItems;
    for (const p of mv.patterns) if (!out.patterns.includes(p)) out.patterns = [...out.patterns, p];
    out.title ??= mv.title;
    if (!out.hasDefault && mv.hasDefault) {
      out.hasDefault = true;
      out.default = mv.default;
    }
  }

  /** Names an option for people: its reference, title or discriminator value, else its position and type. */
  private optionLabel(spec: Spec, m: N, i: number, disc?: View['discriminator']): string {
    const ref = own(m.v, '$ref');
    if (typeof ref === 'string') return refName(ref);
    const d = deref(spec, m);
    const t = own(d?.v, 'title');
    if (typeof t === 'string') return t;
    const dv = disc && this.discValue(spec, m, disc);
    if (dv !== undefined) return dv;
    const type = own(d?.v, 'type');
    return `#${i + 1}${typeof type === 'string' ? ' ' + type : ''}`;
  }

  /** The discriminator value an option stands for: from the mapping, or its own `const` / single `enum`. */
  private discValue(spec: Spec, m: N, disc: NonNullable<View['discriminator']>): string | undefined {
    const ref = own(m.v, '$ref');
    if (typeof ref === 'string') {
      for (const [k, t] of disc.mapping) if (t === ref || refName(t) === refName(ref)) return k;
    }
    const d = deref(spec, m);
    const p = deref(spec, child(child(d ?? m, 'properties'), disc.prop));
    const c = own(p?.v, 'const');
    if (typeof c === 'string') return c;
    const e = own(p?.v, 'enum');
    if (Array.isArray(e) && e.length === 1 && typeof e[0] === 'string') return e[0];
    return typeof ref === 'string' && !disc.mapping.size ? refName(ref) : undefined;
  }

  private matchOptions(oo: N[], no: N[], od?: View['discriminator'], nd?: View['discriminator']) {
    const os = this.oldSpec;
    const ns = this.newSpec;
    const left = oo.map((m, i) => ({ m, i, label: this.optionLabel(os, m, i, od) }));
    const right = no.map((m, i) => ({ m, i, label: this.optionLabel(ns, m, i, nd) }));
    const pairs: Array<[N, N, string]> = [];
    const take = (key: (spec: Spec, m: N) => string | undefined) => {
      const byKey = new Map<string, number[]>();
      right.forEach((r, j) => {
        const k = key(ns, r.m);
        if (k !== undefined) byKey.set(k, [...(byKey.get(k) ?? []), j]);
      });
      for (let i = 0; i < left.length; i++) {
        const k = key(os, left[i].m);
        const js = k === undefined ? undefined : byKey.get(k);
        if (!js || js.length !== 1) continue;
        const [r] = right.splice(js[0], 1);
        pairs.push([left[i].m, r.m, r.label]);
        left.splice(i--, 1);
        // Indexes moved: rebuild.
        byKey.clear();
        right.forEach((x, j) => {
          const kk = key(ns, x.m);
          if (kk !== undefined) byKey.set(kk, [...(byKey.get(kk) ?? []), j]);
        });
      }
    };
    take((_, m) => (typeof own(m.v, '$ref') === 'string' ? 'ref:' + refName(own(m.v, '$ref')) : undefined));
    take((spec, m) => {
      const t = own(deref(spec, m)?.v, 'title');
      return typeof t === 'string' ? 'title:' + t : undefined;
    });
    if (od && nd) take((spec, m) => this.discValue(spec, m, spec === os ? od : nd));
    // What is left: the most alike first, when they share at least half of what they describe.
    if (left.length && right.length) {
      const scored: Array<[number, number, number]> = [];
      const lf = left.map((l) => features(l.m.v, os, l.m));
      const rf = right.map((r) => features(r.m.v, ns, r.m));
      for (let i = 0; i < left.length; i++) for (let j = 0; j < right.length; j++) scored.push([jaccard(lf[i], rf[j]), i, j]);
      scored.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
      const usedL = new Set<number>();
      const usedR = new Set<number>();
      for (const [score, i, j] of scored) {
        if (score < 0.5) break;
        if (usedL.has(i) || usedR.has(j)) continue;
        usedL.add(i);
        usedR.add(j);
        pairs.push([left[i].m, right[j].m, right[j].label]);
      }
      const l2 = left.filter((_, i) => !usedL.has(i));
      const r2 = right.filter((_, j) => !usedR.has(j));
      left.length = 0;
      left.push(...l2);
      right.length = 0;
      right.push(...r2);
    }
    return { pairs, removed: left.map((l) => [l.m, l.label] as [N, string]), added: right.map((r) => [r.m, r.label] as [N, string]) };
  }

  private flag(spec: Spec, n: N | undefined, key: string): boolean {
    const d = deref(spec, n);
    if (!d || !isObj(d.v)) return false;
    if (d.v[key] === true) return true;
    // A $ref with siblings (3.1) or a property wrapped in allOf: [$ref] with readOnly next to it.
    return isObj(n?.v) && n!.v[key] === true;
  }

  private compare(od: N, nd: N, dir: Dir, noNull: boolean, sub: (o: N | undefined, n: N | undefined, seg: string, noNull?: boolean) => void): Raw[] {
    const out: Raw[] = [];
    const req = dir === 'request';
    const add = (rule: string, level: Level, text: string, o: N = od, n: N = nd) => out.push({ rule, level, rel: [], text, o, n });
    /** The keyword's own line when it is written on this schema, else the schema's. */
    const kw = (x: N, ...keys: string[]) => {
      for (const k of keys) if (own(x.v, k) !== undefined) return child(x, k);
      return x;
    };
    const addAt = (rule: string, level: Level, text: string, ...keys: string[]) => add(rule, level, text, kw(od, ...keys), kw(nd, ...keys));
    const O = this.view(this.oldSpec, od);
    const W = this.view(this.newSpec, nd);

    const nullability = () => {
      if (noNull || O.nullable === W.nullable) return;
      if (W.nullable) addAt('became-nullable', req ? 'info' : 'warning', 'can now be `null`', 'nullable', 'x-nullable', 'type');
      else addAt('became-not-nullable', req ? 'error' : 'info', 'can no longer be `null`', 'nullable', 'x-nullable', 'type');
    };

    // A schema that became a union of options, or the other way round: it is compared with
    // the option most like it, and the other options were added (or removed).
    const optionsOf = (v: View) => (v.oneOf ? (['oneOf', v.oneOf] as const) : v.anyOf ? (['anyOf', v.anyOf] as const) : undefined);
    // A union with an explicit `type` of its own (`type: object` next to `oneOf`, as many
    // generators write) counts too, when that type is the plain side's.
    const sameSet = (a?: Set<string>, b?: Set<string>) => !!a && !!b && a.size === b.size && [...a].every((t) => b.has(t));
    const unionOnly = (v: View, plain: View) => !v.props.size && (!v.types || v.typesFromOptions || sameSet(v.types, plain.types)) && !v.items && !v.enumVals;
    const plainShape = (v: View) => !!v.types || v.props.size > 0;
    const oo = optionsOf(O);
    const no = optionsOf(W);
    if (!oo !== !no && (oo ? unionOnly(O, W) && plainShape(W) : unionOnly(W, O) && plainShape(O))) {
      const [kind, opts] = (oo ?? no)!;
      const unionSpec = oo ? this.oldSpec : this.newSpec;
      const pv = oo ? W : O;
      const disc = (oo ? O : W).discriminator;
      const pf = viewFeatures(pv);
      let best = 0;
      let bestScore = -1;
      opts.forEach((m, i) => {
        const d = this.resolve(unionSpec, m);
        if (!d) return;
        const mv = this.view(unionSpec, d);
        const score = jaccard(pf, viewFeatures(mv)) + (pv.title !== undefined && mv.title === pv.title ? 1 : 0);
        if (score > bestScore) [best, bestScore] = [i, score];
      });
      nullability();
      opts.forEach((m, i) => {
        const label = this.optionLabel(unionSpec, m, i, disc);
        if (i === best) {
          // Nullability is judged here, on the whole union: the option itself never carries the null.
          if (oo) sub(m, nd, `(${label})`, true);
          else sub(od, m, `(${label})`, true);
        } else if (oo) add('subschema-removed', req ? 'error' : 'info', `${kind} option ${code(label)} removed`, m, nd);
        else add('subschema-added', req ? 'info' : 'warning', `${kind} option ${code(label)} added`, od, m);
      });
      return out;
    }

    // Type. Integer is a kind of number.
    const accepts = (set: Set<string> | undefined, t: string) => !set || set.has(t) || (t === 'integer' && set.has('number'));
    const sameTypes = O.types?.size === W.types?.size && [...(O.types ?? [])].every((t) => W.types?.has(t));
    // Both only unions of their options: the options are compared one by one instead.
    if (!sameTypes && (O.types || W.types) && !(O.typesFromOptions && W.typesFromOptions)) {
      const widened = !!O.types && [...O.types].every((t) => accepts(W.types, t));
      const narrowed = !!W.types && [...W.types].every((t) => accepts(O.types, t));
      const show = (s?: Set<string>) => (s ? [...s].map(code).join(' | ') : 'any');
      const level: Level = req ? (widened ? 'info' : 'error') : narrowed ? 'info' : 'error';
      addAt('type-changed', level, `type changed from ${show(O.types)} to ${show(W.types)}`, 'type');
      // Unrelated types: comparing their insides would only add noise.
      if (!widened && !narrowed && O.types && W.types) return out;
    }

    nullability();

    if (O.format !== W.format) {
      const of = O.format;
      const nf = W.format;
      let level: Level;
      let text: string;
      if (!of) {
        level = req ? 'warning' : 'info';
        text = `format ${code(nf)} added`;
      } else if (!nf) {
        level = req ? 'info' : 'warning';
        text = `format ${code(of)} removed`;
      } else {
        const widened = WIDER_FORMAT[of]?.includes(nf);
        const narrowed = WIDER_FORMAT[nf]?.includes(of);
        level = req ? (widened ? 'info' : 'error') : narrowed ? 'info' : widened ? 'warning' : 'error';
        text = `format changed from ${code(of)} to ${code(nf)}`;
      }
      addAt('format-changed', level, text, 'format');
    }

    // Enum.
    if (O.enumVals || W.enumVals) {
      const k = (x: unknown) => JSON.stringify(x);
      if (O.enumVals && W.enumVals) {
        const ok = new Set(O.enumVals.map(k));
        const nk = new Set(W.enumVals.map(k));
        const removed = O.enumVals.filter((x) => !nk.has(k(x)));
        const added = W.enumVals.filter((x) => !ok.has(k(x)));
        if (removed.length) addAt('enum-value-removed', req ? 'error' : 'info', `enum value${removed.length > 1 ? 's' : ''} ${list(removed)} removed`, 'enum', 'const');
        if (added.length) addAt('enum-value-added', req ? 'info' : 'warning', `enum value${added.length > 1 ? 's' : ''} ${list(added)} added`, 'enum', 'const');
      } else if (W.enumVals) addAt('became-enum', req ? 'error' : 'info', `values now limited to ${list(W.enumVals)}`, 'enum', 'const');
      else addAt('no-longer-enum', req ? 'info' : 'warning', `no longer limited to ${list(O.enumVals!)}`, 'enum', 'const');
    }

    // Bounds: tighter is breaking for requests; for responses, informational either way.
    const bounds: Array<[string, Bound | undefined, Bound | undefined, boolean]> = [
      ['max', O.max, W.max, true],
      ['min', O.min, W.min, false],
    ];
    for (const [name, a, b, isMax] of bounds) {
      const t = tighter(a, b, isMax);
      if (t === 0) continue;
      const word = isMax ? 'maximum' : 'minimum';
      const text = !a ? `${word} ${showBound(b!, isMax)} added` : !b ? `${word} ${showBound(a, isMax)} removed` : `${word} changed from ${showBound(a, isMax)} to ${showBound(b, isMax)}`;
      const keys = isMax ? ['maximum', 'exclusiveMaximum'] : ['minimum', 'exclusiveMinimum'];
      if (t > 0) addAt(`${name}-${isMax ? 'decreased' : 'increased'}`, req ? 'error' : 'info', text, ...keys);
      else addAt(`${name}-${isMax ? 'increased' : 'decreased'}`, 'info', text, ...keys);
    }
    const counts: Array<[string, string, number | undefined, number | undefined, boolean]> = [
      ['max-length', 'maxLength', O.maxLength, W.maxLength, true],
      ['min-length', 'minLength', O.minLength, W.minLength, false],
      ['max-items', 'maxItems', O.maxItems, W.maxItems, true],
      ['min-items', 'minItems', O.minItems, W.minItems, false],
      ['max-properties', 'maxProperties', O.maxProperties, W.maxProperties, true],
      ['min-properties', 'minProperties', O.minProperties, W.minProperties, false],
    ];
    for (const [rule, word, a, b, isMax] of counts) {
      if (a === b) continue;
      const t = tighter(a === undefined ? undefined : { v: a, ex: false }, b === undefined ? undefined : { v: b, ex: false }, isMax);
      const text = a === undefined ? `${word} ${b} added` : b === undefined ? `${word} ${a} removed` : `${word} changed from ${a} to ${b}`;
      if (t > 0) addAt(`${rule}-${isMax ? 'decreased' : 'increased'}`, req ? 'error' : 'info', text, word);
      else addAt(`${rule}-${isMax ? 'increased' : 'decreased'}`, 'info', text, word);
    }

    // multipleOf: several (from allOf members) all apply, which for whole numbers is their
    // least common multiple.
    const divides = (big: number, step: number) => {
      const q = big / step;
      return Math.abs(q - Math.round(q)) < 1e-9;
    };
    const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
    const lcm = (l: number[]) => (l.length && l.every(Number.isInteger) ? l.reduce((x, y) => (x / gcd(x, y)) * y, 1) : undefined);
    const stepKey = (l: number[]) => (lcm(l) !== undefined ? String(lcm(l)) : [...l].sort((x, y) => x - y).join(','));
    if (stepKey(O.multiples) !== stepKey(W.multiples)) {
      const a = O.multiples;
      const b = W.multiples;
      // Every value allowed before still is when each new step divides the old one.
      const la = lcm(a);
      const lb = lcm(b);
      const kept = !b.length || (!!a.length && (la !== undefined && lb !== undefined ? divides(la, lb) : b.every((y) => a.some((x) => divides(x, y)))));
      const show = (l: number[]) => l.join(' and ');
      const text = !a.length ? `multipleOf ${show(b)} added` : !b.length ? `multipleOf ${show(a)} removed` : `multipleOf changed from ${show(a)} to ${show(b)}`;
      addAt('multiple-of-changed', req && !kept ? 'error' : 'info', text, 'multipleOf');
    }

    if (O.uniqueItems !== W.uniqueItems) {
      if (W.uniqueItems) addAt('unique-items-added', req ? 'error' : 'info', 'items must now be unique', 'uniqueItems');
      else addAt('unique-items-removed', 'info', 'items no longer have to be unique', 'uniqueItems');
    }

    // Patterns: a value must match every one in effect (allOf members each add theirs).
    const goneP = O.patterns.filter((x) => !W.patterns.includes(x));
    const freshP = W.patterns.filter((x) => !O.patterns.includes(x));
    if (goneP.length === 1 && freshP.length === 1) addAt('pattern-changed', req ? 'warning' : 'info', `pattern changed from ${code(goneP[0])} to ${code(freshP[0])}`, 'pattern');
    else {
      for (const x of freshP) addAt('pattern-added', req ? 'warning' : 'info', `pattern ${code(x)} added`, 'pattern');
      for (const x of goneP) addAt('pattern-removed', 'info', `pattern ${code(x)} removed`, 'pattern');
    }

    if (req && O.hasDefault && W.hasDefault && JSON.stringify(O.default) !== JSON.stringify(W.default))
      addAt('default-changed', 'warning', `default changed from ${code(O.default)} to ${code(W.default)}`, 'default');

    // Properties. readOnly ones are never sent; writeOnly ones are never returned.
    const hidden = (spec: Spec, p: N | undefined) => this.flag(spec, p, req ? 'readOnly' : 'writeOnly');
    const at = (r: Raw, name: string): Raw => ({ ...r, rel: [name] });
    for (const [name, op] of O.props) {
      const np = W.props.get(name);
      if (hidden(this.oldSpec, op)) {
        if (np && !hidden(this.newSpec, np) && req && W.required.has(name)) {
          out.push(at({ rule: 'added-required', level: 'error', rel: [], text: 'is no longer read-only and is required', o: op, n: np }, name));
        }
        continue;
      }
      if (!np) {
        // A request object that rejects unlisted properties now rejects this one.
        const closed = req && W.additional === 'closed';
        const level: Level = req ? (closed ? 'error' : 'warning') : O.required.has(name) ? 'error' : 'warning';
        const text = closed ? 'was removed (unlisted properties are rejected)' : O.required.has(name) && !req ? 'was removed (it was required)' : 'was removed';
        out.push(at({ rule: 'removed', level, rel: [], text, o: op, n: W.propsAt ?? nd }, name));
        continue;
      }
      if (hidden(this.newSpec, np)) {
        if (req) out.push(at({ rule: 'became-read-only', level: 'warning', rel: [], text: 'became read-only: requests can no longer set it', o: op, n: np }, name));
        else out.push(at({ rule: 'became-write-only', level: 'error', rel: [], text: 'became write-only: responses no longer include it', o: op, n: np }, name));
        continue;
      }
      const oReq = O.required.has(name);
      const nReq = W.required.has(name);
      if (oReq !== nReq) {
        if (nReq) out.push(at({ rule: 'became-required', level: req ? 'error' : 'info', rel: [], text: 'became required', o: op, n: np }, name));
        else out.push(at({ rule: 'became-optional', level: req ? 'info' : 'error', rel: [], text: req ? 'became optional' : 'became optional: it may be left out', o: op, n: np }, name));
      }
      if (!this.flag(this.oldSpec, op, 'deprecated') && this.flag(this.newSpec, np, 'deprecated'))
        out.push(at({ rule: 'deprecated', level: 'info', rel: [], text: 'was marked deprecated', o: op, n: np }, name));
      sub(op, np, name);
    }
    for (const [name, np] of W.props) {
      if (O.props.has(name) || hidden(this.newSpec, np)) continue;
      const required = req && W.required.has(name);
      out.push(at({ rule: required ? 'added-required' : 'added', level: required ? 'error' : 'info', rel: [], text: required ? 'was added as required' : 'was added', o: O.propsAt ?? od, n: np }, name));
    }

    // additionalProperties.
    const objectish = (v: View) => !v.types || v.types.has('object');
    if (objectish(O) && objectish(W)) {
      const oa = O.additional;
      const na = W.additional;
      if (req && oa !== 'closed' && na !== 'open' && !(typeof oa === 'object' && typeof na === 'object'))
        add('additional-properties-restricted', na === 'closed' ? 'error' : 'warning', na === 'closed' ? 'no longer accepts properties that are not listed' : 'unlisted properties must now match a schema', od, kw(nd, 'additionalProperties'));
      if (!req && oa === 'closed' && na !== 'closed') add('additional-properties-allowed', 'warning', 'may now contain properties that are not listed', kw(od, 'additionalProperties'), kw(nd, 'additionalProperties'));
      if (typeof oa === 'object' && typeof na === 'object') sub(oa, na, '*');
    }

    if (O.items && W.items) sub(O.items, W.items, '[]');

    // discriminator: which property tells the options apart, and which value means which.
    const od_ = O.discriminator;
    const nd_ = W.discriminator;
    if (od_ && nd_) {
      if (od_.prop !== nd_.prop)
        add('discriminator-property-changed', 'error', `discriminator property changed from ${code(od_.prop)} to ${code(nd_.prop)}`, od_.node, nd_.node);
      else {
        // The values each side accepts: the mapping, plus the schema name of every option
        // the mapping doesn't cover.
        const values = (v: View, d: NonNullable<View['discriminator']>) => {
          const m = new Map<string, { target: string; at: N }>();
          const mapNode = child(d.node, 'mapping');
          for (const [k, t] of d.mapping) m.set(k, { target: refName(t), at: own(mapNode.v, k) !== undefined ? child(mapNode, k) : d.node });
          const covered = new Set([...d.mapping.values()].map(refName));
          for (const opt of v.oneOf ?? v.anyOf ?? []) {
            const ref = own(opt.v, '$ref');
            if (typeof ref !== 'string' || covered.has(refName(ref)) || m.has(refName(ref))) continue;
            m.set(refName(ref), { target: refName(ref), at: opt });
          }
          return m;
        };
        const ov = values(O, od_);
        const nv = values(W, nd_);
        if (ov.size && nv.size) {
          for (const [k, t] of ov) {
            const u = nv.get(k);
            if (!u) add('discriminator-mapping-removed', req ? 'error' : 'info', `discriminator value ${code(k)} removed`, t.at, nd_.node);
            else if (u.target !== t.target) add('discriminator-mapping-changed', 'warning', `discriminator value ${code(k)} now means ${code(u.target)} instead of ${code(t.target)}`, t.at, u.at);
          }
          for (const [k, u] of nv) if (!ov.has(k)) add('discriminator-mapping-added', req ? 'info' : 'warning', `discriminator value ${code(k)} added`, od_.node, u.at);
        }
      }
    }

    // oneOf / anyOf options: matched by the schema they reference, their title, their
    // discriminator value, and then by what they look like. Never by position.
    for (const kind of ['oneOf', 'anyOf'] as const) {
      const oo = O[kind];
      const no = W[kind];
      if (!oo || !no) continue;
      const { pairs, removed, added } = this.matchOptions(oo, no, od_, nd_);
      for (const [a, b, label] of pairs) sub(a, b, `(${label})`);
      for (const [m, label] of removed) add('subschema-removed', req ? 'error' : 'info', `${kind} option ${code(label)} removed`, m, child(nd, kind));
      for (const [m, label] of added) add('subschema-added', req ? 'info' : 'warning', `${kind} option ${code(label)} added`, child(od, kind), m);
    }
    return out;
  }
}
