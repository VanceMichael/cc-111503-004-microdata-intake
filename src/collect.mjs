import { attribute, document } from './document.mjs';
import { Defect, FormModel } from './form-model.mjs';
import * as model from './form-model.mjs';

const SUPPORTED_ROLES = new Set(['textbox', 'combobox']);

async function fetchPage(source, path, store, phase) {
  const response = await fetch(source.url + path);
  if (!response.ok) throw new Defect('fetch-failed', `${phase} ${path} HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence('form-html', { url: response.url, phase }, bytes);
  const view = document(bytes, response.url);
  return { evidence, view, model: new FormModel(view), finalUrl: response.url };
}

function offset(node) { return node.sourceCodeLocation?.startOffset ?? null; }

function locateForm(page, formName) {
  const matches = [];
  for (const form of page.view.nodes.filter(node => node.tagName === 'form')) {
    if (page.model.formName(form) === formName) matches.push(form); // 名称缺陷在此抛出
  }
  if (matches.length === 0) throw new Defect('form-not-found', `没有名为 "${formName}" 的表单`);
  if (matches.length > 1) throw new Defect('ambiguous-form', `名为 "${formName}" 的表单有 ${matches.length} 个`);
  return matches[0];
}

function locateByName(page, candidates, accessibleName, kind) {
  const matches = [];
  for (const control of candidates) {
    if (page.model.accessibleName(control) === accessibleName) matches.push(control); // 候选名称缺陷在此抛出
  }
  if (matches.length === 0) throw new Defect(`${kind}-not-found`, `表单内没有名为 "${accessibleName}" 的${kind}`);
  if (matches.length > 1) throw new Defect(`ambiguous-${kind}`, `表单内名为 "${accessibleName}" 的${kind}有 ${matches.length} 个，不自动选择`);
  return matches[0];
}

function locateField(page, form, spec) {
  if (!SUPPORTED_ROLES.has(spec.role)) throw new Defect('unsupported-role', `不支持的角色 "${spec.role}"`);
  const candidates = page.model.controlsOf(form).filter(control => model.roleOf(control) === spec.role);
  const control = locateByName(page, candidates, spec.accessibleName, 'field');
  if (page.model.isDisabled(control)) throw new Defect('disabled-target', `"${spec.accessibleName}" 处于禁用状态，不参与写入`);
  if (model.hasAttr(control, 'readonly')) throw new Defect('readonly-target', `"${spec.accessibleName}" 为 readonly，不允许被录入意图覆盖`);
  return control;
}

function locateSubmitter(page, form, submitterName) {
  const candidates = page.model.controlsOf(form).filter(control => model.isSubmitButton(control));
  const control = locateByName(page, candidates, submitterName, 'submitter');
  if (page.model.isDisabled(control)) throw new Defect('disabled-target', `提交按钮 "${submitterName}" 处于禁用状态`);
  return control;
}

function resolveUrl(page, raw) { return new URL(raw, page.view.baseUrl).href; }

function formIdentity(page, form) {
  return {
    name: page.model.formName(form),
    action: resolveUrl(page, attribute(form, 'action') ?? page.finalUrl),
    method: (attribute(form, 'method') ?? 'get').toLowerCase(),
  };
}

function fieldIdentity(page, control, spec) {
  return {
    accessibleName: spec.accessibleName,
    role: spec.role,
    name: attribute(control, 'name') ?? null,
    type: control.tagName === 'input' ? model.inputType(control) : control.tagName,
  };
}

function submitterIdentity(page, control, accessibleName) {
  const formaction = attribute(control, 'formaction');
  return {
    accessibleName,
    name: attribute(control, 'name') ?? null,
    value: attribute(control, 'value') ?? null,
    formaction: formaction !== undefined ? resolveUrl(page, formaction) : null,
    formmethod: attribute(control, 'formmethod')?.toLowerCase() ?? null,
  };
}

// 计划只记录语义身份：名称、角色、提交身份（name/type）、表单所有权与目的地。
// DOM id、标签包装和布局不参与，因此重新排版不会使计划失效。
function buildPlan(page, job) {
  const form = locateForm(page, job.formName);
  const fields = job.fields.map(spec => ({ spec, control: locateField(page, form, spec) }));
  const submitter = locateSubmitter(page, form, job.submitterName);
  return {
    form,
    fields,
    submitter,
    identity: {
      form: formIdentity(page, form),
      fields: fields.map(({ spec, control }) => fieldIdentity(page, control, spec)),
      submitter: submitterIdentity(page, submitter, job.submitterName),
    },
  };
}

function confirmIdentity(plan, confirmation) {
  const before = JSON.stringify(plan.identity);
  const after = JSON.stringify(confirmation.identity);
  if (before === after) return null;
  for (const key of ['form', 'submitter']) {
    if (JSON.stringify(plan.identity[key]) !== JSON.stringify(confirmation.identity[key])) {
      return new Defect(key === 'form' ? 'destination-drift' : 'submitter-drift',
        `${key} 身份变化：${JSON.stringify(plan.identity[key])} → ${JSON.stringify(confirmation.identity[key])}`);
    }
  }
  for (let index = 0; index < plan.identity.fields.length; index += 1) {
    if (JSON.stringify(plan.identity.fields[index]) !== JSON.stringify(confirmation.identity.fields[index])) {
      return new Defect('identity-drift',
        `字段 "${plan.identity.fields[index].accessibleName}" 提交身份变化：`
        + `${JSON.stringify(plan.identity.fields[index])} → ${JSON.stringify(confirmation.identity.fields[index])}`);
    }
  }
  return new Defect('identity-drift', '计划与回读不一致');
}

// 构造成功控件键值对：按文档顺序，遵守禁用、选中与提交按钮语义，重复 name 不合并。
function buildDataset(page, plan, jobValues) {
  const pairs = [];
  const nodes = [];
  for (const control of page.view.nodes) {
    if (!model.isControl(control) || page.model.ownerForm(control) !== plan.form) continue;
    const name = attribute(control, 'name');
    if (name === undefined) continue;
    if (page.model.isDisabled(control)) continue;
    const role = model.roleOf(control);
    if (role === 'file') throw new Defect('unsupported-control', `文件控件 "${name}" 不支持，不猜值`);
    if (role === 'checkbox' || role === 'radio') {
      if (model.hasAttr(control, 'checked')) { pairs.push([name, model.controlValue(control, page.model)]); nodes.push(control); }
      continue;
    }
    if (role === 'button') {
      if (control === plan.submitter && model.isSubmitButton(control)) {
        pairs.push([name, attribute(control, 'value') ?? '']);
        nodes.push(control);
      }
      continue; // 未采用的提交按钮与普通按钮不参与
    }
    if (control.tagName === 'select') {
      const { options, selected } = page.model.optionsOf(control);
      if (jobValues.has(control)) {
        const wanted = jobValues.get(control);
        const match = options.find(option => model.optionValue(option, page.model) === wanted);
        if (!match) throw new Defect('option-mismatch', `下拉选项中没有值 "${wanted}"，不猜值`);
        pairs.push([name, wanted]); nodes.push(control);
      } else {
        for (const option of selected) { pairs.push([name, model.optionValue(option, page.model)]); nodes.push(control); }
      }
      continue;
    }
    pairs.push([name, jobValues.has(control) ? jobValues.get(control) : model.controlValue(control, page.model)]);
    nodes.push(control);
  }
  return pairs.map((pair, index) => ({ pair, node: nodes[index] }));
}

export async function collect(source, store) {
  const records = [];
  const pending = [];
  const jobs = source.jobs || [];
  const failAll = (reason) => { for (const job of jobs) pending.push({ jobId: job.id, reason, evidence: [] }); };

  let initial;
  try { initial = await fetchPage(source, source.pages.initial, store, 'initial'); }
  catch (error) { failAll(error.message); return { mode: 'collect', records, pending }; }

  let beforeSubmit = null;
  const reRead = async () => {
    if (!beforeSubmit) beforeSubmit = await fetchPage(source, source.pages.beforeSubmit, store, 'beforeSubmit');
    return beforeSubmit;
  };

  for (const job of jobs) {
    const evidence = [initial.evidence];
    try {
      const plan = buildPlan(initial, job); // 定位失败（重名、回环、缺失）直接转人工

      const page = await reRead();
      evidence.push(page.evidence);
      const confirmation = buildPlan(page, job);
      const drift = confirmIdentity(plan, confirmation);
      if (drift) throw drift;

      // 提交者 formaction/formmethod 属于确认范围；只允许与来源同源的 /draft。
      const action = confirmation.identity.submitter.formaction ?? confirmation.identity.form.action;
      const method = confirmation.identity.submitter.formmethod ?? confirmation.identity.form.method;
      if (method !== 'post') throw new Defect('unsupported-method', `提交方式 "${method}" 不是 post`);
      const target = new URL(action);
      if (target.origin !== new URL(source.url).origin || target.pathname !== '/draft') {
        throw new Defect('destination-not-allowed', `目标 ${target.href} 不是同源 /draft，不试发`);
      }

      const jobValues = new Map(confirmation.fields.map(({ spec, control }) => [control, spec.value]));
      const dataset = buildDataset(page, confirmation, jobValues);
      const body = new URLSearchParams(dataset.map(entry => entry.pair)).toString();
      const submissionEvidence = store.saveEvidence('draft-submission', {
        jobId: job.id, url: target.href, page: page.evidence,
        fields: dataset.map(({ pair, node }) => ({
          name: pair[0], value: pair[1], offset: offset(node),
          origin: jobValues.has(node) ? 'job' : 'page',
        })),
      }, Buffer.from(body));
      evidence.push(submissionEvidence);

      const response = await fetch(target.href, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const responseBytes = Buffer.from(await response.arrayBuffer());
      evidence.push(store.saveEvidence('draft-response', { jobId: job.id, url: target.href, httpStatus: response.status }, responseBytes));

      let result = null;
      try { result = JSON.parse(responseBytes.toString('utf8')); } catch { /* 非 JSON 回执 */ }
      if (response.status !== 200) throw new Defect('http-unexpected', `草稿端点返回 HTTP ${response.status}`);
      if (result?.status !== 'draft') throw new Defect('non-draft-status', `HTTP 200 但状态为 ${result?.status}，不得交付为成功`);
      if (typeof result.receipt !== 'string' || !result.receipt) throw new Defect('receipt-missing', '回执缺少 receipt');
      if (Array.isArray(result.fields)
        && JSON.stringify(result.fields) !== JSON.stringify(dataset.map(entry => entry.pair))) {
        throw new Defect('echo-mismatch', '服务端回显字段与实际发送不一致');
      }

      store.put('draft-receipts', result.receipt, { jobId: job.id, evidence });
      records.push({ jobId: job.id, receipt: result.receipt, evidence });
    } catch (error) {
      const reason = error instanceof Defect ? error.message : `unexpected: ${error.message}`;
      pending.push({ jobId: job.id, reason, evidence });
    }
  }
  return { mode: 'collect', records, pending };
}
