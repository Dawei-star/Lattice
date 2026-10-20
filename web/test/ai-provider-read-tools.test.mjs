import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderReadTools, providerReadCallFromCheckpoint, providerReadCheckpointDescriptor } from '../src/ai/provider-read-tools.ts';

test('exposes only bounded read tools and binds path scope', () => {
  const tools = createProviderReadTools({ allowedPaths: ['Notes'] });
  assert.deepEqual(tools.map((tool) => tool.name), [
    'lattice_file_read',
    'lattice_note_read',
    'lattice_note_search',
  ]);
  for (const tool of tools) {
    assert.equal(tool.kind, 'read');
    assert.equal(tool.riskLevel, 'L0');
    assert.equal(tool.idempotent, true);
    assert.equal(tool.permission?.requiresScope, true);
  }
  assert.equal(tools[0].inputSchema.properties.limit.maximum, 12_000);
});

test('note read rejects non-markdown paths before transport', async () => {
  const tools = createProviderReadTools({ allowedPaths: ['Notes'] });
  await assert.rejects(
    () => tools[1].execute({ path: 'Notes/data.json' }, { signal: new AbortController().signal, call: { id: 'c1', name: tools[1].name, input: { path: 'Notes/data.json' } } }),
    /Markdown/,
  );
});

test('read tool gateway denies paths outside the current scope', async () => {
  const { executeProviderReadToolCalls } = await import('../src/ai/provider-read-tools.ts');
  const results = await executeProviderReadToolCalls([
    { id: 'c1', name: 'lattice_file_read', input: { path: 'Private/secret.md' } },
  ], { allowedPaths: ['Notes'], runId: 'run-read', signal: new AbortController().signal });
  assert.equal(results[0].status, 'failed');
  assert.match(String(results[0].error), /超出授权路径范围/);
});

test('read checkpoint stores only replayable bounded inputs', () => {
  const descriptor = providerReadCheckpointDescriptor({
    id: 'call-1',
    name: 'lattice_file_read',
    input: { path: 'Notes/a.md', offset: 3, limit: 400, content: 'file body must not persist' },
  });
  assert.deepEqual(descriptor, {
    id: 'provider-read:call-1',
    toolName: 'lattice_file_read',
    callId: 'call-1',
    input: { path: 'Notes/a.md', offset: 3, limit: 400 },
  });
  assert.deepEqual(providerReadCallFromCheckpoint(descriptor), {
    id: 'call-1',
    name: 'lattice_file_read',
    input: { path: 'Notes/a.md', offset: 3, limit: 400 },
  });
  assert.equal(providerReadCheckpointDescriptor({ id: 'call-2', name: 'lattice_note_search', input: { query: '' } }), null);
});

console.log('AI provider read tools tests passed');
