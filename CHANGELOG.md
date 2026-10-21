# Changelog

## 0.1.0

First release.

- Compares two versions of an OpenAPI 3.0 / 3.1 / 3.2 or Swagger 2.0 spec, in YAML or
  JSON, and reports what changed for API consumers: breaking, possibly breaking, and
  other changes, each with a stable id. 105 kinds of change (796 ids, counting where they
  happen) across endpoints, parameters, request bodies, responses, links, schemas,
  discriminators, callbacks, webhooks, security and servers, judged by direction (request
  or response, and the other way round in callbacks and webhooks).
- An endpoint that moved to another path is one breaking change naming both paths,
  matched by `operationId` or by what it takes and returns; the message says how.
- Release notes for consumers between two tags, or the last tag and the working copy,
  grouped Breaking / Deprecated / Added / Changed, as Markdown.
- Follows `$ref`s within the spec, to other files (read at the same Git version), and to
  `$id` / `$anchor` schemas; handles recursive schemas, merges `allOf` (the tightest limit
  wins), applies keywords next to a `$ref` in 3.1, and matches `oneOf` / `anyOf` options
  by reference, title, discriminator value or shape, never by position. A `null` option
  only makes a schema nullable; a schema that becomes one option of a union is compared
  with it. Swagger 2.0 form parameters and security schemes compare as what OpenAPI 3
  writes for them. Media ranges (`*/*`) and status ranges (`2XX`) are compared with the
  types and codes they cover.
- Compare with HEAD, any branch, tag or commit, another spec in the workspace, two files
  in the Explorer (the old one told by `info.version` or the names, else you're asked),
  or the two sides of a diff editor. Specs are recognised by content.
- Report grouped by endpoint, with level filters, search, links to the line in the old
  and the new spec, and a Markdown changelog for pull requests; a change to a shared schema
  is listed once, by the schema's name.
- Optional Problems panel check against a baseline ref (`openapiBreakingChanges.baseRef`),
  with quick fixes to open the report or ignore a change; changes in referenced files show
  on those files, and a ref that names nothing is reported.
- Comparisons run in a worker thread: a large spec never holds up the editor.
- Ignore rules by id, path and method; warnings as errors; settings per folder in
  multi-root workspaces. In Restricted Mode, the workspace's ignore rules and baseline are
  not applied and Git doesn't run; comparing files still works.
