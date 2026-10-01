import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/deploy-pages.yml', import.meta.url);
const websiteDirectory = new URL('./', import.meta.url);

test('Pages workflow publishes every static website page', async () => {
  const [workflow, files] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readdir(websiteDirectory),
  ]);
  const pages = files.filter((file) => /^lattice-.*\.html$/.test(file));

  assert.ok(pages.length > 0);
  assert.match(
    workflow,
    /cp\s+website\/lattice-\*\.html\s+website\/download-release\.mjs\s+_site\/website\//,
  );
});
