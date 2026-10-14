import assert from 'node:assert/strict';
import { splitNativeDocument, createNativeDocument } from '../src/api/native-document.ts';

const raw = '---\r\nid: 123\r\ntags:\r\n  - test\r\n---\r\n# Text\r\n[[Link]]\r\n';
const { prefix, content } = splitNativeDocument(raw);
assert.equal(prefix + content, raw);
assert.equal(content, '# Text\r\n[[Link]]\r\n');
assert.deepEqual(splitNativeDocument('# Plain\n'), { prefix: '', content: '# Plain\n' });
assert.match(createNativeDocument('New note'), /^---\nid: [0-9a-f-]+\ntitle: New note\n/);
