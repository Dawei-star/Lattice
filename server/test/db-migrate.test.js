import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { migrationChecksum } from '../src/db/migrate.js';

test('migration checksums are stable across Windows newline conversion', () => {
  const lf = 'ALTER TABLE example ADD COLUMN value TEXT;\n';
  const crlf = lf.replaceAll('\n', '\r\n');

  assert.equal(migrationChecksum(lf), migrationChecksum(crlf));
});

test('historical migration 007 keeps the checksum recorded by existing databases', () => {
  const migrationPath = new URL('../src/migrations/007_ai_session_expert.sql', import.meta.url);
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.equal(migrationChecksum(sql), 'b85ffeff8ca8c079fc8bc0b9821a3263e2ba789a83517e6c48df92bf8953dd74');
});
