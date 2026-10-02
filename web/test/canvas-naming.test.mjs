import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasDisplayName, toCanvasFileName } from '../src/lib/canvas-naming.js';

test('canvas names keep the extension out of the editor value', () => {
  assert.equal(canvasDisplayName('项目.canvas'), '项目');
  assert.equal(canvasDisplayName('项目.CANVAS'), '项目');
  assert.equal(toCanvasFileName('新画布'), '新画布.canvas');
  assert.equal(toCanvasFileName('新画布.canvas'), '新画布.canvas');
});

test('canvas names reject paths, reserved characters, and empty values', () => {
  assert.equal(toCanvasFileName(''), '');
  assert.equal(toCanvasFileName('   '), '');
  assert.equal(toCanvasFileName('../新画布'), '');
  assert.equal(toCanvasFileName('目录/新画布'), '');
  assert.equal(toCanvasFileName('新:画布'), '');
  assert.equal(toCanvasFileName('..'), '');
});
