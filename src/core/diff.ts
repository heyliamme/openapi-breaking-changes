import { kindId, ROOT_DIR, type Dir, type Kind, type Level, type SchemaRoot } from './rules';
import { codeSpan } from './md';
import { jaccard, SchemaDiff, type Raw } from './schema';
import { child, deref, isObj, keysOf, locate, own, PLACED, type Loc, type N, type Spec } from './spec';

export interface Change {
  /** Stable id, such as `response-property-removed`. */
  id: string;
  level: Level;
  message: string;
  /** Upper-case method and the path as written in the new spec (old, when removed). */
  method?: string;
  path?: string;
  /** The change is to the webhook named `path` (OpenAPI 3.1 `webhooks`), not to a path. */
  webhook?: boolean;
  /** For `endpoint-moved`: the method and path the operation had before. */
  movedFrom?: { method: string; path: string };
  old?: Loc;
  new?: Loc;
  /** Set by ignore rules: the reason, or "" when none was given. */
  ignored?: string;
}

/**
 * How hard to look for operations that moved to another path. `operationId`: only when the
 * same operationId is on both; `similar` (the default): also an operation that takes and
 * returns nearly the same things; `off`: a moved operation is a removed one and an added one.
 */
export type RenameDetection = 'off' | 'operationId' | 'similar';

export interface CompareOptions {
  renames?: RenameDetection;
}

/** How alike two operations must be (0–1) to be taken as one that moved. */
export const MOVE_THRESHOLD = 0.75;

/** Above this many removed × added operations of one method, moves are found by operationId only. */
export const MAX_MOVE_PAIRS = 1_000_000;

/** `query` is OpenAPI 3.2's. */
export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];

const code = codeSpan;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const rank = (m: string) => {
  const i = METHODS.indexOf(m.toLowerCase());
  return i < 0 ? METHODS.length : i;
};

interface Item {
  path: string;
  node: N;
}

interface Op {
  item: Item;
  node: N;
  /** Upper case: `GET`, or a 3.2 `additionalOperations` name. */
  method: string;
}

/** A callback or webhook: the API sends the request, the client answers. */
interface Ctx {
  kind?: Kind;
  /** Put before every message: "Callback `onEvent` (POST `{$request.body#/url}`)". */
  label?: string;
}

/** `/pets/{petId}` and `/pets/{id}` are the same endpoint. */
export const pathKey = (p: string) => p.replace(/\{[^}/]*\}/g, '{}');

interface Param {
  key: string;
  name: string;
  in: string;
  node: N;
}

interface Media {
  node: N;
  schema?: N;
  /** OpenAPI 3.2: the schema of each item of a streamed body. */
  itemSchema?: N;
}

interface Body {
  node: N;
  required: boolean;
  media: Map<string, Media>;
}

interface Header {
  name: string;
  node: N;
  required: boolean;
  schema?: N;
}

interface Response {
  node: N;
  media: Map<string, Media>;
  headers: Map<string, Header>;
}

/** How a schema is named in messages. */
interface Where {
  root: SchemaRoot;
  /** "query parameter `limit`", "request body", "200 response", "`X-Rate-Limit` header of the 200 response". */
  label: string;
}

function relText(rel: string[]): string {
  let s = '';
  for (const seg of rel) {
    if (seg === '[]' || seg.startsWith('(')) s += seg;
    else s += (s ? '.' : '') + seg;
  }
  return s;
}

export class Comparison {
  readonly changes: Change[] = [];
  /** What the comparison left out, for people. */
  readonly notes: string[] = [];
  private schemas: SchemaDiff;
  private endpoint: Pick<Change, 'method' | 'path' | 'webhook' | 'movedFrom'> = {};
  private ctx: Ctx = {};
  private seen = new Set<string>();
  /** Security schemes renamed with nothing else changed: the name never goes on the wire. */
  private renamedSchemes = new Map<string, string>();

  constructor(
    private o: Spec,
    private n: Spec,
    private options: CompareOptions = {},
  ) {
    this.schemas = new SchemaDiff(o, n);
  }

  private root = (s: Spec): N => ({ v: s.main.root, doc: s.main });

  /** The level of an operation rule: as written, or the other one inside a callback or webhook. */
  private lv(normal: Level, reversed: Level): Level {
    return this.ctx.kind ? reversed : normal;
  }

  private emit(id: string, level: Level, message: string, o?: N, n?: N) {
    const old = o ? locate(o) : undefined;
    const nw = n ? locate(n) : undefined;
    const fullId = kindId(id, this.ctx.kind);
    const msg = this.ctx.label ? `${this.ctx.label}: ${low(message)}` : message;
    const key = `${fullId}|${this.endpoint.method}|${this.endpoint.path}|${this.endpoint.webhook ? 'w' : ''}|${msg}|${old?.file}${old?.pointer}|${nw?.file}${nw?.pointer}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const c: Change = { id: fullId, level, message: msg, ...this.endpoint, old, new: nw };
    if (!c.webhook) delete c.webhook;
    if (!c.movedFrom) delete c.movedFrom;
    this.changes.push(c);
  }

  run(): Change[] {
    this.renamedSchemes = this.schemeRenames();
    this.general();
    this.paths();
    this.webhooks();
    return this.changes;
  }

  // --- whole API -----------------------------------------------------------------------

  private general() {
    const or = this.root(this.o);
    const nr = this.root(this.n);
    const ov = own(own(or.v, 'info'), 'version');
    const nv = own(own(nr.v, 'info'), 'version');
    if (ov !== undefined && nv !== undefined && String(ov) !== String(nv))
      this.emit('api-version-changed', 'info', `API version changed from ${code(ov)} to ${code(nv)}`, child(child(or, 'info'), 'version'), child(child(nr, 'info'), 'version'));

    const os = this.servers(this.o);
    const ns = this.servers(this.n);
    for (const [url, node] of os) if (!ns.has(url)) this.emit('server-removed', 'info', `Server ${code(url)} removed`, node, ns.values().next().value ?? nr);
    for (const [url, node] of ns) if (!os.has(url)) this.emit('server-added', 'info', `Server ${code(url)} added`, os.values().next().value ?? or, node);

    const oschemes = this.securitySchemes(this.o);
    const nschemes = this.securitySchemes(this.n);
    for (const [name, on] of oschemes) {
      const nn = nschemes.get(name);
      if (!nn) continue; // its uses are reported per operation
      const ov_ = asV3Scheme(on.v);
      const nv_ = asV3Scheme(nn.v);
      const changed = ['type', 'in', 'name', 'scheme'].filter((k) => own(ov_, k) !== undefined && own(nv_, k) !== undefined && String(own(ov_, k)).toLowerCase() !== String(own(nv_, k)).toLowerCase());
      const at = (n: N, k: string) => (own(n.v, k) !== undefined ? child(n, k) : n);
      for (const k of changed) this.emit('security-scheme-changed', 'error', `Security scheme ${code(name)}: ${k} changed from ${code(own(ov_, k))} to ${code(own(nv_, k))}`, at(on, k), at(nn, k));
      if (own(on.v, 'deprecated') !== true && own(nn.v, 'deprecated') === true) this.emit('security-scheme-deprecated', 'info', `Security scheme ${code(name)} deprecated`, on, child(nn, 'deprecated'));
    }
  }

  private servers(s: Spec): Map<string, N> {
    const r = this.root(s);
    const out = new Map<string, N>();
    if (s.version === '2.0') {
      const host = own(r.v, 'host');
      const written = own(r.v, 'basePath');
      if (typeof host !== 'string' && typeof written !== 'string') return out;
      const base = typeof written === 'string' ? written : '';
      const schemes = Array.isArray(own(r.v, 'schemes')) ? (own(r.v, 'schemes') as unknown[]).map(String) : [''];
      const node = typeof host === 'string' ? child(r, 'host') : child(r, 'basePath');
      for (const sc of schemes) out.set(`${sc ? sc + '://' : host ? '//' : ''}${host ?? ''}${base}`.replace(/\/$/, ''), node);
      return out;
    }
    const list = child(r, 'servers');
    if (!Array.isArray(list.v)) return out;
    list.v.forEach((sv: unknown, i: number) => {
      const url = own(sv, 'url');
      if (typeof url === 'string') out.set(url.replace(/\/$/, '') || '/', child(child(list, String(i)), 'url'));
    });
    return out;
  }

  /** Old scheme name → new name, for a scheme only found under another name with the same definition. */
  private schemeRenames(): Map<string, string> {
    const out = new Map<string, string>();
    const os = this.securitySchemes(this.o);
    const ns = this.securitySchemes(this.n);
    const sig = (n: N) => canonical(asV3Scheme(n.v));
    const gone = [...os].filter(([k]) => !ns.has(k)).map(([k, n]) => [k, sig(n)] as const);
    const fresh = [...ns].filter(([k]) => !os.has(k)).map(([k, n]) => [k, sig(n)] as const);
    for (const [k, g] of gone) {
      const to = fresh.filter(([, f]) => f === g);
      if (to.length === 1 && gone.filter(([, x]) => x === g).length === 1) out.set(k, to[0][0]);
    }
    return out;
  }

  private securitySchemes(s: Spec): Map<string, N> {
    const r = this.root(s);
    const holder = s.version === '2.0' ? child(r, 'securityDefinitions') : child(child(r, 'components'), 'securitySchemes');
    const out = new Map<string, N>();
    for (const k of keysOf(holder)) {
      const d = deref(s, child(holder, k));
      if (d && isObj(d.v)) out.set(k, d);
    }
    return out;
  }

  // --- paths and operations ------------------------------------------------------------

  private pathItems(s: Spec): Map<string, Item> {
    const paths = child(this.root(s), 'paths');
    const out = new Map<string, Item>();
    for (const p of keysOf(paths)) {
      if (!p.startsWith('/')) continue; // x- extensions
      const node = deref(s, child(paths, p));
      if (node && isObj(node.v)) out.set(pathKey(p), { path: p, node });
    }
    return out;
  }

  /** The operations of a path item: the usual methods, then OpenAPI 3.2 `additionalOperations`. */
  private operationsOf(item: Item): Op[] {
    const out: Op[] = [];
    for (const m of METHODS) if (isObj(own(item.node.v, m))) out.push({ item, node: child(item.node, m), method: m.toUpperCase() });
    const extra = child(item.node, 'additionalOperations');
    for (const m of keysOf(extra)) {
      if (METHODS.includes(m.toLowerCase()) || !isObj(extra.v[m])) continue;
      out.push({ item, node: child(extra, m), method: m.toUpperCase() });
    }
    return out;
  }

  private paths() {
    const op = this.pathItems(this.o);
    const np = this.pathItems(this.n);
    const keys = [...new Set([...op.keys(), ...np.keys()])];
    const oldOps = new Map<string, Op>();
    const newOps = new Map<string, Op>();
    const order: string[] = [];
    for (const k of keys) {
      const a = op.get(k);
      const b = np.get(k);
      const os = a ? this.operationsOf(a) : [];
      const ns = b ? this.operationsOf(b) : [];
      for (const x of os) oldOps.set(`${x.method} ${k}`, x);
      for (const x of ns) newOps.set(`${x.method} ${k}`, x);
      const methods = [...new Set([...os, ...ns].map((x) => x.method))];
      methods.sort((x, y) => rank(x) - rank(y));
      for (const m of methods) order.push(`${m} ${k}`);
    }
    const removed = [...oldOps].filter(([k]) => !newOps.has(k)).map(([, x]) => x);
    const added = [...newOps].filter(([k]) => !oldOps.has(k)).map(([, x]) => x);
    const moves = this.findMoves(removed, added);
    const movedFrom = new Set([...moves.values()].map((m) => m.from));
    for (const k of order) {
      const ao = oldOps.get(k);
      const bo = newOps.get(k);
      if (ao && bo) {
        this.endpoint = { method: bo.method, path: bo.item.path };
        this.operation(ao.item, ao.node, bo.item, bo.node);
      } else if (ao) {
        if (movedFrom.has(ao)) continue; // reported where it went
        // Named as the path is written now, when it is still there.
        const still = np.get(pathKey(ao.item.path));
        this.endpoint = { method: ao.method, path: still?.path ?? ao.item.path };
        this.removed(ao.node, still?.node ?? child(this.root(this.n), 'paths'));
      } else if (bo) {
        const move = moves.get(bo);
        if (move) {
          const from = move.from;
          this.endpoint = { method: bo.method, path: bo.item.path, movedFrom: { method: from.method, path: from.item.path } };
          const deprecated = own(from.node.v, 'deprecated') === true;
          this.emit('endpoint-moved', deprecated ? 'warning' : 'error', `Endpoint moved: ${code(`${from.method} ${from.item.path}`)} is now ${code(`${bo.method} ${bo.item.path}`)} (${move.why})`, from.node, bo.node);
          this.operation(from.item, from.node, bo.item, bo.node);
          continue;
        }
        this.endpoint = { method: bo.method, path: bo.item.path };
        this.emit('endpoint-added', 'info', 'Endpoint added', op.get(pathKey(bo.item.path))?.node ?? child(this.root(this.o), 'paths'), bo.node);
      }
    }
    this.endpoint = {};
  }

  private removed(ao: N, where: N) {
    const what = this.ctx.kind === 'webhook' ? 'Webhook' : this.ctx.kind ? '' : 'Endpoint';
    if (own(ao.v, 'deprecated') === true) this.emit('deprecated-endpoint-removed', 'warning', what ? `Deprecated ${low(what)} removed` : 'Deprecated, now removed', ao, where);
    else this.emit('endpoint-removed', 'error', what ? `${what} removed` : 'Removed: no longer sent', ao, where);
  }

  /**
   * Removed operations that reappear elsewhere: the same operationId (which must be unique
   * on both sides), else, for `similar`, the same method and nearly the same parameters,
   * body, responses and tags. Each match must be the clear best for both sides.
   */
  private findMoves(removed: Op[], added: Op[]): Map<Op, { from: Op; why: string }> {
    const out = new Map<Op, { from: Op; why: string }>();
    const mode = this.options.renames ?? 'similar';
    if (mode === 'off' || !removed.length || !added.length) return out;
    const ids = (spec: Spec) => {
      const count = new Map<string, number>();
      for (const item of this.pathItems(spec).values())
        for (const x of this.operationsOf(item)) {
          const id = own(x.node.v, 'operationId');
          if (typeof id === 'string') count.set(id, (count.get(id) ?? 0) + 1);
        }
      return count;
    };
    const oc = ids(this.o);
    const nc = ids(this.n);
    const left = new Set(removed);
    for (const b of added) {
      const id = own(b.node.v, 'operationId');
      if (typeof id !== 'string' || oc.get(id) !== 1 || nc.get(id) !== 1) continue;
      const a = [...left].find((x) => own(x.node.v, 'operationId') === id);
      if (!a) continue;
      left.delete(a);
      out.set(b, { from: a, why: `same operationId ${code(id)}` });
    }
    if (mode !== 'similar') return out;
    const right = added.filter((b) => !out.has(b));
    // Only the same method can be the same operation: compare within each method.
    const byMethod = new Map<string, { l: Op[]; r: Op[] }>();
    for (const a of left) (byMethod.get(a.method) ?? byMethod.set(a.method, { l: [], r: [] }).get(a.method)!).l.push(a);
    for (const b of right) byMethod.get(b.method)?.r.push(b);
    let pairs = 0;
    for (const { l, r } of byMethod.values()) pairs += l.length * r.length;
    if (pairs > MAX_MOVE_PAIRS) {
      this.notes.push(`${left.size} removed and ${right.length} added operations are too many to compare with each other: moved operations were matched by operationId only.`);
      return out;
    }
    const lf = new Map([...left].map((a) => [a, this.opFeatures(this.o, a)]));
    const rf = new Map(right.map((b) => [b, this.opFeatures(this.n, b)]));
    const scores: Array<{ a: Op; b: Op; s: number }> = [];
    for (const { l, r } of byMethod.values())
      for (const a of l)
        for (const b of r) {
          const { f: fa, returns: ra } = lf.get(a)!;
          const { f: fb, returns: rb } = rf.get(b)!;
          if (fa.size < 4 || fb.size < 4) continue;
          // What it returns on success must be the same: shared parameters, tags and error
          // codes alone make unrelated operations of one API look alike.
          if ((ra.size || rb.size) && ![...ra].some((x) => rb.has(x))) continue;
          // Two different operationIds say these are different operations.
          const ia = own(a.node.v, 'operationId');
          const ib = own(b.node.v, 'operationId');
          if (typeof ia === 'string' && typeof ib === 'string' && ia !== ib) continue;
          const sc = jaccard(fa, fb);
          if (sc >= MOVE_THRESHOLD - 0.1) scores.push({ a, b, s: sc });
        }
    scores.sort((p, q) => q.s - p.s);
    // Each operation's candidates, best first, to find a rival without scanning every pair.
    const byA = new Map<Op, typeof scores>();
    const byB = new Map<Op, typeof scores>();
    for (const x of scores) {
      (byA.get(x.a) ?? byA.set(x.a, []).get(x.a)!).push(x);
      (byB.get(x.b) ?? byB.set(x.b, []).get(x.b)!).push(x);
    }
    // Taken candidates stay taken: each list keeps where its first free one is.
    const start = new Map<typeof scores, number>();
    const rival = (list: typeof scores, x: (typeof scores)[number], free: (y: (typeof scores)[number]) => boolean) => {
      let i = start.get(list) ?? 0;
      while (i < list.length && !free(list[i])) i++;
      start.set(list, i);
      for (let j = i; j < list.length && list[j].s > x.s - 0.1; j++) if (list[j] !== x && free(list[j])) return list[j];
      return undefined;
    };
    for (const x of scores) {
      if (x.s < MOVE_THRESHOLD) break;
      if (out.has(x.b) || !left.has(x.a)) continue;
      // Unambiguous: no other candidate still free that is nearly as good, on either side.
      const ra = rival(byA.get(x.a)!, x, (y) => !out.has(y.b));
      const rb = rival(byB.get(x.b)!, x, (y) => left.has(y.a));
      if (ra || rb) continue;
      left.delete(x.a);
      out.set(x.b, { from: x.a, why: `no operationId to go by; ${Math.round(x.s * 100)}% of what it takes and returns is the same` });
    }
    return out;
  }

  /** What an operation is about, for telling whether two are the same one. */
  private opFeatures(s: Spec, x: Op): { f: Set<string>; returns: Set<string> } {
    const f = new Set<string>();
    const returns = new Set<string>();
    const v = x.node.v;
    const text = (t: unknown) => (typeof t === 'string' ? t.trim().toLowerCase().replace(/\s+/g, ' ') : '');
    if (text(v.summary)) f.add('summary:' + text(v.summary));
    if (text(v.description)) f.add('description:' + text(v.description).slice(0, 300));
    if (Array.isArray(v.tags)) for (const t of v.tags) f.add('tag:' + String(t));
    // The fixed parts of the path, except versions (`v1` → `v2` is the move itself).
    for (const seg of x.item.path.split('/')) if (seg && !seg.startsWith('{') && !/^v\d+([._-]\d+)*$/i.test(seg)) f.add('segment:' + seg.toLowerCase());
    const params = this.params(s, x.item, x.node);
    let pathParams = 0;
    for (const p of params.values()) {
      if (p.in === 'path') pathParams++;
      else f.add(`param:${p.in}:${p.name}`);
    }
    f.add('path-params:' + pathParams);
    const shape = (sch: N | undefined) => {
      if (!sch) return '';
      const ref = own(sch.v, '$ref');
      if (typeof ref === 'string') return 'ref:' + ref.split('/').pop();
      const d = deref(s, sch);
      if (isObj(own(d?.v, 'properties'))) return 'props:' + Object.keys(d!.v.properties).sort().join(',');
      const items = own(d?.v, 'items');
      if (typeof own(items, '$ref') === 'string') return 'items:' + items.$ref.split('/').pop();
      return 'type:' + String(own(d?.v, 'type'));
    };
    const body = this.body(s, x.node, x.item);
    if (body) for (const [t, m] of body.media) f.add(`body:${t}:${shape(m.schema)}`);
    for (const [status, r] of this.responsesOf(s, x.node)) {
      f.add('status:' + status);
      if (/^2|DEFAULT/.test(status))
        for (const [t, m] of r.media) {
          f.add(`returns:${status}:${t}:${shape(m.schema)}`);
          if (/^2/.test(status)) returns.add(shape(m.schema));
        }
    }
    return { f, returns };
  }

  // --- webhooks and callbacks --------------------------------------------------------------

  private webhooks() {
    const ow = child(this.root(this.o), 'webhooks');
    const nw = child(this.root(this.n), 'webhooks');
    const names = [...new Set([...keysOf(ow), ...keysOf(nw)])].filter((k) => !k.startsWith('x-'));
    if (!names.length) return;
    this.ctx = { kind: 'webhook' };
    for (const name of names) {
      const a = own(ow.v, name) !== undefined ? deref(this.o, child(ow, name)) : undefined;
      const b = own(nw.v, name) !== undefined ? deref(this.n, child(nw, name)) : undefined;
      const ai: Item | undefined = a && isObj(a.v) ? { path: name, node: a } : undefined;
      const bi: Item | undefined = b && isObj(b.v) ? { path: name, node: b } : undefined;
      const os = ai ? this.operationsOf(ai) : [];
      const ns = bi ? this.operationsOf(bi) : [];
      for (const m of [...new Set([...os, ...ns].map((x) => x.method))].sort((x, y) => rank(x) - rank(y))) {
        const ao = os.find((x) => x.method === m);
        const bo = ns.find((x) => x.method === m);
        this.endpoint = { method: m, path: name, webhook: true };
        if (ao && bo) this.operation(ao.item, ao.node, bo.item, bo.node);
        else if (ao) this.removed(ao.node, bi?.node ?? (nw.v === undefined ? this.root(this.n) : nw));
        else if (bo) this.emit('endpoint-added', 'info', 'Webhook added', ai?.node ?? (ow.v === undefined ? this.root(this.o) : ow), bo.node);
      }
    }
    this.ctx = {};
    this.endpoint = {};
  }

  /** Callbacks of an operation, by name, then by the expression that gives their URL. */
  private callbacks(ao: N, bo: N) {
    const oc = child(ao, 'callbacks');
    const nc = child(bo, 'callbacks');
    const names = [...new Set([...keysOf(oc), ...keysOf(nc)])].filter((k) => !k.startsWith('x-'));
    if (!names.length) return;
    const outer = this.ctx;
    const items = (s: Spec, n: N | undefined) => {
      const out = new Map<string, Item>();
      if (!n) return out;
      for (const expr of keysOf(n)) {
        if (expr.startsWith('x-')) continue;
        const it = deref(s, child(n, expr));
        if (it && isObj(it.v)) out.set(expr, { path: expr, node: it });
      }
      return out;
    };
    for (const name of names) {
      const a = own(oc.v, name) !== undefined ? deref(this.o, child(oc, name)) : undefined;
      const b = own(nc.v, name) !== undefined ? deref(this.n, child(nc, name)) : undefined;
      const ae = items(this.o, a);
      const be = items(this.n, b);
      const pairs: Array<[Item | undefined, Item | undefined]> = [];
      if (ae.size === 1 && be.size === 1 && ![...ae.keys()].every((k) => be.has(k))) {
        const [x] = ae.values();
        const [y] = be.values();
        this.ctx = outer;
        this.emit('callback-url-changed', 'error', `Callback ${code(name)}: its URL is now taken from ${code(y.path)} instead of ${code(x.path)}`, x.node, y.node);
        pairs.push([x, y]);
      } else for (const e of new Set([...ae.keys(), ...be.keys()])) pairs.push([ae.get(e), be.get(e)]);
      for (const [x, y] of pairs) {
        const os = x ? this.operationsOf(x) : [];
        const ns = y ? this.operationsOf(y) : [];
        for (const m of [...new Set([...os, ...ns].map((q) => q.method))].sort((p, q) => rank(p) - rank(q))) {
          const p = os.find((q) => q.method === m);
          const q = ns.find((r) => r.method === m);
          this.ctx = { kind: 'callback', label: `Callback ${code(name)} (${m} ${code((y ?? x)!.path)})` };
          if (p && q) this.operation(p.item, p.node, q.item, q.node);
          else if (p) this.removed(p.node, y?.node ?? b ?? (nc.v === undefined ? bo : nc));
          else if (q) this.emit('endpoint-added', 'info', 'Added', x?.node ?? a ?? (oc.v === undefined ? ao : oc), q.node);
        }
      }
    }
    this.ctx = outer;
  }

  private operation(a: Item, ao: N, b: Item, bo: N) {
    const od = own(ao.v, 'deprecated') === true;
    const nd = own(bo.v, 'deprecated') === true;
    const what = this.ctx.kind === 'webhook' ? 'Webhook' : this.ctx.kind ? '' : 'Endpoint';
    if (!od && nd) this.emit('endpoint-deprecated', 'info', what ? `${what} deprecated` : 'Deprecated', ao, child(bo, 'deprecated'));
    if (od && !nd) this.emit('endpoint-reactivated', 'info', what ? `${what} no longer deprecated` : 'No longer deprecated', child(ao, 'deprecated'), bo);

    const oid = own(ao.v, 'operationId');
    const nid = own(bo.v, 'operationId');
    if (typeof oid === 'string' && oid !== nid)
      this.emit('operation-id-changed', this.lv('warning', 'info'), nid === undefined ? `operationId ${code(oid)} removed` : `operationId changed from ${code(oid)} to ${code(nid)}`, child(ao, 'operationId'), nid === undefined ? bo : child(bo, 'operationId'));

    this.parameters(a, ao, b, bo);
    this.requestBody(a, ao, b, bo);
    this.responses(ao, bo);
    if (this.ctx.kind) return; // the rest is about calls clients make
    this.operationServers(a, ao, b, bo);
    this.security(ao, bo);
    this.callbacks(ao, bo);
  }

  /** Servers an operation or its path declares for itself (OpenAPI 3). */
  private operationServers(a: Item, ao: N, b: Item, bo: N) {
    const ownList = (s: Spec, item: Item, op: N) => {
      if (s.version === '2.0') return undefined;
      const list = Array.isArray(own(op.v, 'servers')) ? child(op, 'servers') : Array.isArray(own(item.node.v, 'servers')) ? child(item.node, 'servers') : undefined;
      if (!list) return undefined;
      const out = new Map<string, N>();
      (list.v as unknown[]).forEach((sv, i) => {
        const url = own(sv, 'url');
        if (typeof url === 'string') out.set(url.replace(/\/$/, '') || '/', child(child(list, String(i)), 'url'));
      });
      return out;
    };
    const x = ownList(this.o, a, ao);
    const y = ownList(this.n, b, bo);
    if (!x && !y) return;
    const os = x ?? this.servers(this.o);
    const ns = y ?? this.servers(this.n);
    for (const [url, node] of os) if (!ns.has(url)) this.emit('endpoint-server-removed', 'warning', `Server ${code(url)} removed for this operation`, node, ns.values().next().value ?? bo);
    for (const [url, node] of ns) if (!os.has(url)) this.emit('endpoint-server-added', 'info', `Server ${code(url)} added for this operation`, os.values().next().value ?? ao, node);
  }

  // --- parameters ----------------------------------------------------------------------

  private params(s: Spec, item: Item, op: N): Map<string, Param> {
    const out = new Map<string, Param>();
    const template = [...item.path.matchAll(/\{([^}/]*)\}/g)].map((m) => m[1]);
    const add = (list: N) => {
      if (!Array.isArray(list.v)) return;
      list.v.forEach((_: unknown, i: number) => {
        const p = deref(s, child(list, String(i)));
        const name = own(p?.v, 'name');
        const where = own(p?.v, 'in');
        // Swagger 2.0 body and form parameters are the request body.
        if (!p || typeof name !== 'string' || typeof where !== 'string' || where === 'body' || (where === 'formData' && s.version === '2.0')) return;
        // Path parameters are matched by position, so renaming {id} to {petId} isn't a change.
        const idx = where === 'path' ? template.indexOf(name) : -1;
        const key = where === 'path' && idx >= 0 ? `path#${idx}` : `${where}:${where === 'header' ? name.toLowerCase() : name}`;
        out.set(key, { key, name, in: where, node: p });
      });
    };
    add(child(item.node, 'parameters'));
    add(child(op, 'parameters')); // operation-level ones override path-level ones
    return out;
  }

  private paramSchema(s: Spec, p: N): N | undefined {
    if (s.version === '2.0') return p; // type, format, enum… sit on the parameter itself
    if (own(p.v, 'schema') !== undefined) return child(p, 'schema');
    const content = child(p, 'content');
    const first = keysOf(content)[0];
    return first ? child(child(content, first), 'schema') : undefined;
  }

  private parameters(a: Item, ao: N, b: Item, bo: N) {
    const op = this.params(this.o, a, ao);
    const np = this.params(this.n, b, bo);
    const label = (p: Param) => `${p.in} parameter ${code(p.name)}`;
    const required = (p: Param) => p.in === 'path' || own(p.node.v, 'required') === true;
    const moved = new Set<string>();
    for (const [k, p] of op) {
      const q = np.get(k);
      if (q) {
        this.parameter(p, q, label(q), required);
        continue;
      }
      const elsewhere = [...np.values()].find((x) => x.name.toLowerCase() === p.name.toLowerCase() && x.in !== p.in && !op.has(x.key));
      if (elsewhere) {
        moved.add(elsewhere.key);
        this.emit('request-parameter-location-changed', 'error', `Parameter ${code(p.name)} moved from ${p.in} to ${elsewhere.in}`, p.node, elsewhere.node);
        continue;
      }
      this.emit('request-parameter-removed', this.lv('warning', required(p) ? 'error' : 'warning'), `${cap(label(p))} removed`, p.node, child(bo, 'parameters').v ? child(bo, 'parameters') : bo);
    }
    for (const [k, q] of np) {
      if (op.has(k) || moved.has(k)) continue;
      if (required(q)) this.emit('request-parameter-added-required', this.lv('error', 'info'), `Required ${label(q)} added`, child(ao, 'parameters').v ? child(ao, 'parameters') : ao, q.node);
      else this.emit('request-parameter-added', 'info', `Optional ${label(q)} added`, child(ao, 'parameters').v ? child(ao, 'parameters') : ao, q.node);
    }
  }

  private parameter(p: Param, q: Param, label: string, required: (p: Param) => boolean) {
    const or = required(p);
    const nr = required(q);
    if (!or && nr) this.emit('request-parameter-became-required', this.lv('error', 'info'), `${cap(label)} became required`, p.node, q.node);
    if (or && !nr) this.emit('request-parameter-became-optional', this.lv('info', 'error'), `${cap(label)} became optional`, p.node, q.node);
    if (own(p.node.v, 'deprecated') !== true && own(q.node.v, 'deprecated') === true) this.emit('request-parameter-deprecated', 'info', `${cap(label)} deprecated`, p.node, q.node);
    const style = (x: Param, s: Spec) => {
      if (s.version === '2.0') return [own(x.node.v, 'collectionFormat') ?? 'csv', ''];
      const st = own(x.node.v, 'style') ?? ({ query: 'form', cookie: 'form', path: 'simple', header: 'simple' } as Record<string, string>)[x.in];
      const ex = own(x.node.v, 'explode') ?? st === 'form';
      return [st, String(ex)];
    };
    const [os, oe] = style(p, this.o);
    const [ns, ne] = style(q, this.n);
    // Only within the same spec version: 2.0 collectionFormat doesn't map one to one.
    if (this.o.version === '2.0' === (this.n.version === '2.0') && (os !== ns || oe !== ne))
      this.emit('request-parameter-serialization-changed', 'warning', `${cap(label)}: serialization changed from ${code(os)}${oe ? ` (explode ${oe})` : ''} to ${code(ns)}${ne ? ` (explode ${ne})` : ''}`, p.node, q.node);
    this.schema(this.paramSchema(this.o, p.node), this.paramSchema(this.n, q.node), { root: 'request-parameter', label });
  }

  // --- schemas ---------------------------------------------------------------------------

  private schema(o: N | undefined, n: N | undefined, where: Where) {
    if (!o || !n) return;
    const at: Dir = ROOT_DIR[where.root];
    // In a callback or webhook the API writes the request and reads the response.
    const judged: Dir = this.ctx.kind ? (at === 'request' ? 'response' : 'request') : at;
    for (const r of this.schemas.diff(o, n, judged)) this.emitRaw(r, where, at);
  }

  private emitRaw(r: Raw, where: Where, dir: Dir) {
    const isProp = r.rel.some((s) => s !== '[]' && !s.startsWith('('));
    const id = isProp ? `${dir}-property-${r.rule}` : `${where.root}-${r.rule}`;
    const path = relText(r.rel);
    let msg: string;
    if (isProp && where.label === 'payload') msg = `Payload property ${code(path)} ${r.text}`;
    else if (isProp) msg = `${cap(dir)} property ${code(path)} ${r.text}${where.root === 'request-body' || where.root === 'response-body' ? ` (${where.label})` : ` (in ${where.label})`}`;
    // Outside a code span: option titles from the spec lose what would start Markdown.
    else if (path) msg = `${cap(where.label)}, ${path.startsWith('[]') ? 'items' : path.replace(/[`[\]<>!@\r\n]/g, '')}: ${r.text}`;
    else msg = `${cap(where.label)}: ${r.text}`;
    this.emit(id, r.level, msg, r.o, r.n);
  }

  // --- request body ----------------------------------------------------------------------

  private body(s: Spec, op: N, item?: Item): Body | undefined {
    if (s.version === '2.0') {
      const params = child(op, 'parameters');
      if (Array.isArray(params.v)) {
        for (let i = 0; i < params.v.length; i++) {
          const p = deref(s, child(params, String(i)));
          if (own(p?.v, 'in') !== 'body') continue;
          const media = new Map<string, Media>();
          for (const [t, node] of this.mediaTypes2(s, op, 'consumes')) media.set(t, { node, schema: child(p!, 'schema') });
          return { node: p!, required: own(p!.v, 'required') === true, media };
        }
      }
      return this.formBody(s, op, item);
    }
    const rb = deref(s, child(op, 'requestBody'));
    if (!rb || !isObj(rb.v)) return undefined;
    return { node: rb, required: own(rb.v, 'required') === true, media: this.content(rb) };
  }

  /**
   * Swagger 2.0 `formData` parameters, as the request body OpenAPI 3 writes for them: an
   * object with a property per parameter, sent as a form.
   */
  private formBody(s: Spec, op: N, item?: Item): Body | undefined {
    const fields = new Map<string, N>();
    for (const list of [item ? child(item.node, 'parameters') : undefined, child(op, 'parameters')]) {
      if (!list || !Array.isArray(list.v)) continue;
      list.v.forEach((_: unknown, i: number) => {
        const p = deref(s, child(list, String(i)));
        const name = own(p?.v, 'name');
        if (own(p?.v, 'in') === 'formData' && typeof name === 'string') fields.set(name, p!);
      });
    }
    if (!fields.size) return undefined;
    const properties: Record<string, unknown> = {};
    const placed = new Map<string, N>();
    const required: string[] = [];
    for (const [name, p] of fields) {
      // `type: file` is OpenAPI 3's binary string.
      const v = own(p.v, 'type') === 'file' ? { ...p.v, type: 'string', format: 'binary' } : p.v;
      properties[name] = v;
      placed.set(name, { ...p, v });
      if (own(p.v, 'required') === true) required.push(name);
    }
    PLACED.set(properties, placed);
    const params = child(op, 'parameters');
    const schema: N = { v: { type: 'object', required, properties }, doc: params.doc, parent: params.parent, key: params.key };
    const media = new Map<string, Media>();
    for (const [t, node] of this.mediaTypes2(s, op, 'consumes')) if (/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(t)) media.set(t, { node, schema });
    if (!media.size) media.set('application/x-www-form-urlencoded', { node: params, schema });
    // A form is always sent, if only empty.
    return { node: params.v ? params : op, required: true, media };
  }

  /** 2.0 `consumes` / `produces`, from the operation or the root, as media type → node. */
  private mediaTypes2(s: Spec, op: N, key: 'consumes' | 'produces'): Map<string, N> {
    const holder = Array.isArray(own(op.v, key)) ? child(op, key) : Array.isArray(own(s.main.root, key)) ? child(this.root(s), key) : undefined;
    const out = new Map<string, N>();
    if (!holder) {
      out.set('application/json', op);
      return out;
    }
    (holder.v as unknown[]).forEach((t, i) => typeof t === 'string' && out.set(t, child(holder, String(i))));
    return out;
  }

  private content(n: N): Map<string, Media> {
    const content = child(n, 'content');
    const out = new Map<string, Media>();
    for (const t of keysOf(content)) {
      const m = child(content, t);
      out.set(t, { node: m, schema: own(m.v, 'schema') !== undefined ? child(m, 'schema') : undefined, itemSchema: own(m.v, 'itemSchema') !== undefined ? child(m, 'itemSchema') : undefined });
    }
    return out;
  }

  /**
   * Pairs media types: exact names first, then `application/json` with
   * `application/json; charset=utf-8`, then what is left with a media range that covers it
   * (`*\/*`, `application/*`). `ranges` are the pairs where one side is a range wider than
   * the other: `wider` says which.
   */
  private pairMedia(o: Map<string, Media>, n: Map<string, Media>) {
    const pairs: Array<[string, Media, Media]> = [];
    const ranges: Array<{ ot: string; nt: string; om: Media; nm: Media; wider: 'old' | 'new' }> = [];
    const usedOld = new Set<string>();
    const used = new Set<string>();
    const essence = (t: string) => t.split(';')[0].trim().toLowerCase();
    for (const [t, m] of o) {
      if (n.has(t)) {
        pairs.push([t, m, n.get(t)!]);
        used.add(t);
        usedOld.add(t);
      }
    }
    for (const [t, m] of o) {
      if (n.has(t)) continue;
      const alt = [...n.keys()].find((x) => !used.has(x) && !o.has(x) && essence(x) === essence(t));
      if (alt) {
        pairs.push([t, m, n.get(alt)!]);
        used.add(alt);
        usedOld.add(t);
      }
    }
    // `*/*` covers every type, `image/*` every image type.
    const covers = (range: string, t: string) => {
      const r = essence(range);
      const x = essence(t);
      return r !== x && (r === '*/*' || (r.endsWith('/*') && x.startsWith(r.slice(0, -1))));
    };
    const leftOld = [...o].filter(([t]) => !usedOld.has(t));
    const leftNew = [...n].filter(([t]) => !used.has(t));
    const pairedOld = new Set<string>();
    const pairedNew = new Set<string>();
    for (const [ot, om] of leftOld)
      for (const [nt, nm] of leftNew) {
        const wider = covers(ot, nt) ? 'old' : covers(nt, ot) ? 'new' : undefined;
        if (!wider) continue;
        // A range already paired with a type of its own kind stays with it.
        if (wider === 'new' && pairedOld.has(ot)) continue;
        if (wider === 'old' && pairedNew.has(nt)) continue;
        pairs.push([ot, om, nm]);
        ranges.push({ ot, nt, om, nm, wider });
        pairedOld.add(ot);
        pairedNew.add(nt);
      }
    const onlyOld = leftOld.filter(([t]) => !pairedOld.has(t));
    const onlyNew = leftNew.filter(([t]) => !pairedNew.has(t));
    return { pairs, onlyOld, onlyNew, ranges };
  }

  /** The schemas of paired media types. Several media types often share one schema: compared once. */
  private mediaSchemas(pairs: Array<[string, Media, Media]>, root: SchemaRoot, label: string) {
    const done = new Set<string>();
    for (const [, x, y] of pairs) {
      for (const [key, suffix] of [['schema', ''], ['itemSchema', ' (each streamed item)']] as const) {
        const a = x[key];
        const b = y[key];
        if (!a || !b) continue;
        const k = `${key}|${pointerKey(deref(this.o, a) ?? a)}|${pointerKey(deref(this.n, b) ?? b)}`;
        if (done.has(k)) continue;
        done.add(k);
        this.schema(a, b, { root, label: label + suffix });
      }
    }
  }

  private requestBody(ai: Item, ao: N, bi: Item, bo: N) {
    const a = this.body(this.o, ao, ai);
    const b = this.body(this.n, bo, bi);
    if (!a && !b) return;
    if (!a) {
      if (b!.required) this.emit('request-body-added-required', this.lv('error', 'info'), 'Required request body added', ao, b!.node);
      else this.emit('request-body-added', 'info', 'Optional request body added', ao, b!.node);
      return;
    }
    if (!b) {
      this.emit('request-body-removed', this.lv('warning', 'error'), 'Request body removed', a.node, bo);
      return;
    }
    if (!a.required && b.required) this.emit('request-body-became-required', this.lv('error', 'info'), 'Request body became required', a.node, b.node);
    if (a.required && !b.required) this.emit('request-body-became-optional', this.lv('info', 'error'), 'Request body became optional', a.node, b.node);
    const { pairs, onlyOld, onlyNew, ranges } = this.pairMedia(a.media, b.media);
    for (const [t, m] of onlyOld) this.emit('request-body-media-type-removed', this.lv('error', 'info'), `Request media type ${code(t)} removed`, m.node, b.node);
    // A range that became one type: what else was sent is no longer accepted. The other way
    // round, the range still accepts what was sent.
    for (const x of ranges) if (x.wider === 'old') this.emit('request-body-media-type-removed', this.lv('error', 'info'), `Request media type ${code(x.ot)} narrowed to ${code(x.nt)}`, x.om.node, x.nm.node);
    for (const [t, m] of onlyNew) this.emit('request-body-media-type-added', this.lv('info', 'warning'), `Request media type ${code(t)} added`, a.node, m.node);
    this.mediaSchemas(pairs, 'request-body', this.ctx.kind ? 'payload' : 'request body');
  }

  // --- responses -------------------------------------------------------------------------

  private responsesOf(s: Spec, op: N): Map<string, Response> {
    const holder = child(op, 'responses');
    const out = new Map<string, Response>();
    for (const code of keysOf(holder)) {
      if (code.startsWith('x-')) continue;
      const r = deref(s, child(holder, code));
      if (!r || !isObj(r.v)) continue;
      let media: Map<string, Media>;
      if (s.version === '2.0') {
        media = new Map();
        if (own(r.v, 'schema') !== undefined) for (const [t, node] of this.mediaTypes2(s, op, 'produces')) media.set(t, { node, schema: child(r, 'schema') });
      } else media = this.content(r);
      const headers = new Map<string, Header>();
      const hs = child(r, 'headers');
      for (const h of keysOf(hs)) {
        const hn = deref(s, child(hs, h));
        if (!hn || !isObj(hn.v)) continue;
        let schema: N | undefined;
        if (s.version === '2.0') schema = hn;
        else if (own(hn.v, 'schema') !== undefined) schema = child(hn, 'schema');
        headers.set(h.toLowerCase(), { name: h, node: hn, required: own(hn.v, 'required') === true, schema });
      }
      out.set(code.toUpperCase(), { node: r, media, headers });
    }
    return out;
  }

  private responses(ao: N, bo: N) {
    const a = this.responsesOf(this.o, ao);
    const b = this.responsesOf(this.n, bo);
    const holder = (op: N) => (own(op.v, 'responses') !== undefined ? child(op, 'responses') : op);
    // `2XX` covers `200`: a code and the range that replaced it (or the other way round)
    // are the same response, compared as such.
    const range = (status: string) => (/^[1-5]\d\d$/.test(status) ? status[0] + 'XX' : undefined);
    const coveredNew = new Set<string>();
    for (const [status, r] of a) {
      const s = b.get(status);
      if (s) {
        this.response(status, r, s);
        continue;
      }
      const wide = range(status);
      const t = wide ? b.get(wide) : undefined;
      if (t && !a.has(wide!)) {
        coveredNew.add(wide!);
        this.response(status, r, t);
        continue;
      }
      // A range narrowed to the codes it had: each of them is compared with it.
      const narrowed = /^[1-5]XX$/.test(status) ? [...b.keys()].filter((k) => range(k) === status && !a.has(k)) : [];
      if (narrowed.length) {
        for (const k of narrowed) {
          coveredNew.add(k);
          this.response(k, r, b.get(k)!);
        }
        continue;
      }
      if (/^2/.test(status)) this.emit('response-success-status-removed', this.lv('error', 'warning'), `${status} response removed`, r.node, holder(bo));
      else this.emit('response-status-removed', this.lv('warning', 'info'), `${status === 'DEFAULT' ? 'Default' : status} response removed`, r.node, holder(bo));
    }
    for (const [status, s] of b) if (!a.has(status) && !coveredNew.has(status)) this.emit('response-status-added', 'info', `${status === 'DEFAULT' ? 'Default' : status} response added`, holder(ao), s.node);
  }

  /** One response, old and new: its media types, headers and links. */
  private response(status: string, r: Response, s: Response) {
    const label = status === 'DEFAULT' ? 'default response' : `${status} response`;
    const { pairs, onlyOld, onlyNew, ranges } = this.pairMedia(r.media, s.media);
    for (const [t, m] of onlyOld) this.emit('response-media-type-removed', 'error', `${cap(label)}: media type ${code(t)} removed`, m.node, s.node);
    // A type that became a range: clients may now get types they never handled.
    for (const x of ranges) if (x.wider === 'new') this.emit('response-media-type-added', 'info', `${cap(label)}: media type ${code(x.ot)} widened to ${code(x.nt)}`, x.om.node, x.nm.node);
    for (const [t, m] of onlyNew) this.emit('response-media-type-added', 'info', `${cap(label)}: media type ${code(t)} added`, r.node, m.node);
    this.mediaSchemas(pairs, 'response-body', label);
    for (const [h, x] of r.headers) {
      const y = s.headers.get(h);
      const name = y?.name ?? x.name;
      if (!y) {
        this.emit('response-header-removed', this.lv(x.required ? 'error' : 'warning', 'info'), `${cap(label)}: header ${code(name)} removed`, x.node, s.node);
        continue;
      }
      if (x.required && !y.required) this.emit('response-header-became-optional', this.lv('error', 'info'), `${cap(label)}: header ${code(name)} became optional`, x.node, y.node);
      this.schema(x.schema, y.schema, { root: 'response-header', label: `header ${code(name)} of the ${label}` });
    }
    for (const [h, y] of s.headers) if (!r.headers.has(h)) this.emit('response-header-added', 'info', `${cap(label)}: header ${code(y.name)} added`, r.node, y.node);
    if (!this.ctx.kind) this.links(r.node, s.node, label);
  }

  /** Response links: clients follow them to the next call. */
  private links(r: N, s: N, label: string) {
    const ol = child(r, 'links');
    const nl = child(s, 'links');
    for (const name of keysOf(ol)) {
      const a = deref(this.o, child(ol, name));
      const b = own(nl.v, name) !== undefined ? deref(this.n, child(nl, name)) : undefined;
      if (!a || !isObj(a.v)) continue;
      if (!b || !isObj(b.v)) {
        this.emit('response-link-removed', 'warning', `${cap(label)}: link ${code(name)} removed`, a, nl.v === undefined ? s : nl);
        continue;
      }
      const target = (x: Record<string, any>) => (typeof x.operationId === 'string' ? x.operationId : typeof x.operationRef === 'string' ? x.operationRef : undefined);
      const ot = target(a.v);
      const nt = target(b.v);
      if (ot !== nt) this.emit('response-link-changed', 'warning', `${cap(label)}: link ${code(name)} now leads to ${code(nt)} instead of ${code(ot)}`, a, b);
      else if (JSON.stringify(a.v.parameters ?? {}) !== JSON.stringify(b.v.parameters ?? {}) || JSON.stringify(a.v.requestBody) !== JSON.stringify(b.v.requestBody))
        this.emit('response-link-changed', 'warning', `${cap(label)}: link ${code(name)} passes other values to ${code(nt)}`, own(a.v, 'parameters') !== undefined ? child(a, 'parameters') : a, own(b.v, 'parameters') !== undefined ? child(b, 'parameters') : b);
    }
    for (const name of keysOf(nl)) if (own(ol.v, name) === undefined) this.emit('response-link-added', 'info', `${cap(label)}: link ${code(name)} added`, ol.v === undefined ? r : ol, child(nl, name));
  }

  // --- security ----------------------------------------------------------------------------

  private requirements(s: Spec, op: N): { node: N; anonymous: boolean; reqs: Map<string, { node: N; scopes: Map<string, string[]> }> } {
    const own_ = own(op.v, 'security');
    const node = own_ !== undefined ? child(op, 'security') : child(this.root(s), 'security');
    const reqs = new Map<string, { node: N; scopes: Map<string, string[]> }>();
    let anonymous = !Array.isArray(node.v) || node.v.length === 0;
    if (Array.isArray(node.v)) {
      node.v.forEach((r: unknown, i: number) => {
        if (!isObj(r)) return;
        const as = (k: string) => (s === this.o ? (this.renamedSchemes.get(k) ?? k) : k);
        const names = Object.keys(r).map(as).sort();
        if (!names.length) {
          anonymous = true;
          return;
        }
        const scopes = new Map(Object.keys(r).map((k) => [as(k), Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : []]));
        reqs.set(names.join(' + '), { node: child(node, String(i)), scopes });
      });
    }
    return { node: Array.isArray(node.v) ? node : op, anonymous, reqs };
  }

  private security(ao: N, bo: N) {
    const a = this.requirements(this.o, ao);
    const b = this.requirements(this.n, bo);
    if (a.anonymous && !b.anonymous) {
      this.emit('security-added', 'error', `Now requires authentication (${[...b.reqs.keys()].map(code).join(' or ')})`, a.node, b.node);
      return;
    }
    if (!a.anonymous && b.anonymous && !b.reqs.size) {
      this.emit('security-removed', 'info', 'No longer requires authentication', a.node, b.node);
      return;
    }
    // A requirement that kept only some of its schemes (and no more scopes) was loosened;
    // one that gained schemes was tightened. Neither is a way to authenticate added or removed.
    const within = (x: { scopes: Map<string, string[]> }, y: { scopes: Map<string, string[]> }) => [...x.scopes].every(([sc, scopes]) => y.scopes.has(sc) && scopes.every((q) => y.scopes.get(sc)!.includes(q)));
    const explained = new Set<string>();
    for (const [k, r] of a.reqs) {
      const s = b.reqs.get(k);
      if (!s) {
        const looser = [...b.reqs].find(([nk, x]) => !a.reqs.has(nk) && within(x, r));
        if (looser) {
          explained.add(looser[0]);
          const dropped = [...r.scopes.keys()].filter((sc) => !looser[1].scopes.has(sc));
          this.emit('security-requirement-loosened', 'info', `Security requirement ${code(k)} no longer needs ${dropped.length ? dropped.map(code).join(' + ') : 'some of its scopes'} (now ${code(looser[0])})`, r.node, looser[1].node);
          continue;
        }
        const stricter = [...b.reqs].find(([nk, x]) => !a.reqs.has(nk) && within(r, x));
        if (stricter && !b.anonymous) {
          explained.add(stricter[0]);
          const extra = [...stricter[1].scopes.keys()].filter((sc) => !r.scopes.has(sc));
          this.emit('security-requirement-removed', 'error', `Security requirement ${code(k)} now also needs ${extra.length ? extra.map(code).join(' + ') : 'more scopes'} (now ${code(stricter[0])})`, r.node, stricter[1].node);
          continue;
        }
        this.emit('security-requirement-removed', b.anonymous ? 'info' : 'error', `Security requirement ${code(k)} removed`, r.node, b.node);
        continue;
      }
      for (const [scheme, scopes] of r.scopes) {
        const ns = s.scopes.get(scheme) ?? [];
        const added = ns.filter((x) => !scopes.includes(x));
        const removed = scopes.filter((x) => !ns.includes(x));
        if (added.length) this.emit('security-scope-added', 'error', `${code(scheme)} now also requires scope${added.length > 1 ? 's' : ''} ${added.map(code).join(', ')}`, r.node, s.node);
        if (removed.length) this.emit('security-scope-removed', 'info', `${code(scheme)} no longer requires scope${removed.length > 1 ? 's' : ''} ${removed.map(code).join(', ')}`, r.node, s.node);
      }
    }
    for (const [k, s] of b.reqs) if (!a.reqs.has(k) && !a.anonymous && !explained.has(k)) this.emit('security-requirement-added', 'info', `Security requirement ${code(k)} added as an alternative`, a.node, s.node);
  }
}

/** Swagger 2.0 OAuth 2 flow names, as OpenAPI 3 names them. */
const FLOWS_V3: Record<string, string> = { implicit: 'implicit', password: 'password', application: 'clientCredentials', accessCode: 'authorizationCode' };

/**
 * A security scheme as OpenAPI 3 writes it: Swagger 2.0 `type: basic` is `type: http,
 * scheme: basic`, and a 2.0 OAuth 2 `flow` is a `flows` entry. Converting a spec is not a change.
 */
function asV3Scheme(v: unknown): unknown {
  if (!isObj(v)) return v;
  const type = typeof v.type === 'string' ? v.type.toLowerCase() : undefined;
  if (type === 'basic') {
    const { type: _, ...rest } = v;
    return { ...rest, type: 'http', scheme: 'basic' };
  }
  if (type === 'oauth2' && typeof v.flow === 'string' && v.flows === undefined) {
    const { flow, authorizationUrl, tokenUrl, scopes, ...rest } = v;
    const f: Record<string, unknown> = { scopes: scopes ?? {} };
    if (authorizationUrl !== undefined) f.authorizationUrl = authorizationUrl;
    if (tokenUrl !== undefined) f.tokenUrl = tokenUrl;
    return { ...rest, flows: { [FLOWS_V3[flow] ?? flow]: f } };
  }
  return v;
}

/** A security scheme's definition, without its description, comparable as a string. */
function canonical(v: unknown, key = ''): string {
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x)).join(',') + ']';
  // `type`, `in` and `scheme` are case-insensitive; names and URLs are not.
  if (!isObj(v)) return JSON.stringify(typeof v === 'string' && /^(type|in|scheme)$/.test(key) ? v.toLowerCase() : v);
  const keys = Object.keys(v)
    .filter((k) => k !== 'description' && !k.startsWith('x-'))
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k], k)).join(',') + '}';
}

function pointerKey(n: N): string {
  const keys: string[] = [];
  for (let c: N | undefined = n; c?.key !== undefined; c = c.parent) keys.push(c.key);
  return n.doc.path + '#' + keys.reverse().join('/');
}

export function compareSpecs(o: Spec, n: Spec, options?: CompareOptions, notes?: string[]): Change[] {
  const c = new Comparison(o, n, options);
  const changes = c.run();
  notes?.push(...c.notes);
  return changes;
}
