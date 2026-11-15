import test from 'node:test';
import assert from 'node:assert/strict';
import { page, fixture } from '../src/source.mjs';
import { document, attribute } from '../src/document.mjs';
import { preview } from '../src/preview.mjs';
import { Inbox } from '../src/store.mjs';

test('HTML5 parse retains node source ranges and resolves page base', () => {
  const view = document(Buffer.from(page), 'http://example.test/entry');
  assert.equal(view.baseUrl, 'http://example.test/catalog/');
  assert.ok(view.nodes.find(node => attribute(node, 'itemref'))?.sourceCodeLocation);
});
test('preview does not silently collapse repeated itemid observations', async () => {
  const source = await fixture(); const store = new Inbox();
  try { const result = await preview(source, store); assert.equal(result.items.length, 3); assert.equal(store.evidence().length, 1); }
  finally { store.close(); await source.close(); }
});
