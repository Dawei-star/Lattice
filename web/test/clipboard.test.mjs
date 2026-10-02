import assert from 'node:assert/strict';
import test from 'node:test';
import { createClipboardImageFile, getClipboardImageFiles } from '../src/lib/clipboard.js';

const timestamp = new Date(2026, 9, 1, 12, 34, 56).getTime();

test('creates a timestamped image file with the clipboard mime extension', () => {
  const source = new File(['png'], 'clipboard', { type: 'image/png' });
  const result = createClipboardImageFile(source, source.type, timestamp);

  assert.equal(result.name, 'img-20261001123456.png');
  assert.equal(result.type, 'image/png');
});

test('filters non-images and suffixes multiple pasted images', () => {
  const clipboardData = {
    items: [
      { type: 'text/plain', getAsFile: () => new File(['text'], 'text.txt', { type: 'text/plain' }) },
      { type: 'image/jpeg', getAsFile: () => new File(['jpg'], 'one', { type: 'image/jpeg' }) },
      { type: 'image/webp', getAsFile: () => new File(['webp'], 'two', { type: 'image/webp' }) },
    ],
  };

  const result = getClipboardImageFiles(clipboardData, timestamp);

  assert.deepEqual(result.map((file) => file.name), [
    'img-20261001123456.jpg',
    'img-20261001123456-2.webp',
  ]);
  assert.deepEqual(result.map((file) => file.type), ['image/jpeg', 'image/webp']);
});

test('ignores image formats unsupported by the attachment API', () => {
  const result = getClipboardImageFiles({
    items: [{
      type: 'image/x-icon',
      getAsFile: () => new File(['icon'], 'clipboard', { type: 'image/x-icon' }),
    }],
  }, timestamp);

  assert.deepEqual(result, []);
});

test('falls back to the file mime when clipboard item type is empty', () => {
  const result = getClipboardImageFiles({
    items: [{
      type: '',
      getAsFile: () => new File(['gif'], 'clipboard', { type: 'image/gif' }),
    }],
  }, timestamp);

  assert.equal(result[0]?.name, 'img-20261001123456.gif');
});
