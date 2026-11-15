import test from 'node:test';
import assert from 'node:assert/strict';
import { formFixture, formPage } from '../src/form-source.mjs';
import { previewForm } from '../src/form-preview.mjs';
import { document, attribute } from '../src/document.mjs';
import { Inbox } from '../src/store.mjs';

test('预览保留控件位置与原页，不宣称已经完成语义录入', async () => {
  const source = await formFixture();
  const store = new Inbox();
  try {
    const result = await previewForm(source, store);
    assert.equal(result.mode, 'form-preview');
    assert.ok(result.controls.some(control => control.name === 'applicantContact'));
    assert.ok(result.controls.every(control => Number.isInteger(control.offset)));
    assert.equal(source.submissions.length, 0);
    assert.equal(store.evidence().length, 1);
  } finally { store.close(); await source.close(); }
});

test('门户只接受新版草稿，保留原始重复字段顺序', async () => {
  const source = await formFixture();
  try {
    const fields = new URLSearchParams([['nonce', '2'], ['applicantContact', '王晓明'], ['operation', 'draft'], ['channel', 'mail'], ['channel', 'sms']]);
    const response = await fetch(source.url + '/draft', { method: 'POST', body: fields });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'draft');
    assert.equal(result.receipt.length, 64);
    assert.deepEqual(result.fields.slice(-2), [['channel', 'mail'], ['channel', 'sms']]);
    const stale = await fetch(source.url + '/draft', { method: 'POST', body: new URLSearchParams({ nonce: '1' }) });
    assert.equal(stale.status, 422);
  } finally { await source.close(); }
});

test('来源区分身份漂移、布局变化和有环的标签引用', () => {
  const original = document(Buffer.from(formPage()), 'http://example.test/form');
  const changed = document(Buffer.from(formPage('identity-drift', 2)), 'http://example.test/form');
  assert.ok(original.nodes.some(node => attribute(node, 'name') === 'applicantContact'));
  assert.ok(changed.nodes.some(node => attribute(node, 'name') === 'billingContact'));
  assert.ok(formPage('cycle').includes('aria-labelledby="loop-b"'));
  assert.ok(formPage('reordered', 2).includes('layout-only'));
});
