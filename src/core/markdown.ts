import type { Change } from './diff';
import { codeSpan, mdText } from './md';
import { count } from './policy';
import type { Level } from './rules';

const HEADINGS: Record<Level, string> = { error: 'Breaking changes', warning: 'Possibly breaking', info: 'Other changes' };

export const endpointLabel = (c: Pick<Change, 'method' | 'path' | 'webhook'>) => (!c.path ? 'Whole API' : c.webhook ? `${c.method} ${c.path} (webhook)` : `${c.method} ${c.path}`);

const KEYWORDS = new Set(['type', 'format', 'enum', 'const', 'nullable', 'maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum', 'maxLength', 'minLength', 'maxItems', 'minItems', 'pattern', 'default', 'required', 'readOnly', 'writeOnly', 'deprecated', 'additionalProperties', 'discriminator', 'x-nullable']);

/**
 * A property's name by the schema it is defined in: `Pet.status` for
 * `/components/schemas/Pet/properties/status`, the file's name for a schema file of its own.
 */
export function schemaPropertyName(loc?: { file: string; pointer: string }): string | undefined {
  if (!loc) return undefined;
  const keys = loc.pointer
    .split('/')
    .slice(1)
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let i: number;
  const parts: string[] = [];
  if (keys[0] === 'components' && keys[1] === 'schemas' && keys[2]) [parts[0], i] = [keys[2], 3];
  else if (keys[0] === 'definitions' && keys[1]) [parts[0], i] = [keys[1], 2];
  else if (!keys.length || keys[0] === 'properties' || keys[0] === 'allOf') [parts[0], i] = [loc.file.split('/').pop()!.replace(/\.(ya?ml|json)$/i, ''), 0];
  else return undefined;
  for (; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'properties' && keys[i + 1] !== undefined) parts.push(keys[++i]);
    else if (k === 'items') parts.push('[]');
    else if (k === 'allOf') i++;
    else if (KEYWORDS.has(k) || k === 'properties') break;
    else return undefined; // oneOf options and other places: keep the endpoint's view
  }
  return parts.reduce((a, b) => (b === '[]' ? a + b : `${a}.${b}`));
}

/** One line for a change that several endpoints share, or undefined when they read differently. */
export function sharedMessage(cs: Change[]): string | undefined {
  if (cs.every((c) => c.message === cs[0].message)) return cs[0].message;
  const c = cs[0];
  if (!/-property-/.test(c.id)) return undefined;
  const name = schemaPropertyName(/-removed$/.test(c.id) ? (c.old ?? c.new) : (c.new ?? c.old));
  if (!name) return undefined;
  // `Pet.status` is a property; `PetStatus` alone is a schema used as one.
  const noun = name.includes('.') ? 'property' : 'schema';
  const msg = (x: Change) => x.message.replace(/^(Request|Response|Payload) property `[^`]*`/, `$1 ${noun} \`${name}\``).replace(/ \((?:[0-9A-Z]{3}|default) response(?: \(each streamed item\))?\)$| \(request body\)$| \(in [^)]*\)$/, '');
  const m = msg(c);
  return cs.every((x) => msg(x) === m) ? m : undefined;
}

/**
 * Bullets for a list of changes: grouped by endpoint, and a change to a shared schema
 * listed once, by the schema's name, with the endpoints it touches.
 */
function bullets(of: Change[], suffix = (_: Change) => ''): string[] {
  const lines: string[] = [];
  const same = new Map<string, Change[]>();
  for (const c of of) {
    const k = `${c.id}|${c.old?.file}#${c.old?.pointer}|${c.new?.file}#${c.new?.pointer}`;
    same.set(k, [...(same.get(k) ?? []), c]);
  }
  const byEndpoint = new Map<string, string[]>();
  const shared: string[] = [];
  const single = (c: Change) => {
    const ep = endpointLabel(c);
    byEndpoint.set(ep, [...(byEndpoint.get(ep) ?? []), c.message + suffix(c)]);
  };
  for (const cs of same.values()) {
    const endpoints = [...new Set(cs.map(endpointLabel))];
    const msg = endpoints.length > 1 ? sharedMessage(cs) : undefined;
    if (!msg) {
      cs.forEach(single);
      continue;
    }
    const names = endpoints.slice(0, 3).map(codeSpan).join(', ');
    shared.push(`- ${msg}, on ${names}${endpoints.length > 3 ? ` and ${endpoints.length - 3} more endpoints` : ''}${suffix(cs[0])}`);
  }
  for (const [ep, msgs] of byEndpoint) {
    if (msgs.length === 1) lines.push(`- ${codeSpan(ep)}: ${msgs[0]}`);
    else {
      lines.push(`- ${codeSpan(ep)}`);
      for (const m of msgs) lines.push(`  - ${m}`);
    }
  }
  lines.push(...shared);
  return lines;
}

/** A changelog for a pull request. Ignored changes are left out. */
export function toMarkdown(changes: Change[], title: string): string {
  const shown = changes.filter((c) => c.ignored === undefined);
  const n = count(changes);
  const lines = [`### ${oneLine(title)}`, ''];
  const parts = [`**${n.error} breaking**`, `${n.warning} possibly breaking`, `${n.info} other`];
  if (n.ignored) parts.push(`${n.ignored} ignored`);
  lines.push(parts.join(' · '), '');
  if (!shown.length) {
    lines.push('No changes for API consumers.');
    return lines.join('\n') + '\n';
  }
  for (const level of ['error', 'warning', 'info'] as Level[]) {
    const of = shown.filter((c) => c.level === level);
    if (!of.length) continue;
    lines.push(`#### ${HEADINGS[level]}`, '', ...bullets(of), '');
  }
  return lines.join('\n');
}

export type ReleaseSection = 'breaking' | 'deprecated' | 'added' | 'changed';

/**
 * Where a change goes in release notes. Breaking changes first; then deprecations; then
 * what consumers can start using; everything else (possibly breaking ones included, marked)
 * is "Changed".
 */
export function releaseSection(c: Pick<Change, 'id' | 'level'>): ReleaseSection {
  if (c.level === 'error') return 'breaking';
  if (/(^|-)deprecated$/.test(c.id)) return 'deprecated';
  if (c.level === 'info' && /-added$/.test(c.id)) return 'added';
  return 'changed';
}

export interface ReleaseNotesInfo {
  /** The old and the new version, as Markdown (names in code spans): tags, branches, "the working copy". */
  from: string;
  to: string;
  /** `info.version` of each side, when known. */
  versions?: { old?: string; new?: string };
  /** The spec, for the heading: `openapi.yaml`. */
  spec?: string;
}

const SECTION_TITLES: Record<ReleaseSection, string> = { breaking: 'Breaking changes', deprecated: 'Deprecated', added: 'Added', changed: 'Changed' };

/**
 * Release notes for API consumers: what changed between two versions, grouped Breaking /
 * Deprecated / Added / Changed. Ignored changes are left out.
 */
export function toReleaseNotes(changes: Change[], info: ReleaseNotesInfo): string {
  const shown = changes.filter((c) => c.ignored === undefined);
  const v = info.versions;
  const heading = v?.new && v.new !== v.old ? `API ${mdText(v.new)}` : `API changes in ${oneLine(info.to)}`;
  const lines = [`## ${heading}`, ''];
  const compared = `Changes since ${oneLine(info.from)}${v?.old && v.old !== v.new ? ` (API ${mdText(v.old)})` : ''}${info.spec ? `, in ${codeSpan(info.spec)}` : ''}.`;
  const by: Record<ReleaseSection, Change[]> = { breaking: [], deprecated: [], added: [], changed: [] };
  for (const c of shown) by[releaseSection(c)].push(c);
  const n = (k: ReleaseSection, one: string, many: string) => (by[k].length ? `${by[k].length} ${by[k].length === 1 ? one : many}` : '');
  const summary = [n('breaking', 'breaking change', 'breaking changes'), n('deprecated', 'deprecation', 'deprecations'), n('added', 'addition', 'additions'), n('changed', 'other change', 'other changes')].filter(Boolean);
  lines.push(compared + (summary.length ? ` ${cap(summary.join(', '))}.` : ''), '');
  if (!shown.length) {
    lines.push('No changes for API consumers.');
    return lines.join('\n') + '\n';
  }
  for (const k of ['breaking', 'deprecated', 'added', 'changed'] as ReleaseSection[]) {
    if (!by[k].length) continue;
    // Possibly breaking changes lead "Changed", and say so.
    const of = k === 'changed' ? [...by[k]].sort((a, b) => (a.level === 'warning' ? 0 : 1) - (b.level === 'warning' ? 0 : 1)) : by[k];
    lines.push(`### ${SECTION_TITLES[k]}`, '', ...bullets(of, (c) => (c.level === 'warning' ? ' _(may break some clients)_' : '')), '');
  }
  return lines.join('\n');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A heading the caller wrote (its names already in code spans): kept on one line. */
const oneLine = (s: string) => s.replace(/\r\n?|\n/g, ' ');
