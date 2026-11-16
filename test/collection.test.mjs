import test from 'node:test';
import assert from 'node:assert/strict';
import { formFixture } from '../src/form-source.mjs';
import { collect } from '../src/collection.mjs';
import { Inbox } from '../src/store.mjs';

test('草稿写入以回读页为准：nonce 用当前值，成功控件按文档顺序且不合并重复 name', async () => {
  const source = await formFixture();
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.pending.length, 0);
    const pairs = source.submissions[0].fields;
    assert.deepEqual(pairs, [
      ['nonce', '2'],
      ['applicantContact', '王晓明'],
      ['device', '水质仪'],
      ['reference', 'D-007'],
      ['batch', 'B-1'],
      ['channel', 'mail'],
      ['channel', 'sms'],
      ['region', 'east'],
      ['operation', 'draft'],
      ['remarks', '已审核'],
    ]);
    assert.equal(source.submissions[0].path, '/draft');
    assert.equal(source.requests.some(request => request.path === '/formal' || request.path === '/maintenance'), false);
  } finally { store.close(); await source.close(); }
});

test('回执能追到计划、回读页、实际请求体和响应，证据可回到页面节点', async () => {
  const source = await formFixture();
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    const record = result.records[0];
    const evidence = store.evidence();
    const kinds = evidence.map(item => item.kind);
    assert.ok(kinds.includes('form-initial'));
    assert.ok(kinds.includes('form-before-submit'));
    assert.ok(kinds.includes('locator-plan'));
    assert.ok(kinds.includes('draft-request-body'));
    assert.ok(kinds.includes('draft-response'));
    assert.ok(record.evidence.every(id => typeof id === 'string'));
    assert.equal(record.evidence.some(id => typeof id === 'object'), false);

    const planEvidenceId = record.evidence.find(id => evidence.find(item => item.id === id && item.kind === 'locator-plan'));
    assert.ok(planEvidenceId, 'receipt record should reference its locator plan evidence');
    const bodyId = record.evidence.find(id => evidence.find(item => item.id === id && item.kind === 'draft-request-body'));
    const row = store.db.prepare('SELECT body FROM evidence WHERE id=?').get(bodyId);
    const sent = [...new URLSearchParams(Buffer.from(row.body).toString('utf8'))];
    assert.deepEqual(sent, source.submissions[0].fields);

    const planRow = store.db.prepare('SELECT body FROM evidence WHERE id=?').get(planEvidenceId);
    const plan = JSON.parse(Buffer.from(planRow.body).toString('utf8'));
    assert.equal(plan.form.name, '设备申请');
    for (const field of plan.fields) {
      assert.equal(typeof field.node.startOffset, 'number');
      assert.equal(field.node.evidenceId, plan.page.evidenceId);
    }
    assert.ok(plan.form.node.startOffset >= 0);
    assert.equal(plan.form.submitter.accessibleName, '保存');

    const originalRow = store.db.prepare('SELECT body FROM evidence WHERE id=?').get(plan.page.evidenceId);
    const original = Buffer.from(originalRow.body).toString('utf8');
    const contactPlan = plan.fields.find(field => field.accessibleName === '联系人');
    assert.match(original.slice(contactPlan.node.startOffset, contactPlan.node.endOffset), /name="applicantContact"/);
    assert.match(original.slice(contactPlan.name.nodes[0].startOffset, contactPlan.name.nodes[0].endOffset), /联系人/);
    assert.match(original.slice(plan.form.node.startOffset, plan.form.node.endOffset), /aria-labelledby="group-title"/);
    const beforeSubmitRow = store.db.prepare('SELECT body FROM evidence WHERE id=?')
      .get(evidence.find(item => item.kind === 'form-before-submit').id);
    assert.match(Buffer.from(beforeSubmitRow.body).toString('utf8'), /id="contact-2"/);
  } finally { store.close(); await source.close(); }
});

test('只有一个工作项失败时不影响其他工作项', async () => {
  const source = await formFixture();
  source.jobs = [
    ...source.jobs,
    { id: 'missing', formName: '不存在的表单', fields: [], submitterName: '保存' },
  ];
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].jobId, 'application-7');
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0].jobId, 'missing');
    assert.equal(source.submissions.length, 1);
  } finally { store.close(); await source.close(); }
});
