import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiChatRequest, normalizeAiMimeType, validateAiAttachment } from '../src/lib/ai-attachments.ts';

test('normalizes image and text MIME types from file names', () => {
  assert.equal(normalizeAiMimeType('', 'photo.jpg'), 'image/jpeg');
  assert.equal(normalizeAiMimeType('application/octet-stream', 'photo.jpg'), 'image/jpeg');
  assert.equal(normalizeAiMimeType('image/jpg', 'photo.jpg'), 'image/jpeg');
  assert.equal(normalizeAiMimeType('', 'notes.md'), 'text/markdown');
});

test('rejects unsupported or oversized AI attachments', () => {
  const existing = [];
  assert.match(validateAiAttachment(new File(['x'], 'script.js', { type: 'application/javascript' }), existing), /不支持/);
  assert.match(validateAiAttachment(new File(['xx'], 'huge.png', { type: 'image/png' }), existing, { maxImageBytes: 1 }), /不能超过/);
});

test('keeps text message and carries selected image into the AI request payload', () => {
  const payload = buildAiChatRequest({
    message: '请识别这张图',
    sessionId: 'session-1',
    attachments: [{
      id: 'local-only-id',
      name: 'photo.png',
      type: 'image/png',
      size: 3,
      kind: 'image',
      dataUrl: 'data:image/png;base64,ZmFrZQ==',
    }],
  });

  assert.equal(payload.message, '请识别这张图');
  assert.deepEqual(payload.attachments, [{
    name: 'photo.png',
    type: 'image/png',
    size: 3,
    kind: 'image',
    dataUrl: 'data:image/png;base64,ZmFrZQ==',
  }]);
});
