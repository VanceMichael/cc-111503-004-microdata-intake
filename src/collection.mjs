import { document, attribute } from './document.mjs';
import {
  semanticPage, location, normalize, inputType, rawText,
  STRUCTURAL_NAME_ERRORS,
} from './semantics.mjs';

const SUPPORTED_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'button']);
const DRAFT_PATH = '/draft';

function storeEvidence(store, kind, metadata, bytes) {
  return store.saveEvidence(kind, metadata, bytes);
}

function nodeRef(page, node) {
  return { evidenceId: page.evidenceId, ...(location(node) || {}) };
}

function refsFor(page, nodes) {
  const seen = new Set();
  const result = [];
  for (const node of nodes || []) {
    const ref = nodeRef(page, node);
    const key = `${ref.evidenceId}:${ref.startOffset}:${ref.endOffset}:${ref.nodeName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function excerpt(page, node, limit = 240) {
  const source = node?.sourceCodeLocation;
  if (!source || typeof page.html !== 'string') return '';
  return normalize(page.html.slice(source.startOffset, source.endOffset)).slice(0, limit);
}

function nameEvidence(page, nameResult) {
  if (!nameResult || !nameResult.ok) return null;
  return {
    source: nameResult.source,
    value: nameResult.value,
    nodes: refsFor(page, nameResult.nodes),
  };
}

function fail(code, reason, { evidence = [], candidates = [], diagnostics = [] } = {}) {
  return { ok: false, code, reason, evidence, candidates, diagnostics };
}

function formName(page, form) {
  return page.name(form);
}

export function locateForm(page, wanted) {
  const entries = page.forms().map(form => ({ form, name: formName(page, form) }));
  const matches = entries.filter(entry => entry.name.ok && entry.name.value === wanted);
  const diagnostics = entries.filter(entry => !entry.name.ok && STRUCTURAL_NAME_ERRORS.has(entry.name.code))
    .map(entry => ({ code: entry.name.code, reason: entry.name.reason, node: nodeRef(page, entry.form) }));
  if (matches.length === 0) {
    return fail('form-not-found', `没有可按语义名称 "${wanted}" 唯一定位的表单`, {
      diagnostics,
      candidates: entries.filter(entry => entry.name.ok)
        .map(entry => ({ formName: entry.name.value, node: nodeRef(page, entry.form) })),
    });
  }
  if (matches.length > 1) {
    return fail('ambiguous-form', `有 ${matches.length} 个同名的 "${wanted}" 表单，无法确定目标`, {
      candidates: matches.map(entry => ({ formName: entry.name.value, node: nodeRef(page, entry.form) })),
    });
  }
  const entry = matches[0];
  return {
    ok: true,
    form: entry.form,
    formName: entry.name.value,
    formNameEvidence: nameEvidence(page, entry.name),
    evidence: refsFor(page, entry.name.nodes),
  };
}

function targetPolicy(target, sourceOrigin) {
  if (target.method !== 'post') {
    return { ok: false, code: 'unsupported-method', reason: `草稿只能以 POST 提交，当前目标方法为 ${target.method}` };
  }
  if (target.origin !== sourceOrigin) {
    return { ok: false, code: 'cross-origin', reason: `草稿目标 ${target.origin} 与来源 ${sourceOrigin} 不同源` };
  }
  if (target.pathname !== DRAFT_PATH) {
    return { ok: false, code: 'non-draft-action', reason: `只允许提交到同源 ${DRAFT_PATH}，当前目标路径为 ${target.pathname}` };
  }
  return { ok: true };
}

function controlKey(page, control) {
  return [attribute(control, 'name') ?? '', page.controlIdentity(control)].join('|');
}

function submittedValue(page, control) {
  if (control.tagName === 'button') return attribute(control, 'value') ?? '';
  if (control.tagName === 'input') return attribute(control, 'value') ?? '';
  return '';
}

function submitterKey(page, control) {
  return [attribute(control, 'name') ?? '', page.controlIdentity(control), submittedValue(page, control)].join('|');
}

function currentTextValue(page, control) {
  if (control.tagName === 'textarea') return rawText(control);
  return attribute(control, 'value') ?? '';
}

function isChecked(control) {
  return attribute(control, 'checked') !== undefined;
}

function assessFieldValue(page, control, role, intended) {
  if (role === 'textbox') {
    const current = currentTextValue(page, control);
    const readonly = page.isReadonly(control);
    if (readonly) {
      if (intended !== undefined && intended !== current) {
        return {
          ok: false,
          code: 'readonly-target',
          reason: `只读字段 "${intended}" 不能被录入意图覆盖（页面当前值 "${current}"）`,
        };
      }
      return { ok: true, value: current, override: null, current };
    }
    return {
      ok: true,
      value: intended !== undefined ? intended : current,
      override: intended !== undefined ? intended : null,
      current,
    };
  }
  if (role === 'combobox') {
    const selected = page.selectedOptions(control);
    const selectedValues = selected.map(option => page.optionValue(option));
    const selectedTexts = selected.map(option => normalize(rawText(option)));
    if (intended !== undefined && !selectedValues.includes(intended) && !selectedTexts.includes(intended)) {
      return {
        ok: false,
        code: 'option-intent-mismatch',
        reason: `combobox 的已选 option 为 ${JSON.stringify(selectedValues)}，与已确认值 "${intended}" 不一致`,
      };
    }
    return { ok: true, value: selectedValues[0] ?? '', override: null, current: selectedValues };
  }
  if (role === 'checkbox' || role === 'radio') {
    const value = attribute(control, 'value') ?? 'on';
    const checked = isChecked(control);
    if (intended !== undefined) {
      const matches = checked && (intended === value || intended === 'true' || intended === 'on');
      const matchesUnchecked = !checked && (intended === 'false' || intended === '');
      if (!matches && !matchesUnchecked) {
        return {
          ok: false,
          code: 'state-intent-mismatch',
          reason: `控件的页面声明状态（checked=${checked}, value="${value}"）与已确认值 "${intended}" 不一致`,
        };
      }
    }
    return { ok: true, value: checked ? value : null, override: null, current: checked };
  }
  return { ok: true, value: submittedValue(page, control), override: null, current: submittedValue(page, control) };
}

function submitterCandidates(page, form) {
  return page.ownedControls(form).filter(control => page.isSubmitter(control) && !page.isHidden(control));
}

function locateSubmitter(page, form, wanted) {
  const candidates = submitterCandidates(page, form);
  const image = candidates.find(control => control.tagName === 'input' && inputType(control) === 'image');
  if (image) {
    return fail('unsupported-submitter', '图像提交按钮不产生稳定的提交身份，不支持', {
      candidates: [{ node: nodeRef(page, image), excerpt: excerpt(page, image) }],
    });
  }
  const diagnostics = [];
  const matches = [];
  for (const control of candidates) {
    const name = page.name(control);
    if (!name.ok) {
      diagnostics.push({ code: name.code, reason: name.reason, node: nodeRef(page, control) });
      continue;
    }
    if (name.value === wanted) matches.push({ control, name });
  }
  if (matches.length === 1 && diagnostics.length === 0) {
    if (page.isDisabled(matches[0].control)) {
      return fail('submitter-disabled', `提交按钮 "${wanted}" 已禁用，不能作为提交者`, {
        candidates: [{ node: nodeRef(page, matches[0].control), excerpt: excerpt(page, matches[0].control) }],
      });
    }
    return { ok: true, ...matches[0] };
  }
  if (matches.length > 1) {
    return fail('ambiguous-submitter', `表单内有 ${matches.length} 个可访问名称为 "${wanted}" 的提交按钮`, {
      candidates: matches.map(match => ({ node: nodeRef(page, match.control), excerpt: excerpt(page, match.control) })),
    });
  }
  if (diagnostics.length > 0) {
    return fail('uncertain-submitter', '提交按钮的名称计算无法确定，不能自动选择', {
      diagnostics,
      candidates: candidates.map(control => ({ node: nodeRef(page, control), excerpt: excerpt(page, control) })),
    });
  }
  return fail('submitter-not-found', `表单内没有可访问名称为 "${wanted}" 的提交按钮`, {
    candidates: candidates.map(control => ({ node: nodeRef(page, control), excerpt: excerpt(page, control) })),
  });
}

export function buildPlan(page, job) {
  if (!job || typeof job !== 'object' || typeof job.formName !== 'string') {
    return fail('invalid-job', '工作项缺少 formName');
  }
  if (!Array.isArray(job.fields)) return fail('invalid-job', '工作项缺少 fields');
  for (const field of job.fields) {
    if (!field || typeof field.accessibleName !== 'string' || typeof field.role !== 'string') {
      return fail('invalid-job', '字段意图缺少 accessibleName 或 role');
    }
    if (!SUPPORTED_ROLES.has(field.role)) {
      return fail('unsupported-role', `不支持的角色 "${field.role}"，不猜测控件`);
    }
  }

  const located = locateForm(page, job.formName);
  if (!located.ok) return located;
  const form = located.form;
  const formRef = nodeRef(page, form);
  const formExcerpt = excerpt(page, form, 120);

  const submitter = locateSubmitter(page, form, job.submitterName);
  if (!submitter.ok) return { ...submitter, evidence: [...located.evidence, ...submitter.evidence] };

  const effective = page.submitTarget(form, submitter.control);
  if (!effective.ok) return fail(effective.code, effective.reason, { evidence: located.evidence });
  const policy = targetPolicy(effective, new URL(page.view.finalUrl).origin);
  if (!policy.ok) return fail(policy.code, policy.reason, { evidence: located.evidence });

  const controls = page.ownedControls(form).filter(control => page.isLabelable(control) && !page.isHidden(control));
  const fileControl = controls.find(control => control.tagName === 'input' && inputType(control) === 'file'
    && !page.isDisabled(control) && attribute(control, 'name') !== undefined);
  if (fileControl) {
    return fail('unsupported-control', '表单包含文件控件，文件控件不受支持，不猜测提交值', {
      evidence: located.evidence,
      candidates: [{ node: nodeRef(page, fileControl), excerpt: excerpt(page, fileControl) }],
    });
  }
  const diagnostics = [];
  const named = [];
  for (const control of controls) {
    const name = page.name(control);
    if (!name.ok) {
      if (STRUCTURAL_NAME_ERRORS.has(name.code)) {
        diagnostics.push({ code: name.code, reason: name.reason, node: nodeRef(page, control) });
      }
      continue;
    }
    named.push({ control, name, role: page.roleOf(control) });
  }
  const structuralDiagnostics = diagnostics;
  if (structuralDiagnostics.length > 0) {
    return fail('uncertain-name', '表单内存在标签引用缺失、重复 id 或引用回环，名称无法确定，不能把相同文字当成目标', {
      evidence: located.evidence,
      diagnostics: structuralDiagnostics,
    });
  }

  const plannedFields = [];
  const plannedTargets = new Set();
  for (const field of job.fields) {
    const matches = named.filter(entry => entry.name.value === field.accessibleName && entry.role === field.role);
    const roleMismatches = named.filter(entry => entry.name.value === field.accessibleName && entry.role !== field.role);
    if (matches.length === 0) {
      return fail('field-not-found', `表单 "${job.formName}" 内没有可访问名称为 "${field.accessibleName}"、角色为 ${field.role} 的控件`, {
        evidence: located.evidence,
        candidates: roleMismatches.map(entry => ({
          node: nodeRef(page, entry.control),
          excerpt: excerpt(page, entry.control),
          role: entry.role,
        })),
      });
    }
    if (matches.length > 1) {
      return fail('ambiguous-field', `有 ${matches.length} 个可访问名称为 "${field.accessibleName}"、角色为 ${field.role} 的候选控件，不能把相同文字当成同一目标`, {
        evidence: located.evidence,
        candidates: matches.map(entry => ({
          node: nodeRef(page, entry.control),
          excerpt: excerpt(page, entry.control),
          name: entry.name.value,
          role: entry.role,
        })),
      });
    }
    const match = matches[0];
    const control = match.control;
    if (page.isSubmitter(control)) {
      return fail('unsupported-target', `字段 "${field.accessibleName}" 命中的是提交按钮，不能作为录入字段`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    if (plannedTargets.has(control)) {
      return fail('duplicate-intent', `工作项对同一控件重复给出录入意图：${field.accessibleName}`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    plannedTargets.add(control);
    if (page.isDisabled(control)) {
      return fail('disabled-field', `字段 "${field.accessibleName}" 对应的控件已禁用，不能写入`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    if (attribute(control, 'name') === undefined || attribute(control, 'name') === '') {
      return fail('unnamed-field', `字段 "${field.accessibleName}" 的控件没有 name，不能作为成功控件提交`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    const value = assessFieldValue(page, control, field.role, field.value);
    if (!value.ok) {
      return fail(value.code, value.reason, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    plannedFields.push({
      accessibleName: field.accessibleName,
      role: field.role,
      nameAttribute: attribute(control, 'name'),
      controlKey: controlKey(page, control),
      controlIdentity: page.controlIdentity(control),
      intendedValue: field.value,
      planValue: value.value,
      overrideValue: value.override,
      initialCurrent: value.current,
      readonly: page.isReadonly(control),
      node: nodeRef(page, control),
      excerpt: excerpt(page, control),
      name: nameEvidence(page, match.name),
    });
  }

  const submitterInfo = {
    accessibleName: submitter.name.value,
    submitterKey: submitterKey(page, submitter.control),
    nameAttribute: attribute(submitter.control, 'name') ?? null,
    valueAttribute: attribute(submitter.control, 'value') ?? null,
    controlIdentity: page.controlIdentity(submitter.control),
    node: nodeRef(page, submitter.control),
    excerpt: excerpt(page, submitter.control),
    name: nameEvidence(page, submitter.name),
  };

  return {
    ok: true,
    plan: {
      jobId: job.id,
      formName: job.formName,
      page: { url: page.view.finalUrl, evidenceId: page.evidenceId },
      form: {
        name: job.formName,
        node: formRef,
        excerpt: formExcerpt,
        nameEvidence: located.formNameEvidence,
        ...effective,
        submitter: submitterInfo,
      },
      fields: plannedFields,
      evidence: [
        ...located.evidence,
        ...plannedFields.flatMap(field => field.name.nodes.map(node => node.evidenceId)),
      ],
    },
  };
}

function findControlsByKey(page, form, key) {
  return page.ownedControls(form).filter(control => !page.isHidden(control) && controlKey(page, control) === key);
}

function findSubmitter(page, form, plan) {
  const wanted = plan.form.submitter;
  const candidates = submitterCandidates(page, form);
  const named = candidates.map(control => ({ control, name: page.name(control) }));
  const structural = named.filter(entry => !entry.name.ok && STRUCTURAL_NAME_ERRORS.has(entry.name.code));
  if (structural.length > 0) {
    return fail('uncertain-submitter', '回读页上提交按钮的名称计算无法确定，不能沿用旧确认', {
      diagnostics: structural.map(entry => ({
        code: entry.name.code, reason: entry.name.reason, node: nodeRef(page, entry.control),
      })),
    });
  }
  const byKey = candidates.filter(control => submitterKey(page, control) === wanted.submitterKey);
  if (byKey.length === 1) {
    if (page.isDisabled(byKey[0])) {
      return fail('submitter-changed', `回读页上的提交按钮 "${wanted.accessibleName}" 已禁用，旧确认无效`, {
        candidates: [{ node: nodeRef(page, byKey[0]), excerpt: excerpt(page, byKey[0]) }],
      });
    }
    const currentName = page.name(byKey[0]);
    if (!currentName.ok || currentName.value !== wanted.accessibleName) {
      return fail('submitter-changed', `回读页上提交按钮的可访问名称已经变化，旧确认无效`, {
        candidates: [{ node: nodeRef(page, byKey[0]), excerpt: excerpt(page, byKey[0]) }],
      });
    }
    return { ok: true, control: byKey[0] };
  }
  if (byKey.length > 1) {
    const narrowed = named.filter(entry => byKey.includes(entry.control) && entry.name.ok && entry.name.value === wanted.accessibleName);
    if (narrowed.length === 1) return { ok: true, control: narrowed[0].control };
    return fail('submitter-ambiguous', '回读页上有多个同身份的提交按钮，不能沿用旧确认', {
      candidates: byKey.map(control => ({ node: nodeRef(page, control), excerpt: excerpt(page, control) })),
    });
  }
  const sameIdentity = candidates.find(control => page.controlIdentity(control) === wanted.controlIdentity);
  return fail('submitter-changed', sameIdentity
    ? '提交按钮的提交身份（name 或 value）已变化，旧确认无效'
    : `回读页上找不到已确认的提交按钮 "${wanted.accessibleName}"`, {
    candidates: candidates.map(control => ({ node: nodeRef(page, control), excerpt: excerpt(page, control) })),
  });
}

export function verifyPlan(page, plan) {
  const located = locateForm(page, plan.formName);
  if (!located.ok) {
    return { ...located, code: 'form-changed', reason: `回读页无法再按名称定位表单：${located.reason}` };
  }
  const form = located.form;
  const submitter = findSubmitter(page, form, plan);
  if (!submitter.ok) return { ...submitter, evidence: located.evidence };

  const effective = page.submitTarget(form, submitter.control);
  if (!effective.ok) return fail(effective.code, effective.reason, { evidence: located.evidence });
  if (effective.url !== plan.form.url || effective.method !== plan.form.method) {
    return fail('destination-changed',
      `提交目的地或方法已变化（计划 ${plan.form.method} ${plan.form.url}，当前 ${effective.method} ${effective.url}），旧确认无效`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, submitter.control), excerpt: excerpt(page, submitter.control) }],
      });
  }
  const policy = targetPolicy(effective, new URL(page.view.finalUrl).origin);
  if (!policy.ok) return fail(policy.code, policy.reason, { evidence: located.evidence });

  const controls = page.ownedControls(form).filter(control => page.isLabelable(control) && !page.isHidden(control));
  const diagnostics = controls.map(control => ({ control, name: page.name(control) }))
    .filter(entry => !entry.name.ok && STRUCTURAL_NAME_ERRORS.has(entry.name.code));
  if (diagnostics.length > 0) {
    return fail('uncertain-name', '回读页存在无法确定名称的控件，不能沿用旧确认继续提交', {
      evidence: located.evidence,
      diagnostics: diagnostics.map(entry => ({
        code: entry.name.code, reason: entry.name.reason, node: nodeRef(page, entry.control),
      })),
    });
  }

  const resolved = [];
  for (const field of plan.fields) {
    let candidates = findControlsByKey(page, form, field.controlKey);
    if (candidates.length > 1) {
      candidates = candidates.filter(control => {
        const name = page.name(control);
        return name.ok && name.value === field.accessibleName;
      });
    }
    if (candidates.length === 0) {
      return fail('field-changed', `字段 "${field.accessibleName}"（name="${field.nameAttribute}"）的身份或所属表单已变化，旧确认无效`, {
        evidence: located.evidence,
        candidates: page.ownedControls(form).filter(control => attribute(control, 'name') === field.nameAttribute)
          .map(control => ({ node: nodeRef(page, control), excerpt: excerpt(page, control) })),
      });
    }
    if (candidates.length > 1) {
      return fail('field-ambiguous', `回读页上有多个与字段 "${field.accessibleName}" 同身份的控件，不能沿用旧确认`, {
        evidence: located.evidence,
        candidates: candidates.map(control => ({ node: nodeRef(page, control), excerpt: excerpt(page, control) })),
      });
    }
    const control = candidates[0];
    if (page.roleOf(control) !== field.role || page.controlIdentity(control) !== field.controlIdentity) {
      return fail('field-type-changed', `字段 "${field.accessibleName}" 的角色或类型已变化，旧确认无效`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    const currentName = page.name(control);
    if (!currentName.ok || currentName.value !== field.accessibleName) {
      return fail('field-identity-changed', `字段 "${field.accessibleName}" 的可访问名称已经变化，旧确认无效`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    if (page.isDisabled(control)) {
      return fail('field-disabled', `字段 "${field.accessibleName}" 在回读页上已禁用，旧确认无效`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    if (field.readonly !== page.isReadonly(control)) {
      return fail('field-readonly-changed', `字段 "${field.accessibleName}" 的只读状态已经变化，旧确认无效`, {
        evidence: located.evidence,
        candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
      });
    }
    if (field.readonly) {
      const current = currentTextValue(page, control);
      if (current !== field.initialCurrent) {
        return fail('readonly-value-changed', `只读字段 "${field.accessibleName}" 的值已变化，旧确认不能覆盖`, {
          evidence: located.evidence,
          candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
        });
      }
    }
    if (field.role === 'combobox' || field.role === 'checkbox' || field.role === 'radio') {
      const state = assessFieldValue(page, control, field.role, field.intendedValue);
      if (!state.ok) {
        return fail(state.code, `回读页的选项状态与已确认意图不一致：${state.reason}`, {
          evidence: located.evidence,
          candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
        });
      }
      if (JSON.stringify(state.current) !== JSON.stringify(field.initialCurrent)) {
        return fail('option-state-changed', `字段 "${field.accessibleName}" 的页面选中状态已变化，旧确认无效`, {
          evidence: located.evidence,
          candidates: [{ node: nodeRef(page, control), excerpt: excerpt(page, control) }],
        });
      }
    }
    resolved.push({ planField: field, control });
  }

  return { ok: true, form, submitter: submitter.control, fields: resolved, evidence: located.evidence };
}

function changeEntry(page, control, adoptedSubmitter, overrides) {
  const name = attribute(control, 'name');
  if (name === undefined || name === '') return [];
  if (page.isDisabled(control)) return [];
  const tag = control.tagName;
  if (tag === 'button' || (tag === 'input' && (inputType(control) === 'submit' || inputType(control) === 'image'))) {
    if (control !== adoptedSubmitter) return [];
    return [[name, submittedValue(page, control)]];
  }
  if (tag === 'input') {
    const type = inputType(control);
    if (type === 'reset' || type === 'button') return [];
    if ((type === 'checkbox' || type === 'radio') && !isChecked(control)) return [];
  }
  if (tag === 'select') {
    return page.selectedOptions(control).map(option => [name, page.optionValue(option)]);
  }
  const value = overrides.has(control) ? overrides.get(control) : currentTextValue(page, control);
  if (tag === 'input' && (inputType(control) === 'checkbox' || inputType(control) === 'radio')) {
    return [[name, attribute(control, 'value') ?? 'on']];
  }
  return [[name, value]];
}

export function serializeForm(page, form, adoptedSubmitter, overrides) {
  const controls = page.ownedControls(form);
  const file = controls.find(control => control.tagName === 'input' && inputType(control) === 'file'
    && !page.isDisabled(control) && attribute(control, 'name') !== undefined);
  if (file) {
    return fail('unsupported-control', '表单包含文件控件，文件控件不受支持，不猜测提交值', {
      candidates: [{ node: nodeRef(page, file), excerpt: excerpt(page, file) }],
    });
  }
  const pairs = [];
  for (const control of controls) pairs.push(...changeEntry(page, control, adoptedSubmitter, overrides));
  return { ok: true, pairs };
}

const FETCH_TIMEOUT = 10000;

async function fetchPage(source, path) {
  const url = new URL(path, source.url).href;
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { url: response.url || url, status: response.status, ok: response.ok, bytes };
}

function readPage(fetched, kind, store) {
  const evidenceId = storeEvidence(store, kind, { url: fetched.url, status: fetched.status }, fetched.bytes);
  const html = fetched.bytes.toString('utf8');
  const view = document(fetched.bytes, fetched.url);
  const page = semanticPage(view, { evidenceId, sourceUrl: fetched.url });
  page.html = html;
  return page;
}

function evidenceIds(entries) {
  const ids = [];
  for (const entry of entries || []) {
    if (typeof entry === 'string') ids.push(entry);
    else if (entry && typeof entry === 'object' && typeof entry.evidenceId === 'string') ids.push(entry.evidenceId);
  }
  return [...new Set(ids)];
}

function pendingEntry(job, failure) {
  return {
    jobId: job.id ?? null,
    reason: failure.reason,
    code: failure.code ?? null,
    evidence: evidenceIds(failure.evidence),
    ...(failure.candidates?.length ? { candidates: failure.candidates } : {}),
    ...(failure.diagnostics?.length ? { diagnostics: failure.diagnostics } : {}),
  };
}

async function submitDraft(target, pairs, job, planEvidence, evidenceIds, store) {
  const encoded = new URLSearchParams(pairs).toString();
  const sentPairs = [...new URLSearchParams(encoded)];
  const bodyEvidence = storeEvidence(store, 'draft-request-body', {
    jobId: job.id, url: target.url, planEvidence,
  }, Buffer.from(encoded));
  const response = await fetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encoded,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const responseEvidence = storeEvidence(store, 'draft-response', {
    jobId: job.id, url: response.url || target.url, status: response.status,
    contentType: response.headers.get('content-type') || null,
  }, bytes);
  const evidence = [...new Set([...evidenceIds, bodyEvidence, responseEvidence])];
  if (response.status !== 200) {
    return { ok: false, code: 'draft-http-status', reason: `草稿端点返回 HTTP ${response.status}，未产生有效草稿回执`, evidence };
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, code: 'invalid-draft-response', reason: '草稿端点返回的不是可解析的 JSON，未产生有效草稿回执', evidence };
  }
  if (parsed.status !== 'draft') {
    return { ok: false, code: 'not-a-draft', reason: `响应状态为 "${parsed.status}"，HTTP 200 但不是 draft，不得交付为成功`, evidence };
  }
  if (typeof parsed.receipt !== 'string' || parsed.receipt.length === 0) {
    return { ok: false, code: 'missing-receipt', reason: '响应缺少草稿回执 receipt，不得交付为成功', evidence };
  }
  if (Array.isArray(parsed.fields) && JSON.stringify(parsed.fields) !== JSON.stringify(sentPairs)) {
    return { ok: false, code: 'receipt-fields-mismatch', reason: '回执中的字段列表与实际送出的成功控件不一致', evidence };
  }
  return { ok: true, receipt: parsed.receipt, fields: sentPairs, encoded, evidence };
}

export async function collect(source, store) {
  const jobs = Array.isArray(source.jobs) ? source.jobs : [];
  const records = [];
  const pending = [];

  let initialPage;
  let initialEvidence;
  try {
    const fetched = await fetchPage(source, source.pages.initial);
    if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`);
    initialPage = readPage(fetched, 'form-initial', store);
    initialEvidence = initialPage.evidenceId;
  } catch (error) {
    for (const job of jobs) {
      const entry = pendingEntry(job, { code: 'initial-fetch-failed', reason: `无法读取形成定位计划的页面：${error.message}` });
      pending.push(entry);
      store.put('pending', String(job.id ?? 'unknown'), entry);
    }
    return { records, pending };
  }

  async function recheck() {
    try {
      const fetched = await fetchPage(source, source.pages.beforeSubmit);
      if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`);
      return { ok: true, page: readPage(fetched, 'form-before-submit', store) };
    } catch (error) {
      return { ok: false, code: 'recheck-fetch-failed', reason: `提交前回读页面失败：${error.message}` };
    }
  }

  for (const job of jobs) {
    const collected = [];
    let planEvidence = null;
    const jobId = String(job?.id ?? 'unknown');
    const persistPending = (failure) => {
      const entry = pendingEntry(job, failure);
      pending.push(entry);
      store.put('pending', jobId, entry);
    };
    try {
      const built = buildPlan(initialPage, job);
      if (!built.ok) {
        persistPending({
          ...built,
          evidence: [initialEvidence, ...(built.evidence || [])],
        });
        continue;
      }
      const plan = built.plan;
      plan.evidence = evidenceIds([initialEvidence, plan.page.evidenceId, ...(plan.evidence || [])]);
      planEvidence = storeEvidence(store, 'locator-plan', { jobId: job.id, url: plan.page.url },
        Buffer.from(JSON.stringify(plan)));
      plan.evidence = evidenceIds([...plan.evidence, planEvidence]);
      collected.push(planEvidence);

      const checked = await recheck();
      if (!checked.ok) {
        persistPending({ ...checked, evidence: plan.evidence });
        continue;
      }
      const recheckPage = checked.page;
      const verified = verifyPlan(recheckPage, plan);
      if (!verified.ok) {
        persistPending({
          ...verified,
          evidence: [...plan.evidence, recheckPage.evidenceId, ...(verified.evidence || [])],
        });
        continue;
      }

      const overrides = new Map();
      for (const entry of verified.fields) {
        if (entry.planField.overrideValue !== null && entry.planField.overrideValue !== undefined) {
          overrides.set(entry.control, entry.planField.overrideValue);
        }
      }
      const serialized = serializeForm(recheckPage, verified.form, verified.submitter, overrides);
      if (!serialized.ok) {
        persistPending({
          ...serialized,
          evidence: [...plan.evidence, recheckPage.evidenceId, ...(serialized.evidence || [])],
        });
        continue;
      }
      const target = recheckPage.submitTarget(verified.form, verified.submitter);
      const policy = targetPolicy(target, new URL(recheckPage.view.finalUrl).origin);
      if (!policy.ok) {
        persistPending({ ...policy, evidence: [...plan.evidence, recheckPage.evidenceId] });
        continue;
      }
      const sent = await submitDraft(target, serialized.pairs, job, planEvidence,
        [...plan.evidence, recheckPage.evidenceId], store);
      if (!sent.ok) {
        persistPending(sent);
        continue;
      }
      const record = { jobId: job.id, receipt: sent.receipt, evidence: evidenceIds([...sent.evidence, planEvidence]) };
      records.push(record);
      store.put('drafts', jobId, {
        jobId: job.id, receipt: sent.receipt, fields: sent.fields, encoded: sent.encoded,
        target: target.url, evidence: record.evidence, planEvidence,
      });
    } catch (error) {
      persistPending({
        code: 'internal-error',
        reason: `工作项处理失败：${error.message}`,
        evidence: [initialEvidence, ...collected],
      });
    }
  }

  return { records, pending };
}
