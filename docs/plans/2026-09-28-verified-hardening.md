# Verified Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the confirmed security, data-integrity, and destructive-file-operation defects identified in the 2026-09-28 repository analysis.

**Architecture:** Keep Markdown as the source of truth, but persist each note's actual relative `file_path` in the SQLite projection. Use exact-origin checks for Electron navigation, recursive sanitization for unknown HTML elements, and explicit protection for non-Markdown assets when deleting folders. Add focused regression tests before implementation.

**Tech Stack:** Node.js 22, Express, Node SQLite, React, jsdom, Electron main-process CommonJS.

---

### Task 1: Add regression tests for confirmed defects [x]

**Files:**
- Create: `web/test/sanitize.test.mjs`
- Create: `desktop/src/url-security.js`
- Create: `desktop/test/url-security.test.js`
- Modify: `web/package.json`
- Modify: `desktop/package.json`

Write tests for recursive HTML sanitization, exact-origin URL validation, and same-origin userinfo bypass rejection.

### Task 2: Close the two direct security holes [x]

**Files:**
- Modify: `web/src/lib/sanitize.js`
- Modify: `desktop/src/main.js`

Recursively clean children before unwrapping unknown elements and compare parsed URL origins instead of string prefixes.

### Task 3: Preserve actual Markdown paths and prevent same-name collisions [x]

**Files:**
- Create: `server/src/migrations/002_note_file_path.sql`
- Modify: `server/src/vault/indexer.js`
- Modify: `server/src/modules/notes/notes.repository.js`
- Modify: `server/src/modules/notes/notes.service.js`
- Modify: `web/src/api/vault-files.js`

Store the source-relative path in `notes.file_path`, allocate a unique path for new notes, use the stored path for reads/updates/deletes, and migrate folder/title changes atomically.

### Task 4: Harden frontmatter, Canvas corruption, and folder deletion [x]

**Files:**
- Modify: `server/src/vault/markdown.js`
- Modify: `server/src/modules/canvas/canvas.service.js`
- Modify: `server/src/modules/folders/folders.service.js`

Reject or normalize control characters in serialized frontmatter, return a validation error for malformed Canvas JSON, and move non-Markdown assets to the vault root before removing a folder.

### Task 5: Verify [x]

Run:

```bash
npm --prefix server test
npm --prefix web run test
npm run build
```

Then run the API smoke test when the local server is available and inspect `git diff`/`git status` to ensure no unrelated changes were touched.
