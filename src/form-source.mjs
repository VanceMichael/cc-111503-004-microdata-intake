import { createHash } from 'node:crypto';
import { serve, body, json } from './http.mjs';

export function formPage(scenario = 'normal', revision = 1) {
  const ambiguous = scenario === 'ambiguous' ? '<label>联系人<input name="alternateContact"></label>' : '';
  const cyclic = scenario === 'cycle' ? '<span id="loop-a" aria-labelledby="loop-b"></span><span id="loop-b" aria-labelledby="loop-a"></span><input name="uncertain" aria-labelledby="loop-a">' : '';
  const drift = scenario === 'identity-drift' && revision === 2;
  const destination = scenario === 'destination-drift' && revision === 2 ? '/other-draft' : '/draft';
  const contactName = drift ? 'billingContact' : 'applicantContact';
  const controls = `<div id="group-title">设备申请</div>
  <form id="application" aria-labelledby="group-title" action="${destination}" method="post">
    <input type="hidden" name="nonce" value="${revision}">
    <label for="contact-${revision}">联系人</label><input id="contact-${revision}" name="${contactName}">
    <span id="device-title" hidden>设备名称</span><input name="device" aria-labelledby="device-title">
    <input name="reference" value="D-007" readonly>
    <fieldset disabled><legend><label>批次<input name="batch" value="B-1"></label></legend>
      <label>内部备注<input name="internal" value="不应发送"></label></fieldset>
    <input type="checkbox" name="channel" value="mail" checked><input type="checkbox" name="channel" value="sms" checked>
    <input type="checkbox" name="channel" value="fax">
    <select name="region"><option value="east" selected>东区</option><option value="west">西区</option></select>
    <button type="submit" name="operation" value="draft">保存</button>
    <button type="submit" name="operation" value="formal" formaction="/formal">正式申报</button>
    ${ambiguous}${cyclic}
  </form>
  <label>补充说明<textarea form="application" name="remarks">已审核</textarea></label>
  <form id="maintenance" aria-label="维保登记" action="/maintenance" method="post">
    <label>联系人<input name="maintenanceContact" value="维修值班员"></label><button>保存</button>
  </form>`;
  const content = scenario === 'reordered' && revision === 2
    ? controls.replace('<label for="contact-2">联系人</label>', '<span class="layout-only"></span><label for="contact-2">联系人</label>')
    : controls;
  return '<!doctype html><html><head><base href="/"></head><body>' + content + '</body></html>';
}

export async function formFixture(scenario = 'normal') {
  const requests = [];
  const submissions = [];
  const source = await serve(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.local');
    requests.push({ method: request.method, path: request.url });
    if (request.method === 'GET' && url.pathname === '/form') {
      const revision = Number(url.searchParams.get('revision') || 1);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(formPage(scenario, revision));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/draft') {
      const encoded = await body(request);
      const fields = [...new URLSearchParams(encoded)];
      submissions.push({ path: url.pathname, fields, contentType: request.headers['content-type'] });
      const values = new Map(fields);
      const accepted = values.get('nonce') === '2' && values.get('operation') === 'draft'
        && values.has('applicantContact') && !values.has('maintenanceContact') && !values.has('internal');
      if (!accepted) { json(response, 422, { status: 'rejected', fields }); return; }
      const receipt = createHash('sha256').update(encoded).digest('hex');
      json(response, 200, { status: 'draft', receipt, fields });
      return;
    }
    json(response, 409, { status: 'not-a-draft-endpoint' });
  });
  return {
    ...source, requests, submissions,
    pages: { initial: '/form?revision=1', beforeSubmit: '/form?revision=2' },
    jobs: [{ id: 'application-7', formName: '设备申请', fields: [
      { accessibleName: scenario === 'cycle' ? '未知字段' : '联系人', role: 'textbox', value: '王晓明' },
      { accessibleName: '设备名称', role: 'textbox', value: '水质仪' },
    ], submitterName: '保存' }],
  };
}
