export type Level = 'error' | 'warning' | 'info';
export type Dir = 'request' | 'response';

export const LEVEL_ORDER: Record<Level, number> = { error: 0, warning: 1, info: 2 };

/** A level, or "error when …, else warning" for the few changes that depend on context. */
export type RuleLevel = Level | { varies: string };

export interface Rule {
  id: string;
  level: RuleLevel;
  /**
   * In a callback or webhook the API sends the request and the client answers it, so the
   * operation's rules are judged the other way round. Only for rules inside an operation.
   */
  reversed?: RuleLevel;
  /** What happened, in a few words, for the README table. */
  summary: string;
  group: string;
  /** For schema rules: the rule without its prefix, such as `type-changed`. */
  schemaRule?: string;
  /** For rules inside a callback or webhook: which, and the id of the rule it is based on. */
  kind?: Kind;
  base?: string;
}

const r = (group: string, id: string, level: RuleLevel, summary: string, reversed?: RuleLevel): Rule => ({ id, level, summary, group, ...(reversed ? { reversed } : {}) });

/** Rules that are not about a schema. */
const BASE: Rule[] = [
  r('Endpoints', 'endpoint-removed', 'error', 'An operation (method + path) was removed'),
  r('Endpoints', 'deprecated-endpoint-removed', 'warning', 'A deprecated operation was removed'),
  r('Endpoints', 'endpoint-moved', { varies: 'breaking; warning when the operation was deprecated' }, 'An operation moved to another path or method (matched by `operationId` or by what it takes and returns)'),
  r('Endpoints', 'endpoint-added', 'info', 'An operation was added'),
  r('Endpoints', 'endpoint-deprecated', 'info', 'An operation was marked deprecated'),
  r('Endpoints', 'endpoint-reactivated', 'info', 'An operation is no longer deprecated'),
  r('Endpoints', 'operation-id-changed', 'warning', '`operationId` changed or was removed (generated clients rename the method)', 'info'),
  r('Endpoints', 'endpoint-server-added', 'info', 'A server was added to an operation or path (its own `servers`)'),
  r('Endpoints', 'endpoint-server-removed', 'warning', 'A server was removed from an operation or path (its own `servers`)'),

  r('Parameters', 'request-parameter-added', 'info', 'An optional parameter was added', 'info'),
  r('Parameters', 'request-parameter-added-required', 'error', 'A required parameter was added', 'info'),
  r('Parameters', 'request-parameter-removed', 'warning', 'A parameter was removed (clients still send it)', { varies: 'breaking when it was required, else warning' }),
  r('Parameters', 'request-parameter-location-changed', 'error', 'A parameter moved, such as from query to header', 'error'),
  r('Parameters', 'request-parameter-became-required', 'error', 'An optional parameter became required', 'info'),
  r('Parameters', 'request-parameter-became-optional', 'info', 'A required parameter became optional', 'error'),
  r('Parameters', 'request-parameter-serialization-changed', 'warning', '`style` or `explode` changed', 'warning'),
  r('Parameters', 'request-parameter-deprecated', 'info', 'A parameter was marked deprecated', 'info'),

  r('Request body', 'request-body-added', 'info', 'An optional request body was added', 'info'),
  r('Request body', 'request-body-added-required', 'error', 'A required request body was added', 'info'),
  r('Request body', 'request-body-removed', 'warning', 'The request body was removed', 'error'),
  r('Request body', 'request-body-became-required', 'error', 'The request body became required', 'info'),
  r('Request body', 'request-body-became-optional', 'info', 'The request body became optional', 'error'),
  r('Request body', 'request-body-media-type-added', 'info', 'A request media type was added', 'warning'),
  r('Request body', 'request-body-media-type-removed', 'error', 'A request media type was removed', 'info'),

  r('Responses', 'response-success-status-removed', 'error', 'A 2xx response was removed', 'warning'),
  r('Responses', 'response-status-removed', 'warning', 'A non-2xx (or `default`) response was removed', 'info'),
  r('Responses', 'response-status-added', 'info', 'A response status was added', 'info'),
  r('Responses', 'response-media-type-added', 'info', 'A response media type was added', 'info'),
  r('Responses', 'response-media-type-removed', 'error', 'A response media type was removed', 'error'),
  r('Responses', 'response-header-added', 'info', 'A response header was added', 'info'),
  r('Responses', 'response-header-removed', { varies: 'breaking when it was required, else warning' }, 'A response header was removed', 'info'),
  r('Responses', 'response-header-became-optional', 'error', 'A required response header became optional', 'info'),
  r('Responses', 'response-link-added', 'info', 'A response link was added'),
  r('Responses', 'response-link-removed', 'warning', 'A response link was removed (clients that follow it break)'),
  r('Responses', 'response-link-changed', 'warning', "A response link points at another operation or passes other parameters"),

  r('Callbacks and webhooks', 'webhook-added', 'info', 'A webhook (OpenAPI 3.1 `webhooks`) was added'),
  r('Callbacks and webhooks', 'webhook-removed', 'error', 'A webhook was removed: clients stop receiving it'),
  r('Callbacks and webhooks', 'deprecated-webhook-removed', 'warning', 'A deprecated webhook was removed'),
  r('Callbacks and webhooks', 'webhook-deprecated', 'info', 'A webhook was marked deprecated'),
  r('Callbacks and webhooks', 'webhook-reactivated', 'info', 'A webhook is no longer deprecated'),
  r('Callbacks and webhooks', 'callback-added', 'info', 'A callback was added to an operation'),
  r('Callbacks and webhooks', 'callback-removed', 'error', 'A callback was removed: clients stop receiving it'),
  r('Callbacks and webhooks', 'deprecated-callback-removed', 'warning', 'A deprecated callback was removed'),
  r('Callbacks and webhooks', 'callback-deprecated', 'info', 'A callback was marked deprecated'),
  r('Callbacks and webhooks', 'callback-reactivated', 'info', 'A callback is no longer deprecated'),
  r('Callbacks and webhooks', 'callback-url-changed', 'error', 'The runtime expression a callback URL is read from changed'),

  r('Security', 'security-added', 'error', 'An operation that allowed anonymous calls now needs credentials'),
  r('Security', 'security-removed', 'info', 'An operation no longer needs credentials'),
  r('Security', 'security-requirement-added', 'info', 'Another way to authenticate was added'),
  r('Security', 'security-requirement-removed', 'error', 'A way to authenticate was removed'),
  r('Security', 'security-requirement-loosened', 'info', 'A requirement needs fewer of its schemes (`apiKey + oauth` → `apiKey`)'),
  r('Security', 'security-scope-added', 'error', 'A requirement needs an extra scope'),
  r('Security', 'security-scope-removed', 'info', 'A requirement needs fewer scopes'),
  r('Security', 'security-scheme-changed', 'error', 'A security scheme changed type, location, name or scheme'),
  r('Security', 'security-scheme-deprecated', 'info', 'A security scheme was marked deprecated (OpenAPI 3.2)'),

  r('General', 'server-added', 'info', 'A server URL was added'),
  r('General', 'server-removed', 'info', 'A server URL was removed'),
  r('General', 'api-version-changed', 'info', '`info.version` changed'),
];

/** Schema rules: applied to parameters, bodies, properties and headers, by direction. */
export interface SchemaRule {
  rule: string;
  request?: RuleLevel;
  response?: RuleLevel;
  summary: string;
  /** Only for properties (needs a parent object). */
  propertyOnly?: boolean;
}

export const SCHEMA_RULES: SchemaRule[] = [
  { rule: 'type-changed', request: { varies: 'info when the new type accepts every old value (integer → number), else breaking' }, response: { varies: 'info when the new type is narrower, else breaking' }, summary: 'Type changed' },
  { rule: 'format-changed', request: { varies: 'info when widened (int32 → int64) or dropped, warning when added, else breaking' }, response: { varies: 'info when narrowed, warning when widened or dropped, else breaking' }, summary: 'Format changed' },
  { rule: 'became-nullable', request: 'info', response: 'warning', summary: 'Can now be `null`' },
  { rule: 'became-not-nullable', request: 'error', response: 'info', summary: 'Can no longer be `null`' },
  { rule: 'enum-value-added', request: 'info', response: 'warning', summary: 'An enum value was added (clients with exhaustive switches break on responses)' },
  { rule: 'enum-value-removed', request: 'error', response: 'info', summary: 'An enum value was removed' },
  { rule: 'became-enum', request: 'error', response: 'info', summary: 'Values are now limited to an enum' },
  { rule: 'no-longer-enum', request: 'info', response: 'warning', summary: 'The enum restriction was dropped' },
  { rule: 'max-decreased', request: 'error', response: 'info', summary: '`maximum` lowered or added' },
  { rule: 'max-increased', request: 'info', response: 'info', summary: '`maximum` raised or removed' },
  { rule: 'min-increased', request: 'error', response: 'info', summary: '`minimum` raised or added' },
  { rule: 'min-decreased', request: 'info', response: 'info', summary: '`minimum` lowered or removed' },
  { rule: 'max-length-decreased', request: 'error', response: 'info', summary: '`maxLength` lowered or added' },
  { rule: 'max-length-increased', request: 'info', response: 'info', summary: '`maxLength` raised or removed' },
  { rule: 'min-length-increased', request: 'error', response: 'info', summary: '`minLength` raised or added' },
  { rule: 'min-length-decreased', request: 'info', response: 'info', summary: '`minLength` lowered or removed' },
  { rule: 'max-items-decreased', request: 'error', response: 'info', summary: '`maxItems` lowered or added' },
  { rule: 'max-items-increased', request: 'info', response: 'info', summary: '`maxItems` raised or removed' },
  { rule: 'min-items-increased', request: 'error', response: 'info', summary: '`minItems` raised or added' },
  { rule: 'min-items-decreased', request: 'info', response: 'info', summary: '`minItems` lowered or removed' },
  { rule: 'max-properties-decreased', request: 'error', response: 'info', summary: '`maxProperties` lowered or added' },
  { rule: 'max-properties-increased', request: 'info', response: 'info', summary: '`maxProperties` raised or removed' },
  { rule: 'min-properties-increased', request: 'error', response: 'info', summary: '`minProperties` raised or added' },
  { rule: 'min-properties-decreased', request: 'info', response: 'info', summary: '`minProperties` lowered or removed' },
  { rule: 'multiple-of-changed', request: { varies: 'breaking when some values allowed before no longer are, else info' }, response: 'info', summary: '`multipleOf` added, changed or removed' },
  { rule: 'unique-items-added', request: 'error', response: 'info', summary: '`uniqueItems` turned on' },
  { rule: 'unique-items-removed', request: 'info', response: 'info', summary: '`uniqueItems` turned off' },
  { rule: 'pattern-added', request: 'warning', response: 'info', summary: 'A `pattern` was added' },
  { rule: 'pattern-changed', request: 'warning', response: 'info', summary: '`pattern` changed' },
  { rule: 'pattern-removed', request: 'info', response: 'info', summary: '`pattern` was removed' },
  { rule: 'default-changed', request: 'warning', summary: 'The default value changed (server behaviour changes for clients that omit it)' },
  { rule: 'additional-properties-restricted', request: { varies: 'breaking when set to false, warning when limited to a schema' }, summary: '`additionalProperties` tightened' },
  { rule: 'additional-properties-allowed', response: 'warning', summary: 'Objects may now have properties that are not listed' },
  { rule: 'subschema-added', request: 'info', response: 'warning', summary: 'A `oneOf` / `anyOf` option was added' },
  { rule: 'subschema-removed', request: 'error', response: 'info', summary: 'A `oneOf` / `anyOf` option was removed' },
  { rule: 'discriminator-property-changed', request: 'error', response: 'error', summary: 'The `discriminator` property name changed' },
  { rule: 'discriminator-mapping-added', request: 'info', response: 'warning', summary: 'A `discriminator` mapping value was added' },
  { rule: 'discriminator-mapping-removed', request: 'error', response: 'info', summary: 'A `discriminator` mapping value was removed' },
  { rule: 'discriminator-mapping-changed', request: 'warning', response: 'warning', summary: 'A `discriminator` mapping value points at another schema' },
  { rule: 'added', request: 'info', response: 'info', summary: 'An optional property was added', propertyOnly: true },
  { rule: 'added-required', request: 'error', summary: 'A required property was added', propertyOnly: true },
  { rule: 'removed', request: { varies: 'breaking when the object rejects unlisted properties, else warning' }, response: { varies: 'breaking when it was required, else warning' }, summary: 'A property was removed', propertyOnly: true },
  { rule: 'became-required', request: 'error', response: 'info', summary: 'A property became required', propertyOnly: true },
  { rule: 'became-optional', request: 'info', response: 'error', summary: 'A property became optional (responses may now omit it)', propertyOnly: true },
  { rule: 'became-read-only', request: 'warning', summary: 'A property became `readOnly` (no longer accepted in requests)', propertyOnly: true },
  { rule: 'became-write-only', response: 'error', summary: 'A property became `writeOnly` (no longer returned)', propertyOnly: true },
  { rule: 'deprecated', request: 'info', response: 'info', summary: 'A property was marked deprecated', propertyOnly: true },
];

/** Where a schema sits: decides the id prefix for changes at its root. */
export type SchemaRoot = 'request-parameter' | 'request-body' | 'response-body' | 'response-header';

export const ROOT_DIR: Record<SchemaRoot, Dir> = {
  'request-parameter': 'request',
  'request-body': 'request',
  'response-body': 'response',
  'response-header': 'response',
};

export type Kind = 'callback' | 'webhook';

/** Ids of the rules about the operation itself, which get their own names in a callback or webhook. */
const OWN_NAMES: Record<string, (k: Kind) => string> = {
  'endpoint-removed': (k) => `${k}-removed`,
  'deprecated-endpoint-removed': (k) => `deprecated-${k}-removed`,
  'endpoint-added': (k) => `${k}-added`,
  'endpoint-deprecated': (k) => `${k}-deprecated`,
  'endpoint-reactivated': (k) => `${k}-reactivated`,
};

/** The id of a rule inside a callback or webhook: its own name, or the rule's with a prefix. */
export function kindId(id: string, kind?: Kind): string {
  if (!kind) return id;
  return OWN_NAMES[id]?.(kind) ?? `${kind}-${id}`;
}

const PREFIXES = ['request-parameter', 'request-body', 'request-property', 'response-body', 'response-property', 'response-header'];
const PREFIX_GROUP: Record<string, string> = {
  'request-parameter': 'Parameters',
  'request-body': 'Request body',
  'request-property': 'Request body',
  'response-body': 'Responses',
  'response-property': 'Responses',
  'response-header': 'Responses',
};

let catalog: Rule[] | undefined;

/** Every id a comparison can report, with its level and a summary. */
export function allRules(): Rule[] {
  if (catalog) return catalog;
  const out = [...BASE];
  const schema: Rule[] = [];
  for (const prefix of PREFIXES) {
    const dir: Dir = prefix.startsWith('request') ? 'request' : 'response';
    const isProp = prefix.endsWith('property');
    for (const s of SCHEMA_RULES) {
      const level = s[dir];
      if (!level) continue;
      if (s.propertyOnly && !isProp) continue;
      const reversed = s[dir === 'request' ? 'response' : 'request'];
      schema.push({ id: `${prefix}-${s.rule}`, level, summary: s.summary, group: PREFIX_GROUP[prefix], schemaRule: s.rule, ...(reversed ? { reversed } : {}) });
    }
  }
  out.push(...schema);
  // Inside callbacks and webhooks: the same rules, judged the other way round.
  for (const kind of ['callback', 'webhook'] as Kind[]) {
    for (const r of [...BASE, ...schema]) {
      if (!r.reversed) continue;
      const id = kindId(r.id, kind);
      if (out.some((x) => x.id === id)) continue;
      out.push({ ...r, id, level: r.reversed, reversed: undefined, group: 'Callbacks and webhooks', kind, base: r.id });
    }
  }
  catalog = out;
  return out;
}

export function isKnownId(id: string) {
  return allRules().some((r) => r.id === id);
}
