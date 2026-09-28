'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isInternalUrl, isSafeExternalUrl } = require('../src/url-security.js');

test('accepts a URL with the application origin', () => {
  assert.equal(isInternalUrl('http://127.0.0.1:5188/notes/1', 'http://127.0.0.1:5188/'), true);
});

test('rejects userinfo URLs that only start with the application URL', () => {
  assert.equal(isInternalUrl('http://127.0.0.1:5188@evil.com/', 'http://127.0.0.1:5188/'), false);
});

test('rejects malformed and cross-origin URLs', () => {
  assert.equal(isInternalUrl('https://evil.com/', 'http://127.0.0.1:5188/'), false);
  assert.equal(isInternalUrl('not a url', 'http://127.0.0.1:5188/'), false);
});

test('allows http and https external URLs', () => {
  assert.equal(isSafeExternalUrl('https://obsidian.md/'), true);
  assert.equal(isSafeExternalUrl('http://example.com/a?b=1'), true);
});

test('rejects non-http schemes handed to the operating system', () => {
  assert.equal(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isSafeExternalUrl('ms-msdownload:abc'), false);
  assert.equal(isSafeExternalUrl('vbscript:msgbox(1)'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('not a url'), false);
});
