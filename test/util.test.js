// The two comparisons that decide what stays in an app and what is handed to the browser.
// hasSuffix is security-relevant (a lookalike domain must never pass) and pathUnder is the
// path-scoped app's boundary, so both are pinned here rather than left to inspection.
const test = require('node:test');
const assert = require('node:assert');
const { hasSuffix, pathUnder } = require('../lib/util');

test('hasSuffix accepts the domain and its subdomains', () => {
  assert.equal(hasSuffix('google.com', ['google.com']), true);
  assert.equal(hasSuffix('mail.google.com', ['google.com']), true);
});

test('hasSuffix rejects domains that merely contain the suffix', () => {
  assert.equal(hasSuffix('google.com.evil.com', ['google.com']), false);
  assert.equal(hasSuffix('google.evil.com', ['google.com']), false);
});

test('pathUnder matches the prefix itself and its boundary forms', () => {
  assert.equal(pathUnder('/login', ['/login']), true);
  assert.equal(pathUnder('/login/', ['/login']), true);
  assert.equal(pathUnder('/login.php', ['/login']), true);
});

test('pathUnder does not match a longer path that merely starts with the prefix', () => {
  assert.equal(pathUnder('/logins-of-x', ['/login']), false);
});

test('pathUnder matches deeper paths beneath the prefix', () => {
  assert.equal(pathUnder('/messages/t/1', ['/messages']), true);
});
