import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, body, json } from '../src/http.mjs';
import { collect } from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

function formHtml(extra = '', action = '/draft') {
  return `<!doctype html><html><body>
  <form id="application" aria-label="设备申请" action="${action}" method="post">
    <input type="hidden" name="nonce" value="7">
    <label>联系人<input name="applicantContact"></label>
    ${extra}
    <button type="submit" name="operation" value="draft">保存</button>
  </form></body></html>`;
}

function jobs() {
  return [{ id: 'j1', formName: '设备申请', fields: [
    { accessibleName: '联系人', role: 'textbox', value: '王晓明' },
  ], submitterName: '保存' }];
}

async function customSource({ initial = formHtml(), recheck = formHtml(), respond } = {}) {
  const requests = [];
  const submissions = [];
  const source = await serve(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.local');
    requests.push({ method: request.method, path: request.url });
    if (request.method === 'GET' && url.pathname === '/form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(url.searchParams.get('rev') === '2' ? recheck : initial);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/boom') {
      json(response, 500, { status: 'broken' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/draft') {
      const encoded = await body(request);
      submissions.push({ path: url.pathname, fields: [...new URLSearchParams(encoded)] });
      respond(response, encoded);
      return;
    }
    json(response, 409, { status: 'not-a-draft-endpoint' });
  });
  return {
    ...source, requests, submissions, jobs: jobs(),
    pages: { initial: '/form', beforeSubmit: '/form?rev=2' },
  };
}

test('HTTP 200 但响应不是 draft 时不交付成功，只交人工', async () => {
  const source = await customSource({
    recheck: formHtml('', '/draft'),
    respond: (response, encoded) => {
      const fields = [...new URLSearchParams(encoded)];
      json(response, 200, { status: 'rejected', receipt: 'x', fields });
    },
  });
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.records.length, 0);
    assert.equal(result.pending.length, 1);
    assert.match(result.pending[0].reason, /不是 draft|draft/);
    assert.ok(store.evidence().some(item => item.kind === 'draft-response'));
    assert.equal(source.submissions.length, 1);
  } finally { store.close(); await source.close(); }
});

test('表单目标不是同源 /draft 时不发出任何 POST', async () => {
  const source = await customSource({ initial: formHtml('', '/formal'), recheck: formHtml('', '/formal') });
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.records.length, 0);
    assert.ok(result.pending.length > 0);
    assert.match(result.pending[0].reason, /\/draft/);
    assert.equal(source.requests.some(request => request.method === 'POST'), false);
  } finally { store.close(); await source.close(); }
});

test('提交按钮的 formaction 指向正式申报时不借用已确认的计划', async () => {
  const extra = '<button type="submit" name="operation" value="formal" formaction="/formal">正式申报</button>';
  const source = await customSource({ initial: formHtml(extra), recheck: formHtml(extra) });
  source.jobs = [{ id: 'j2', formName: '设备申请', fields: [
    { accessibleName: '联系人', role: 'textbox', value: '王晓明' },
  ], submitterName: '正式申报' }];
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.records.length, 0);
    assert.match(result.pending[0].reason, /\/draft/);
    assert.equal(source.requests.some(request => request.method === 'POST'), false);
  } finally { store.close(); await source.close(); }
});

test('重定向响应不被当作草稿回执接受', async () => {
  const source = await customSource({
    respond: response => {
      response.writeHead(302, { location: '/formal' });
      response.end();
    },
  });
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.records.length, 0);
    assert.equal(source.requests.some(request => request.path === '/formal'), false);
    assert.equal(source.submissions.length, 1);
  } finally { store.close(); await source.close(); }
});

test('提交前回读失败时保留计划证据但仍不发出 POST', async () => {
  const source = await customSource();
  source.pages = { initial: '/form', beforeSubmit: '/boom' };
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.records.length, 0);
    assert.equal(result.pending[0].code, 'recheck-fetch-failed');
    assert.ok(result.pending[0].evidence.length >= 1);
    assert.equal(source.requests.some(request => request.method === 'POST'), false);
  } finally { store.close(); await source.close(); }
});

test('文件控件与提交按钮冲突时转人工，不猜值', async () => {
  const source = await customSource({ initial: formHtml('<input type="file" name="attachment">'), recheck: formHtml('<input type="file" name="attachment">') });
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    assert.equal(result.records.length, 0);
    assert.equal(result.pending[0].code, 'unsupported-control');
    assert.equal(source.requests.some(request => request.method === 'POST'), false);
  } finally { store.close(); await source.close(); }
});

test('字段指向提交按钮或使用不支持的角色时不猜值', async () => {
  const source = await customSource();
  const store = new Inbox();
  try {
    source.jobs = jobs().map(job => ({ ...job, fields: [{ accessibleName: '保存', role: 'button', value: 'draft' }] }));
    const targetingSubmitter = await collect(source, store);
    assert.equal(targetingSubmitter.records.length, 0);
    assert.equal(targetingSubmitter.pending[0].code, 'unsupported-target');

    source.jobs = jobs().map(job => ({ ...job, fields: [{ accessibleName: '联系人', role: 'listbox', value: '王晓明' }] }));
    const unsupportedRole = await collect(source, store);
    assert.equal(unsupportedRole.records.length, 0);
    assert.equal(unsupportedRole.pending[0].code, 'unsupported-role');
    assert.equal(source.requests.some(request => request.method === 'POST'), false);
  } finally { store.close(); await source.close(); }
});
