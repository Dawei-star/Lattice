# Phase 1: deterministic file assistant

## Goal

Move routine file work out of the model round trip. The model, GUI, or another
agent may decide which command to run, but `fc-core.mjs` performs the operation
locally and returns a structured result.

The default root is `FC_ROOT`, then `VAULT_DIR`, then the current directory.
Use `--root` to select a different root explicitly. Every path is relative to
that root. Absolute paths, traversal, symlinks, and the reserved `.fc`
directory are rejected.

## Commands

| Command | Mutating | Confirmation | Undo |
| --- | ---: | ---: | ---: |
| `read` | no | no | no |
| `stat` | no | no | no |
| `find` | no | no | no |
| `grep` | no | no | no |
| `create` | yes | yes | yes |
| `write` | yes | yes | yes |
| `append` | yes | yes | yes |
| `edit` | yes | yes | yes |
| `copy` | yes | yes | yes |
| `move` | yes | yes | yes |
| `delete` | yes | yes | yes |
| `mkdir` | yes | yes | yes |
| `batch` | yes | yes (per action + plan hash) | per action |
| `undo` | yes | explicit command | n/a |
| `log` | no | no | no |

Examples:

```text
npm run fc -- read notes/today.md
npm run fc -- stat notes/today.md
npm run fc -- grep "invoice" . --type md
npm run fc -- create notes/new.md --content "hello" --yes
npm run fc -- edit config.json --replace old --with new --yes
npm run fc -- move Downloads/photo.jpg Photos/2026/photo.jpg --dry-run
npm run fc -- batch plans/tidy.json --yes
npm run fc -- delete old.md --yes
npm run fc -- undo
```

All commands print JSON to stdout. Errors are JSON on stderr and exit with a
non-zero status. Mutating commands require `--yes` in non-interactive use.
Without it, an interactive terminal receives a short preview and confirmation
prompt. `--dry-run` never writes and returns the same preview shape.

## Safety and recovery

Each successful mutation gets an operation id and an entry under:

```text
<root>/.fc/
  trash/<operation-id>/manifest.json
  trash/<operation-id>/files/*.bin
  audit.jsonl
```

`undo` selects the newest operation that has not already been undone. Before
restoring, it compares the current file hash with the post-operation hash. If a
user or another process changed the file, undo stops instead of overwriting
that change. `undo --force` is available for an explicit override.

`edit` uses exact text replacement. It fails when the old text is absent or
appears more than once; `--all` is required for a repeated replacement. Writes
use a temporary file and rename, and copy/move reject an existing target.

`batch` reads a JSON plan file (`{ "actions": [...] }` or a bare array),
previews every action, and computes a `planHash` over the actions and their
before-states. Execution aborts on the first failure (`BATCH_PARTIAL_FAILURE`
carries the batch id and the already-completed operations); `--plan-hash`
pins execution to a specific preview.

## Service integration

The server now exposes the same core against the configured Vault root:

```text
GET  /api/files/read?path=...
GET  /api/files/find?pattern=...&dir=...
GET  /api/files/grep?query=...&dir=...
POST /api/files/preview
POST /api/files/execute
POST /api/files/undo
GET  /api/files/log
```

`execute` requires `confirmed: true`; the workspace `viewer` role can preview
but cannot execute or undo. Existing AI create/update/delete/move/copy actions
now use the same `FileStore`; the Inbox-specific `archive` action remains a
specialized frontmatter transformation.

Batch plans are now implemented in both the CLI and the core (`previewBatch` /
`mutateBatch` with `planHash`). The workbench renders `preview.diff` and drives
single operations and batch plans through the same preview/execute contract.
