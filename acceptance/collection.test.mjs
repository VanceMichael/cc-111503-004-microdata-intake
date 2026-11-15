import test from 'node:test';
import assert from 'node:assert/strict';
import { formFixture } from '../src/form-source.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await formFixture(scenario);
  const store = new Inbox();
  try { await check(await intake.collect(source, store), source, store); }
  finally { store.close(); await source.close(); }
}

test('表单语义定位后传递真实成功控件及重复字段', async () => {
  await run('normal', async (result, source, store) => {
    assert.equal(result.records.length, 1);
    assert.equal(source.submissions.length, 1);
    const fields = source.submissions[0].fields;
    assert.ok(fields.some(([name, value]) => name === 'applicantContact' && value === '王晓明'));
    assert.ok(fields.some(([name, value]) => name === 'device' && value === '水质仪'));
    assert.deepEqual(fields.filter(([name]) => name === 'channel').map(([, value]) => value), ['mail', 'sms']);
    assert.equal(fields.some(([name]) => ['internal', 'maintenanceContact', 'billingContact'].includes(name)), false);
    assert.ok(fields.some(([name, value]) => name === 'batch' && value === 'B-1'));
    assert.ok(fields.some(([name, value]) => name === 'reference' && value === 'D-007'));
    assert.ok(fields.some(([name, value]) => name === 'remarks' && value === '已审核'));
    assert.ok(fields.some(([name, value]) => name === 'nonce' && value === '2'));
    assert.ok(fields.some(([name, value]) => name === 'operation' && value === 'draft'));
    assert.ok(result.records[0].receipt);
    assert.ok(result.records[0].evidence.length >= 2);
    assert.ok(store.evidence().length >= 3);
    assert.equal(source.requests.some(request => request.path === '/formal'), false);
  });
});

test('布局和 DOM id 变化不改变已确认的提交身份', async () => {
  await run('reordered', async (result, source) => {
    assert.equal(result.records.length, 1);
    assert.equal(source.submissions.length, 1);
  });
});

for (const scenario of ['identity-drift', 'destination-drift', 'ambiguous', 'cycle']) {
  test(`不能可靠定位或确认已变时只交人工处理：${scenario}`, async () => {
    await run(scenario, async (result, source) => {
      assert.equal(result.records.length, 0);
      assert.ok(result.pending.length > 0);
      assert.ok(result.pending[0].reason);
      assert.equal(source.requests.some(request => request.method === 'POST'), false);
    });
  });
}
