# Security policy

The extension parses specs you open, reads the files they reference, runs `git` to read
older versions, and renders the results in a webview. Bugs that let the content of a
spec run script in that webview, read files outside the workspace or repository, or make
`git` do anything other than read a file at a ref are taken seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/openapi-breaking-changes/security/advisories/new),
not public issues. Include steps to reproduce. You should hear back within a week.

## Scope

In scope: script execution or HTML injection from spec content (paths, names,
descriptions, file names), reading files through `$ref` outside the allowed folders,
option or command injection through refs or settings, and anything that sends data off
the machine.
