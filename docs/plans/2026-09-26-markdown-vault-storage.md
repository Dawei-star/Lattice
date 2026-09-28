# Markdown Vault Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Lattice 的持久化模型改为用户选择的本地文件夹，笔记以 Markdown 文件保存，SQLite 仅作为可重建索引和搜索缓存。

**Architecture:** Electron 主进程负责选择并持久化知识库目录，通过受限 IPC 或启动配置传给内嵌后端。后端新增文件系统 Vault adapter：负责扫描、读取、原子写入、重命名和删除 `.md` 文件；现有业务服务继续通过仓储接口工作，但仓储改为以文件为事实源并重建 SQLite 索引。旧 `lattice.db` 保留为迁移输入，首次选择目录时可导出为 Markdown，不直接删除旧数据。

**Tech Stack:** Electron, Express, Node.js `fs/promises`, Node 内置 `node:sqlite`, React 18, Markdown parser already present in the repository.

---

### Task 1: Vault configuration and path safety

**Files:**
- Create: `server/src/vault/config.js`
- Create: `server/src/vault/path.js`
- Modify: `server/src/config/index.js`
- Test: `server/test/vault-path.test.js`

**Steps:**
1. Add a validated `VAULT_DIR` configuration value, defaulting only for development compatibility.
2. Add path helpers that normalize relative note paths, reject absolute paths, `..` traversal, NUL bytes, and invalid Windows filename characters.
3. Add tests for valid nested paths and traversal/invalid-name rejection.
4. Run `npm --prefix server test`.

### Task 2: Markdown Vault adapter

**Files:**
- Create: `server/src/vault/vault.adapter.js`
- Create: `server/src/vault/markdown.js`
- Create: `server/test/vault-adapter.test.js`

**Steps:**
1. Scan `VAULT_DIR` recursively for `.md` files, ignoring hidden/system directories and the internal metadata directory.
2. Map file path to note id deterministically using frontmatter UUID when present, otherwise generate and persist frontmatter on first import.
3. Read/write frontmatter fields for id, title, pinned state, created and updated timestamps.
4. Implement atomic writes through a temporary file followed by rename.
5. Implement create, read, update, move, rename, delete and full scan operations.
6. Test round-trip content, nested folders, atomic replacement, and external file discovery.

### Task 3: Rebuild index and preserve application contracts

**Files:**
- Create: `server/src/vault/indexer.js`
- Modify: `server/src/modules/notes/notes.repository.js`
- Modify: `server/src/modules/folders/folders.repository.js`
- Modify: `server/src/modules/tags/tags.service.js`
- Modify: `server/src/modules/links/links.service.js`
- Modify: `server/src/index.js`
- Test: `server/test/vault-indexer.test.js`

**Steps:**
1. Rebuild SQLite projection tables from scanned Markdown files at startup and on explicit refresh.
2. Preserve existing API response shapes so the current React application keeps working.
3. Rebuild tags, links, dangling-link state, counts, and FTS from note content.
4. Add a file watcher with debounce and a manual rescan endpoint.
5. Test startup rebuild and external file change refresh.

### Task 4: Desktop vault selection

**Files:**
- Modify: `desktop/src/main.js`
- Modify: `desktop/src/backend.js`
- Create: `desktop/src/vault-ipc.js`
- Modify: `web/src/App.jsx`
- Create: `web/src/api/vault.js`

**Steps:**
1. Add a main-process directory picker using Electron `dialog.showOpenDialog` with `openDirectory`.
2. Expose only `selectVault`, `getVaultInfo`, and `revealVault` through a context-isolated preload bridge.
3. Start the backend with the selected vault directory and show the current path in settings/status UI.
4. Add first-run selection flow while keeping development browser mode functional.
5. Test desktop startup with a temporary directory and verify no arbitrary IPC method is exposed.

### Task 5: SQLite-to-Markdown migration

**Files:**
- Create: `server/src/vault/migrate-sqlite.js`
- Add: `server/src/modules/vault/vault.routes.js`
- Modify: `server/src/routes/index.js`
- Modify: `web/src/settings/SettingsModal.jsx`
- Test: `server/test/vault-migration.test.js`

**Steps:**
1. Export each existing SQLite note to its folder-relative `.md` path with frontmatter.
2. Preserve tags and wiki links in Markdown content; rebuild derived indexes after export.
3. Detect filename collisions and report them without overwriting files.
4. Make migration idempotent and require explicit user confirmation in the UI.
5. Test migration, collision reporting, retry behavior, and preservation of the original database.

### Task 6: Verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/使用说明书.md`
- Modify: `web/test/run-smoke.mjs`
- Modify: `scripts/smoke.mjs`

**Steps:**
1. Update all storage and backup instructions from SQLite-only to Markdown vault behavior.
2. Add smoke coverage for selecting a vault, creating/editing a Markdown note, external file discovery, and migration.
3. Run `npm run verify`, web build, and the desktop packaging verification.
4. Inspect a real temporary vault on disk and confirm note files are readable by Obsidian.

