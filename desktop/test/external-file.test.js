'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  findMarkdownFileArg,
  resolveExternalMarkdown,
  readExternalMarkdown,
  writeExternalMarkdown,
} = require('../src/external-file.js');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-external-file-'));
  const vaultDir = path.join(root, 'vault');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  return { root, vaultDir, outsideDir };
}

test('findMarkdownFileArg finds an existing markdown file among Electron arguments', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const filePath = path.join(fixture.outsideDir, '打开我.MD');
  fs.writeFileSync(filePath, '# 测试\n', 'utf8');

  assert.equal(
    findMarkdownFileArg(['electron.exe', '.', '--no-sandbox', filePath]),
    path.resolve(filePath),
  );
});

test('external markdown is read in place and never copied into the Vault', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const filePath = path.join(fixture.outsideDir, '项目说明.md');
  fs.writeFileSync(filePath, '# 项目说明\n\n来自外部文件。\n', 'utf8');

  assert.equal(resolveExternalMarkdown(filePath), path.resolve(filePath));
  assert.equal(readExternalMarkdown(filePath), '# 项目说明\n\n来自外部文件。\n');
  assert.equal(fs.existsSync(path.join(fixture.vaultDir, 'Imported')), false);
});

test('external markdown cannot be written without authorization', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const filePath = path.join(fixture.outsideDir, '只读.md');
  fs.writeFileSync(filePath, '原内容\n', 'utf8');

  assert.throws(() => writeExternalMarkdown(filePath, '不应写入\n'), /获取外部文件写权限/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '原内容\n');
});

test('authorized external markdown writes back to the original file', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const filePath = path.join(fixture.outsideDir, '可写.md');
  fs.writeFileSync(filePath, '原内容\n', 'utf8');

  assert.equal(writeExternalMarkdown(filePath, '新内容\n', { authorized: true }), true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '新内容\n');
});

test('non-markdown and missing paths are rejected', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(() => resolveExternalMarkdown(path.join(fixture.outsideDir, 'readme.txt')), /Markdown/);
  assert.throws(() => resolveExternalMarkdown(path.join(fixture.outsideDir, 'missing.md')), /Markdown/);
});

test('desktop entry point uses tokenized external-file sessions', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

  assert.match(mainSource, /findMarkdownFileArg\(process\.argv\)/);
  assert.match(mainSource, /app\.on\('second-instance', \(_event, commandLine\)/);
  assert.match(mainSource, /createExternalSession\(initialFilePath\)/);
  assert.match(mainSource, /webContents\.send\('lattice:open-external-file'/);
  assert.match(mainSource, /ipcMain\.handle\('external:read'/);
  assert.match(mainSource, /ipcMain\.handle\('external:grant-write'/);
  assert.match(mainSource, /if \(!session\.writeGranted\)/);
  assert.match(mainSource, /ipcMain\.handle\('external:write'/);
});
