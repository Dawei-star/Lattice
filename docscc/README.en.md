# Lattice

> Language: [中文](./README.zh-CN.md) | [English](./README.en.md)

A **local-first** backlinking knowledge base inspired by the core experience of Obsidian. Choose a local Vault folder, save notes as Markdown files, and use SQLite only as a rebuildable index. No network connection is required by default; after external models are configured, only AI conversations are sent to the corresponding service according to the configuration.

All data stays on your own machine. No registration or network connection is required.

---

![Lattice logo](../FILES/README.md/lattice-icon.svg)

[![License: Mulan PSL v2](https://img.shields.io/badge/License-Mulan%20PSL%20v2-1f6feb.svg)](../LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)](#release-notes)
[![Node.js: >=22.5.0](https://img.shields.io/badge/Node.js-%3E%3D22.5.0-339933?logo=node.js&logoColor=white)](../package.json)
[![GitHub stars](https://img.shields.io/github/stars/Dawei-star/Lattice?style=flat)](https://github.com/Dawei-star/Lattice/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/Dawei-star/Lattice?style=flat)](https://github.com/Dawei-star/Lattice/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/Dawei-star/Lattice?style=flat)](https://github.com/Dawei-star/Lattice/commits/main)

## Website

**Lattice Documentation Site**: [Open online](https://dawei-star.github.io/Lattice/website/lattice-docs.html) · [`website/lattice-docs.html`](../website/lattice-docs.html)
Read the product overview, feature previews, privacy boundaries, technical architecture, and quick-start guide.

**Lattice Download Center**: [Open online](https://dawei-star.github.io/Lattice/website/lattice-download.html) · [`website/lattice-download.html`](../website/lattice-download.html)
Open the GitHub Releases page for the Windows installer and portable build. The release page is the source of truth for versions, filenames, and checksums.

**Source and feedback**: [`Dawei-star/Lattice`](https://github.com/Dawei-star/Lattice)

After downloading the repository, you can open the HTML pages directly. For online releases and official installers, use GitHub Releases.

## Screenshots

### Knowledge workspace

<table>
  <tr>
    <td width="50%"><img src="../FILES/README.md/lattice-workspace-light.png" alt="Lattice light workspace" /></td>
    <td width="50%"><img src="../FILES/README.md/lattice-workspace-dark.png" alt="Lattice dark workspace" /></td>
  </tr>
  <tr>
    <td align="center">Light theme</td>
    <td align="center">Dark theme</td>
  </tr>
</table>

### Canvas and AI assistant

<table>
  <tr>
    <td width="50%"><img src="../FILES/README.md/lattice-canvas.png" alt="Lattice local canvas" /></td>
    <td width="50%"><img src="../FILES/README.md/lattice-ai-assistant.png" alt="Lattice AI knowledge assistant" /></td>
  </tr>
  <tr>
    <td align="center">Local canvas with relation links</td>
    <td align="center">AI knowledge assistant</td>
  </tr>
</table>

### MCP integration

![Lattice MCP Server settings page](../FILES/README.md/lattice-mcp-server.png)

## Documentation

| Document | Audience | Contents |
| --- | --- | --- |
| This document | Developers / secondary development | Architecture, technology choices, API, data model, testing, and development workflow |
| [`使用说明书.md`](../使用说明书.md) | Release users | Installation, startup, interface tour, notes, canvas, settings, backup and migration, upgrades, uninstall, and troubleshooting |

The two documents serve different audiences: this document covers code maintenance and secondary development, while the user manual covers daily use of an installed release.
Release packages are provided by the corresponding release; packaging steps are intentionally not repeated here.

---

## Features

| Capability | Description |
| --- | --- |
| Markdown editing | Edit, split, and preview modes with 900 ms quiet autosave and synchronized scrolling |
| Backlinks | Supports `[[title]]`, `[[title\|alias]]`, and `[[title#section]]`; links are parsed automatically and shown in a backlinks panel |
| Embedded references | A standalone `![[title]]` expands into an embedded card, with two nesting levels and circular-reference detection |
| Relationship graph | A hand-built Canvas force-directed layout with degree-based node sizing, dragging, zooming, and click-to-navigate |
| Full-text search | SQLite FTS5 with a trigram tokenizer, substring matching for Chinese, and highlighted keywords in results |
| Inbox work queue | Quickly capture temporary items, filter by to-triage / triaging / processed, and mark complete or archive into a project |
| Tags | Write `#tag` in the body for automatic categorization; nested tags such as `#engineering/frontend` are supported |
| Folder tree | Arbitrary nesting, in-place renaming, and automatic return to “Uncategorized” after deleting a folder |
| Multiple tabs | Open multiple notes in parallel with pinning, favorites, renaming, moving, and close-left / close-right / close-other actions |
| Local canvas | Store text cards, note cards, Vault images, and card connections in `.canvas` files; supports four-sided connection points, dragging, zooming, and alignment; Obsidian `.canvas` files open directly (edge endpoints, `"1"`–`"6"`/hex colors, and group/file/image nodes are normalized on read) |
| Attachment grouping and lightbox | Images pasted or dropped into a note are stored under `attachments/<note title>/`; click an image in preview to view it full screen (wheel zoom, drag to pan, double-click toggles fit) |
| Vault browser | Browse Markdown and Canvas files in the sidebar; open, move, copy paths, and use the context menu; with the “show attachments” toggle, browse non-note files in any folder |
| Deterministic file assistant fc | The local `npm run fc` command (read/stat/find/grep/create/write/append/edit/copy/move/delete/mkdir/batch/undo/log, plus `serve` as a JSON-lines daemon, `shell` as an interactive session, `doctor` health checks, and a `--mode readonly` preset) and the `GET/POST /api/files/*` share one core: traversal/symlink protection, atomic writes, `.fc/trash` snapshots and audit, and undo — routine file work does not depend on a model round trip |
| AI knowledge assistant | Streaming chat, source-cited knowledge-base Q&A (hybrid FTS + semantic retrieval), persistent sessions, related-note recommendations, Inbox triage suggestions with safe archiving, natural-language file operations (task mode can execute multiple rounds and audit them automatically, failed actions are fed back to the model for self-correction, and operations can be undone with one click), editor writing assistant (polish / summarize / translate / continue / create a full document from a title / custom instructions, with streaming preview), retrieval debugging, and CLI task mode |
| Daily digest | Manually generate a Journal digest for notes modified today; set `AI_DIGEST_HOUR` to generate it on a local-time schedule (missed runs are caught up later) with idempotent updates for the same day |
| MCP Server | Expose `list_notes`, `search_notes`, `read_note`, `get_note_links`, `list_tags`, `get_vault_statistics`, and `list_note_history` to external agents such as Claude over stdio; read-only by default — `create_note`, `update_note`, and `restore_note_version` are provided only after `LATTICE_MCP_ALLOW_WRITES` is enabled, and writes are recorded in the MCP audit |
| Single-document HTML export | Export a standalone HTML file with Lattice branding, inlined images, clickable backlinks, and expanded embeds from the editor |
| Static site export | Generate a deployable `index.html`, Vault-relative note pages, wiki-link navigation, and an `assets/` directory from Settings |
| PWA | The Web build provides a manifest, app-shell caching, install and update prompts; offline writes are not supported |
| Vault backup and restore | In the desktop build, “Settings → Backup & Migration” copies Markdown, Canvas, attachments, templates, and history snapshots into a new timestamped directory with one click; restore by selecting the backup folder. AI API keys are never written into backups |
| Quick switcher | Fuzzy-jump by title with `Ctrl / Cmd + K`, and create a missing title with one action; with attachments shown, results also include attachment files |
| Unresolved links | Mark references to missing notes as unresolved and complete them with one action |
| Personalization | Light / dark themes, background images, custom themes, interface density, font size, content width, and editor preferences |

Keyboard shortcuts: `Ctrl/Cmd+K` quick switcher · `Ctrl/Cmd+N` new note · `Ctrl/Cmd+S` save now · `Ctrl/Cmd+E` toggle edit/preview · `Ctrl/Cmd+Shift+I` capture to Inbox

---

## Quick Start for Development

Regular users can run the released Windows build directly; Node.js and the development commands below are not required.
The following instructions are for development, debugging, and secondary development only.

```bash
# 1. Install dependencies (backend + frontend)
npm run setup

# 2. Initialize the index database (development mode only)
npm run db:migrate

# 3. Optional: seed a linked sample knowledge base
npm run db:seed

# 4. Development mode (backend on 5177; frontend prefers 5173 and auto-increments when busy)
npm run dev
```

Open the frontend address printed in the terminal; when the port is free it is usually <http://localhost:5173>.

### Production mode (single process)

```bash
npm run build     # Build the frontend into web/dist
npm start         # Backend serves the API and frontend static assets
```

Visit <http://127.0.0.1:5177>. The frontend and API are same-origin on this path, so no CORS is involved.

### Release notes

The release provides both a Windows installer and a portable build. Regular users do not need Node.js, a database, or a development environment.
For installation, the first Vault selection, data location, upgrades, and uninstall instructions, read [`使用说明书.md`](../使用说明书.md).

Developers only need to focus on source code, tests, and the development workflow. The exact filenames, download URLs, and release notes for the packaged build are defined by the corresponding release package.

### Configuration

Copy `server/.env.example` to `server/.env` and edit it as needed. All configuration is validated together when the process starts. Any invalid value makes the process exit immediately instead of surfacing only when a request arrives.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `5177` | API listen address |
| `DB_FILE` | `./data/lattice.db` | SQLite file path |
| `VAULT_DIR` | `./data/vault` | Markdown Vault directory |
| `CORS_ORIGINS` | `http://localhost:5173,...` | Allowed frontend origins; production must not use `*` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `AUTO_MIGRATE` | `true` | Automatically apply pending migrations at startup |
| `WORKSPACE_ACCESS_TOKEN` | empty | Required when listening beyond loopback; once set, all `/api` endpoints require `X-Workspace-Token`, with Bearer as a CLI-compatible fallback |
| `WORKSPACE_ACCESS_ROLE` | `editor` | Server role after workspace-token authentication: `viewer` / `editor` / `admin` |
| `AI_ACCESS_TOKEN` | empty | Optional. In addition to workspace authentication, when set, `/api/ai` also requires `Authorization: Bearer <token>` |
| `AI_ACCESS_ROLE` | `editor` | Server role after token authentication: `viewer` / `editor` / `admin` |
| `LATTICE_MCP_ALLOW_WRITES` | `false` | MCP is read-only by default; write tools are exposed only when set to `true`, `1`, or `yes` |
| `AI_SETTINGS_ENCRYPTION_KEY` | empty | Optional. A 32-byte hex/base64 key for encrypting AI settings in SQLite on standalone deployments; the desktop build uses Windows `safeStorage` automatically |
| `AI_CHAT_TIMEOUT_MS` | `120000` | Upstream AI timeout (connectivity tests are fixed at 20 seconds) |
| `AI_ALLOW_PRIVATE_ENDPOINTS` | `false` | AI endpoints pointing at private/loopback addresses are rejected by default (SSRF protection); local-model users can enable this explicitly |
| `AI_DIGEST_HOUR` | empty | Optional local hour from `0` to `23`; when set, the server generates `Journal/Daily Digest YYYY-MM-DD.md` automatically |
| `WEB_DIST_DIR` | `../web/dist` | Frontend build directory; points to the unpacked directory in the desktop build |

Configure external models (chat and embedding) in the model management center. Saving automatically syncs the settings to the local server (the SQLite `ai_settings` table, encrypted at rest in the desktop build). Chat, the semantic-index pipeline, and the CLI share the same configuration; the browser stores only UI cache. The CLI uses the same API and can pass a workspace token through `LATTICE_AI_ACCESS_TOKEN`; once the server token is enabled, the server-side role takes precedence. The browser sends `X-Workspace-Token` automatically from the access token stored in AI settings.
The semantic index is incrementally updated after an embedding model is configured under “Settings → Model Management”. When cloud embedding is enabled, note chunks are sent to that provider.

Vault system folders can be edited under “Settings → Knowledge Base”. Inbox, Daily, and Journal accept only Vault-relative paths, including nested paths such as `Work/Daily`. Saving the profile does not move existing files; it only affects newly created content. Invalid profiles fall back to the defaults. The related endpoints are `GET /api/vault/info` and `PUT /api/vault/profile`.

```bash
npm run ai -- chat "Search project notes"
npm run ai -- preview --file plan.json
npm run ai -- execute --confirm --file plan.json
npm run ai -- history --limit 40
```

### MCP Server

```bash
npm run setup       # The first install also installs MCP dependencies
npm run mcp         # Start the MCP Server over stdio
npm run test:mcp    # Run MCP protocol and read/write e2e tests
```

Clients such as Claude Desktop must configure `scripts/mcp-server/server.mjs` as an stdio command and use `DB_FILE` / `VAULT_DIR` to point to the same data directories as Lattice. MCP is read-only by default; to allow external agents to modify the Vault, explicitly add `LATTICE_MCP_ALLOW_WRITES: "true"` to the configured `env`. Write tools are registered only when the switch is enabled, and writes are recorded in the MCP audit.

---

## Technology Choices and Trade-offs

| Decision | Choice | Reason |
| --- | --- | --- |
| Database driver | Node built-in `node:sqlite` | Zero native dependencies at the database layer, avoiding the difficulty of compiling better-sqlite3 on Windows |
| Chinese search | FTS5 `trigram` tokenizer | The default `unicode61` treats a full Chinese string as one token, so searching for “knowledge” does not match “knowledge management”; trigram indexing uses a three-character sliding window and naturally supports Chinese substring matching |
| Short queries | LIKE fallback | Trigram requires at least three characters, so two-character queries must fall back; an empty FTS result is also checked with LIKE to avoid misses at tokenizer boundaries |
| Graph rendering | Native Canvas, without d3 | The requirements are only drawing points and lines, dragging, and zooming; the size and abstraction cost of a chart library outweighs its benefit |
| Markdown sanitization | In-house allowlist sanitizer | Body content may come from clipped web pages, and direct `innerHTML` would be a real XSS path. Parsing with DOMParser and trimming by an allowlist avoids another dependency |
| Real-time collaboration | Not implemented | A single-machine, single-user scenario has no collaboration requirement; autosave and local state are sufficient without overdesign |
| API authentication | Workspace token plus optional secondary AI token | Loopback addresses can stay in local single-machine mode; listening beyond loopback requires `WORKSPACE_ACCESS_TOKEN`, `AI_ACCESS_TOKEN` can additionally protect AI routes, and roles are fixed by the server |
| Frontend routing | No react-router | Views are handled with internal state, removing a dependency |

---

## Project Structure

```
lattice/
├── server/                          Backend (Express 5 + node:sqlite)
│   ├── src/
│   │   ├── config/                  Centralized environment validation; fail fast at startup
│   │   ├── db/
│   │   │   ├── index.js             Connection pool, WAL, foreign keys, transaction wrapper
│   │   │   ├── migrate.js           Migration runner with checksum drift detection
│   │   │   └── seed.js              Idempotent sample data (programmable call + CLI entry point)
│   │   ├── migrations/              Versioned SQL migrations
│   │   ├── lib/                     Error system, structured logging, Markdown semantic parsing
│   │   ├── middleware/              Request IDs, access logs, CORS, security headers, validation, error handling, workspace auth
│   │   ├── modules/                 Feature-oriented organization, four layers per module
│   │   │   └── notes|folders|files|links|tags|search|graph|canvas|vault|workspace|meta|health/
│   │   │       ├── *.routes.js      Routes + zod boundary validation
│   │   │       ├── *.controller.js  Request/response conversion only
│   │   │       ├── *.service.js     Business rules and transaction orchestration
│   │   │       └── *.repository.js  SQL only
│   │   ├── vault/                   Vault read/write adapter, indexing, watcher, and path sanitization
│   │   ├── app.js                   Middleware assembly; ordering is the security boundary
│   │   └── index.js                 Startup, migrations, graceful shutdown
│   └── test/                        Pure-function unit tests
├── web/                             Frontend (React 18 + Vite 5)
│   ├── public/theme-init.js         Set the theme before first paint (same-origin external file; see CSP below)
│   └── src/
│       ├── api/                     Typed HTTP client + resource access layer
│       ├── hooks/                   Knowledge-base state, debouncing, lightweight notifications
│       ├── lib/                     Markdown pipeline, HTML sanitization, force-directed layout, formatting
│       ├── components/              Sidebar / list / editor / relation panel / graph / canvas / switcher
│       ├── settings/                Settings modal and model management center
│       └── styles.css               Design tokens + dual themes
├── desktop/                         Electron shell (main / preload / backend / menu)
├── scripts/                         Development / smoke scripts, MCP server, and the fc deterministic file assistant
└── website/                         Documentation site, download center, and user guide
```

### Application icon

The mark is a “faceted layered stack”: four rounded squares offset and reduced layer by layer along 45 degrees, each with a downward thickness edge. Eight flat colors create the volume, with no outline and no gradient. `desktop/build/make-icon.py` is the single source of truth; the favicon in `web/index.html` is a simplified version of the same geometry at ≤24px.
**Update both places when changing the mark.**

The script produces **two** `.ico` files. Keep them distinct:

| Artifact | Purpose | Where it is referenced |
|---|---|---|
| `build/icon.ico` | Written into the exe resource section during packaging (File Explorer / shortcuts / installer) | `win.icon` in `electron-builder.yml` |
| `assets/icon.ico` | Runtime window and taskbar icon | `ICON_PATH` in `src/main.js` |

Two files are required because `build/` is electron-builder’s `buildResources` directory and **is not copied into the application**. With only one file, development mode (which runs `electron.exe`) uses Electron’s default icon, and directly running `release/win-unpacked/lattice.exe` may also show the wrong icon.
The script creates both with `copyfile`, so their bytes are identical.

The release window, taskbar, and installer entry point share these icon resources. Update them with the next release after changing the icon.

Three easy traps:

- **Generate the lightness levels at equal intervals in OKLab; do not pick them by hand.** Hand-picking eight colors inevitably pushes some layers together and spreads others too far apart, making a small mark look like “two groups of two layers”. The derivation rules and parameters are in `build/concepts-v6/palette-oklch.py`; it has no dependencies and can be run directly.
- **Use simplified geometry at ≤24px.** Each exposed L shape in the full geometry is only 66 units (1.0px at 16px), so it blurs when reduced. The simplified version uses three layers and a larger lightness range to preserve the recognizable “offset stack”.
- Scale the complete geometry by `MARK_SCALE = 0.92` for delivery. The offsets push the upper-left and lower-right corners outward; delivering at 1.0 looks “edge to edge”. This coefficient only scales the whole mark; it does not alter the geometry.

### An easy trap: CSP blocks the app’s own inline scripts

In production, the backend applies a `script-src 'self'` CSP to HTML (`server/src/app.js`). Therefore `index.html` **must not** contain inline `<script>` tags; they are silently blocked. The first-paint theme logic must live in a same-origin external file such as `web/public/theme-init.js`, and it must not use `type="module"` (module scripts execute later, miss the first paint, and cannot prevent the flash). Development mode has no CSP, so this issue is easy to miss.

### Desktop environment compatibility: two levels of crash recovery

In constrained environments such as virtual machines, remote desktop sessions, and systems with active-defense security software, Chromium’s **child-process sandbox** may fail to initialize. The GPU process can crash repeatedly and eventually terminate the whole application with:
`FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.`
The visible symptom is “I double-clicked it and nothing happened”. `desktop/src/main.js` provides two fallbacks:

1. **GPU recovery**: after three GPU process crashes during one startup, write a marker file and automatically add `--disable-gpu-sandbox` on the next startup. This affects only the GPU process; the main process and embedded backend are unaffected. Machines with working drivers never trigger it.
2. **Renderer crash notice**: after three consecutive renderer crashes, show a dialog explaining the cause and giving the log path instead of leaving the user with a blank screen.

Three additional constraints apply only to the desktop shell:

- **The window background must follow the theme**: after the page loads, write `BrowserWindow`’s `backgroundColor` back from `document.documentElement.dataset.theme`; otherwise dragging the window in a dark theme flashes a white border.
- **External links must leave the app**: `will-navigate` / `setWindowOpenHandler` hand non-local URLs to the system browser so the application window cannot be navigated away.
- **Environment variables must be set before dynamic imports**: `server/src/config` reads and freezes `process.env` on its **first import**, so `DB_FILE` / `WEB_DIST_DIR` / `PORT` must be set before the `import`. Otherwise the defaults are used silently.

### Layering conventions

A single “save note” operation must make three things true at once: the note body is persisted, tag associations match the body, and outgoing links match the body. All three must be atomic, so the operation is centralized in one transaction in `notes.service`: controllers do not touch SQL, services do not depend on `req` / `res`, and repositories only query. This lets later scheduled jobs and scripts reuse the business rules directly.

Links and tags are **data derived from the body**, not independent facts. Every save therefore rebuilds them from the full body instead of applying an incremental diff; the consistency risk introduced by the latter is much greater than its performance benefit.

### Error contract

All failure responses use this shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "in": "body", "field": "name", "message": "Folder name cannot be empty" }],
    "requestId": "8f3a..."
  }
}
```

`requestId` is written to both the response headers and the logs, so failures can be traced directly. 5xx responses never expose stack traces or internal details; they return a generic message.

---

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` `/ready` | Liveness / readiness probes |
| `GET` | `/api/notes` | List notes; supports `folderId` (`__none__` means uncategorized), `tagId`, `inboxStatus` (`all` / `captured` / `processing` / `processed`), `sort`, `limit`, and `offset` |
| `GET` | `/api/notes/index` | Lightweight full index for quick switching and backlink parsing |
| `GET` | `/api/notes/:id` | Details including tags, outgoing links, backlinks, and `contentHash` |
| `POST` | `/api/notes` | Create a note; accepts a client UUID for retry idempotency |
| `PATCH` | `/api/notes/:id` | Partial update (`title` / `content` / `folderId` / `isPinned` / `properties` / `expectedHash`; a version mismatch returns 409) |
| `DELETE` | `/api/notes/:id` | Delete; idempotent |
| `GET` | `/api/notes/templates` | List Markdown templates under Vault `_templates/` |
| `POST` | `/api/notes/from-template` | Create a note from a template; supports `{{date}}` / `{{time}}` / `{{title}}` |
| `POST` | `/api/notes/daily` | Create an idempotent `Daily/YYYY-MM-DD.md` daily note |
| `GET` | `/api/notes/:id/history` etc. | View, preview, and restore note version history (at most the latest 200 snapshots per note) |
| `GET` `POST` `PATCH` `DELETE` | `/api/folders` | Folder tree and create/update/delete operations |
| `GET` `POST` | `/api/files` | Deterministic file assistant: read / find / grep / preview / execute / undo / log (execute requires confirmation; viewers cannot execute) |
| `GET` `DELETE` | `/api/tags` | Tag list with reference counts and deletion |
| `GET` `PUT` `PATCH` | `/api/canvas` | Read, save, and move `.canvas` files in the Vault |
| `GET` | `/api/canvas/files` | List canvas files in the Vault |
| `GET` | `/api/vault/info` | Return the Vault path, mode, and active profile |
| `PUT` | `/api/vault/profile` | Save Vault-relative Inbox / Daily / Journal folders (viewer role cannot write) |
| `GET` | `/api/vault/files` | List all non-note files in the Vault except notes / canvas (data source for the show-attachments toggle) |
| `GET` | `/api/vault/assets` | List image assets available for canvas references |
| `GET` | `/api/vault/asset?path=` | Read an image asset from the Vault |
| `GET` `POST` `DELETE` | `/api/vault/attachments` etc. | List, upload, read, delete, check references to, and clean up orphaned attachments |
| `POST` | `/api/workspace/sse-ticket` | Exchange a long-term token for a one-time SSE ticket valid for 30 seconds (consumed on use) |
| `GET` | `/api/search?q=` | Full-text search; can include `inboxStatus` to limit Inbox state; `meta.strategy` reports whether `fts` or `like` was used |
| `GET` | `/api/graph` | Graph nodes, edges, unresolved references, and statistics |
| `GET` | `/api/meta/overview` | Knowledge-base overview statistics |
| `POST` | `/api/ai/chat` | Non-streaming chat (CLI / compatibility entry point) with source-cited replies, suggestions, and structured operations |
| `POST` | `/api/ai/chat/stream` | Streaming chat (SSE): `meta` → `delta`… → `done`/`error` |
| `GET/PUT` | `/api/ai/settings` | Read / save server model configuration (chat model + embedding) |
| `GET/POST` | `/api/ai/sessions` etc. | List sessions, create sessions, read messages, rename, and delete |
| `GET` | `/api/ai/index/status` · `POST /api/ai/index/reindex` | Semantic-index status and full rebuild |
| `GET` | `/api/ai/related?noteId=` | Related-note recommendations (semantic; requires embedding configuration) |
| `POST` | `/api/ai/retrieval/preview` | Retrieval debugging: keyword and semantic hits plus merged results |
| `POST` | `/api/ai/operations/preview` | Preview file operations, existence, and risks; write operations are marked as requiring confirmation |
| `POST` | `/api/ai/operations/execute` | Execute `read/create/update/delete/move/copy/archive` after role permission and explicit confirmation pass; `archive` only archives files with `type: inbox` and removes the Inbox mark |
| `GET` | `/api/ai/history` | View the AI/CLI file-operation audit history |
| `GET` | `/api/update/check` | Server-side proxy for querying GitHub Releases (desktop update checks) |

---

## Data Model

```
folders ──┬─< folders (parent_id, self-reference)
          └─< notes (folder_id, ON DELETE SET NULL)

notes ──┬─< note_tags >── tags
        ├─< links (source_note_id, ON DELETE CASCADE)
        └─< links (target_note_id, ON DELETE SET NULL → becomes unresolved)
        └── notes_fts (FTS5 virtual table, kept in sync by triggers)
```

`links.target_note_id = NULL` means an **unresolved link**: the link contains `[[reference]]`, but the target note does not exist yet.
When a referenced note is deleted, links pointing to it automatically return to the unresolved state instead of being deleted. The reference relationship therefore does not disappear without a trace.

Migration files record SHA-256 checksums. Editing a historical migration fails immediately, enforcing an “append only, never rewrite” rule.

---

## Testing

```bash
npm test            # Backend unit tests (Markdown and AI-operation boundaries, 36 cases)
npm run test:api    # API smoke tests; backend must already be running (68 cases)
npm run test:web    # Frontend rendering smoke tests; backend must already be running (49 cases)
npm run test:mcp    # MCP stdio protocol and note read/write e2e tests
npm run test:fc     # fc deterministic file assistant unit tests
npm run test:fc:cli # fc CLI smoke tests
npm --prefix desktop test  # Electron shell and packaging contract tests
npm run verify      # Run fc → server → web → mcp-server → desktop in sequence
```

The three layers cover different responsibilities:

1. **Unit tests** — boundary behavior of pure functions; the fastest suite, covering edge cases for tags, backlinks, title inference, and the file assistant
2. **API smoke tests** — call real endpoints with `fetch` and verify status codes, the error contract, the CORS allowlist, and write-operation idempotency
3. **Frontend rendering smoke tests** — bundle and mount the real React component tree in jsdom against the real backend, verify the complete “render → fetch → click → autosave → switch view” path, and assert that the console has no unhandled exceptions

Frontend tests temporarily create a sample note to verify embedded rendering. **Previous leftovers are cleaned up before every run**, and the sample is deleted afterward, so real data is not polluted.

---

## Known Limitations and Next Steps

The current implementation deliberately sets clear boundaries. The following areas are not implemented or still need improvement:

- **Static site export**: Settings → Backup & Migration → Export static site produces `index.html`, note HTML files under their Vault-relative paths, navigable wiki links, expanded embeds, and an `assets/` directory. Windows Desktop and browsers with the File System Access API can write to a selected directory; other browsers fall back to flat downloads.
- **Daily snapshot consolidation is not implemented**: snapshots are already pruned to a 200-per-note cap and identical content is skipped, but consolidation by day for high-frequency editing is not yet available
- **No standalone GUI diff component**: AI file operations already render `preview.diff` as a text block before confirmation, and single actions and batch plans share the same preview/execute contract; a structured diff view inside the workbench is not yet available
- **No real-time collaboration**: single-machine, single-user; WebSocket / CRDT has not been introduced
- **Graph scale**: force-directed layout is O(n²) and smooth for hundreds to thousands of nodes; tens of thousands require a Barnes-Hut approximation
- **`node:sqlite` stability**: Node still marks it as experimental, although it is directly usable. For absolute stability, switch to `better-sqlite3`; the APIs are nearly one-to-one and migration cost is low
- **Mobile / PWA**: narrow layouts are responsive, and the Web build now provides a manifest, app-shell caching, install prompting, and update prompting. Offline mode only makes cached pages readable; API, SSE, and write requests bypass the cache, so offline writes are not supported.

Recommended next step: automatic history retention and cleanup, followed by richer static-export asset and theme options.
