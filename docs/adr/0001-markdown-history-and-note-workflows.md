# ADR-0001: Keep Note History and Workflow Metadata in the Vault

## Status

Accepted

## Context

Lattice treats Markdown files as the source of truth and SQLite as a rebuildable
projection. Note history, templates, daily notes, outlines, and HTML export must
therefore work without making SQLite the owner of document content.

The application also has two write paths:

- the HTTP notes service used by the browser;
- direct Vault writes used by the desktop shell and external Markdown editing.

Both paths need bounded data loss, path traversal protection, and predictable
behavior when the projection is briefly behind the filesystem.

## Decision

- Store immutable note snapshots under `.lattice/history/<noteId>/`.
- Name snapshots with a UTC timestamp and SHA-256 digest. The digest is checked
  before a version can be read or restored.
- Create a snapshot before service-side title/content changes. When the Vault
  watcher observes an external content change, snapshot the previous projected
  note in canonical Markdown before updating SQLite.
- Protect restore requests with an optional `expectedCurrentHash`; return HTTP
  409 when the current file no longer matches the caller's view.
- Store user-authored templates under `_templates/` and exclude that directory
  from note and folder projection scans.
- Create daily notes at `Daily/YYYY-MM-DD.md`, with idempotency based on the
  canonical file path.
- Keep outline extraction and static HTML generation in the web client so they
  reuse the existing sanitized Markdown renderer and do not add a server-side
  Markdown dependency.

## Consequences

### Positive

- Markdown remains portable and recoverable without a database migration.
- Browser, desktop, and external-file edits share the same conflict model.
- History reads are bounded by one note directory and do not affect normal scans.
- Template and daily-note creation remain compatible with the existing notes
  service, folder model, tags, links, and search projection.
- Static exports inherit the existing XSS sanitization path.

### Negative

- History consumes additional disk space and needs future retention/cleanup
  policy for very high edit frequency.
- External edits cannot preserve formatting that was already overwritten; the
  watcher snapshots the previous SQLite projection in canonical Markdown.
- Static exports do not resolve interactive wiki embeds into live application
  behavior.

## Validation Criteria

- A content/title update creates one readable snapshot before the new version.
- Restore creates a new pre-restore snapshot and returns 409 for a stale hash.
- Invalid version identifiers never reach filesystem resolution.
- Repeated daily-note creation returns the same note ID and path.
- `_templates/` files never appear in `/api/notes/index`.
- `npm test`, `npm --prefix web test`, and `npm --prefix web run build` pass.

