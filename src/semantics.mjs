import { attribute } from './document.mjs';

const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const LABELABLE_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const TEXT_SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const TEXTBOX_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
const INPUT_TYPES = new Set([
  'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time',
  'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image',
  'reset', 'button',
]);
const STRUCTURAL_NAME_ERRORS = new Set(['missing-reference', 'duplicate-id', 'reference-cycle']);

export function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function hasAttribute(node, name) {
  return attribute(node, name) !== undefined;
}

export function inputType(control) {
  const type = (attribute(control, 'type') || 'text').toLowerCase();
  return INPUT_TYPES.has(type) ? type : 'text';
}

export function buttonType(control) {
  const type = (attribute(control, 'type') || 'submit').toLowerCase();
  return type === 'reset' || type === 'button' ? type : 'submit';
}

export function location(node) {
  if (!node) return null;
  const source = node.sourceCodeLocation;
  const base = {
    nodeName: node.nodeName,
    tag: node.tagName || null,
    id: node.tagName ? attribute(node, 'id') ?? null : null,
    name: node.tagName ? attribute(node, 'name') ?? null : null,
  };
  if (!source) return base;
  return {
    ...base,
    startOffset: source.startOffset,
    endOffset: source.endOffset,
    startLine: source.startLine,
    startCol: source.startCol,
  };
}

export function isHiddenTree(node) {
  for (let current = node; current; current = current.parentNode) {
    if (current.tagName && isHiddenNode(current)) return true;
  }
  return false;
}

export function isHiddenNode(node) {
  if (!node || !node.tagName) return false;
  if (hasAttribute(node, 'hidden')) return true;
  if ((attribute(node, 'aria-hidden') || '').toLowerCase() === 'true') return true;
  if (node.tagName === 'input' && inputType(node) === 'hidden') return true;
  return false;
}

export function descendants(node, tagName) {
  const result = [];
  function visit(current) {
    for (const child of current.childNodes || []) {
      if (!child.tagName) continue;
      if (child.tagName === tagName) result.push(child);
      visit(child);
    }
  }
  visit(node);
  return result;
}

function isAncestor(ancestor, node) {
  for (let current = node?.parentNode; current; current = current.parentNode) {
    if (current === ancestor) return true;
  }
  return false;
}

function collectText(node, includeHidden, parts) {
  for (const child of node.childNodes || []) {
    if (!child.tagName) {
      if (child.nodeName === '#text') parts.push(child.value);
      continue;
    }
    if (TEXT_SKIP_TAGS.has(child.tagName)) continue;
    if (CONTROL_TAGS.has(child.tagName)) continue;
    if (!includeHidden && isHiddenNode(child)) continue;
    collectText(child, includeHidden, parts);
  }
}

function failure(code, reason, node = null) {
  return { ok: false, code, reason, node };
}

export function rawText(node) {
  const parts = [];
  collectText(node, true, parts);
  return parts.join('');
}

export function textOf(node, { includeHidden = false } = {}) {
  if (!node) return '';
  if (!includeHidden && isHiddenNode(node)) return '';
  const parts = [];
  collectText(node, includeHidden, parts);
  return normalize(parts.join(''));
}

export function contributingNodes(node, includeHidden, result = []) {
  if (!node) return result;
  if (!includeHidden && isHiddenNode(node)) return result;
  if (node.sourceCodeLocation) result.push(node);
  for (const child of node.childNodes || []) {
    if (!child.tagName) {
      if (child.nodeName === '#text' && child.sourceCodeLocation) result.push(child);
      continue;
    }
    if (TEXT_SKIP_TAGS.has(child.tagName)) continue;
    if (CONTROL_TAGS.has(child.tagName)) continue;
    contributingNodes(child, includeHidden, result);
  }
  return result;
}

export class SemanticPage {
  constructor(view, { evidenceId = null, sourceUrl = null } = {}) {
    this.view = view;
    this.nodes = view.nodes;
    this.evidenceId = evidenceId;
    this.sourceUrl = sourceUrl;
    this.byId = new Map();
    for (const node of this.nodes) {
      const id = attribute(node, 'id');
      if (id === undefined) continue;
      const list = this.byId.get(id) || [];
      list.push(node);
      this.byId.set(id, list);
    }
  }

  resolveId(id) {
    const nodes = this.byId.get(id);
    if (!nodes || nodes.length === 0) return failure('missing-reference', `引用 id "${id}" 在页面中不存在`);
    if (nodes.length > 1) return failure('duplicate-id', `引用 id "${id}" 在页面中重复出现 ${nodes.length} 次`);
    return { ok: true, node: nodes[0] };
  }

  firstLabelableDescendant(label) {
    for (const node of this.nodes) {
      if (!isAncestor(label, node)) continue;
      if (node.tagName !== 'label' && this.isLabelable(node)) return node;
    }
    return null;
  }

  labelsFor(control) {
    const id = attribute(control, 'id');
    const labels = [];
    for (const node of this.nodes) {
      if (node.tagName !== 'label') continue;
      if (this.isHidden(node)) continue;
      const forId = attribute(node, 'for');
      if (forId !== undefined) {
        if (forId === '' || id === undefined || forId !== id) continue;
        const owners = this.byId.get(forId) || [];
        if (owners.length > 1) return failure('duplicate-id', `label 的 for 引用 "${forId}" 命中多个元素`, node);
        labels.push(node);
      } else if (isAncestor(node, control)) {
        if (this.firstLabelableDescendant(node) !== control) continue;
        labels.push(node);
      }
    }
    return { ok: true, nodes: labels };
  }

  fromReferences(owner, value, visiting) {
    const tokens = String(value).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return failure('missing-reference', 'aria-labelledby 没有可用的 id 引用', owner);
    const values = [];
    const participants = [];
    for (const token of tokens) {
      const resolved = this.resolveId(token);
      if (!resolved.ok) return failure(resolved.code, `${resolved.reason}（aria-labelledby）`, owner);
      const target = resolved.node;
      if (visiting.has(target)) {
        return failure('reference-cycle', `aria-labelledby 引用回环：${tokens.join(' ')}`, owner);
      }
      const nextVisiting = new Set(visiting);
      nextVisiting.add(target);
      const nested = attribute(target, 'aria-labelledby');
      let part;
      if (nested && nested.trim()) {
        part = this.fromReferences(target, nested, nextVisiting);
      } else {
        const ariaLabel = attribute(target, 'aria-label');
        if (ariaLabel !== undefined && normalize(ariaLabel)) {
          part = { ok: true, value: normalize(ariaLabel), nodes: [target] };
        } else {
          part = {
            ok: true,
            value: textOf(target, { includeHidden: true }),
            nodes: contributingNodes(target, true),
          };
        }
      }
      if (!part.ok) return part;
      if (part.value) values.push(part.value);
      participants.push(...part.nodes);
    }
    const joined = normalize(values.join(' '));
    if (!joined) return failure('empty-reference', 'aria-labelledby 引用的节点没有可供名的文本', owner);
    return { ok: true, value: joined, nodes: participants, source: 'aria-labelledby' };
  }

  name(node) {
    if (!node) return failure('no-accessible-name', '没有可供名的节点');
    const labelledby = attribute(node, 'aria-labelledby');
    if (labelledby && labelledby.trim()) {
      return this.fromReferences(node, labelledby, new Set([node]));
    }
    const ariaLabel = attribute(node, 'aria-label');
    if (ariaLabel !== undefined && normalize(ariaLabel)) {
      return { ok: true, value: normalize(ariaLabel), nodes: [node], source: 'aria-label' };
    }
    if (LABELABLE_TAGS.has(node.tagName)) {
      const labels = this.labelsFor(node);
      if (!labels.ok) return labels;
      if (labels.nodes.length > 0) {
        const values = [];
        const participants = [];
        for (const label of labels.nodes) {
          const labelText = textOf(label);
          if (labelText) values.push(labelText);
          participants.push(...contributingNodes(label, false));
        }
        const value = normalize(values.join(' '));
        if (value) return { ok: true, value, nodes: participants, source: 'label' };
        return failure('no-accessible-name', '原生 label 的文本为空或被隐藏，无法供名', node);
      }
    }
    if (node.tagName === 'button') {
      const value = textOf(node);
      if (value) return { ok: true, value, nodes: contributingNodes(node, false), source: 'contents' };
    }
    if (node.tagName === 'input') {
      const type = inputType(node);
      if (type === 'submit' || type === 'reset' || type === 'button') {
        const value = normalize(attribute(node, 'value') || '');
        if (value) return { ok: true, value, nodes: [node], source: 'value' };
      }
      if (type === 'image') {
        const value = normalize(attribute(node, 'alt') || '');
        if (value) return { ok: true, value, nodes: [node], source: 'alt' };
      }
    }
    return failure('no-accessible-name', '控件没有可计算的 accessible name', node);
  }

  formOwner(control) {
    const explicit = attribute(control, 'form');
    if (explicit !== undefined) {
      const resolved = this.resolveId(explicit);
      if (!resolved.ok) return failure('form-owner-unresolved', `控件的 form 属性无法解析：${resolved.reason}`, control);
      if (resolved.node.tagName !== 'form') {
        return failure('form-owner-unresolved', `控件的 form 属性 "${explicit}" 指向的不是 form 元素`, control);
      }
      return { ok: true, form: resolved.node, explicit: true };
    }
    for (let current = control.parentNode; current; current = current.parentNode) {
      if (current.tagName === 'form') return { ok: true, form: current, explicit: false };
    }
    return { ok: true, form: null, explicit: false };
  }

  forms() {
    return this.nodes.filter(node => node.tagName === 'form');
  }

  ownedControls(form) {
    return this.nodes.filter(node => CONTROL_TAGS.has(node.tagName))
      .filter(node => {
        const owner = this.formOwner(node);
        return owner.ok && owner.form === form;
      });
  }

  isLabelable(control) {
    if (!LABELABLE_TAGS.has(control.tagName)) return false;
    if (control.tagName === 'input' && inputType(control) === 'hidden') return false;
    return true;
  }

  roleOf(control) {
    let native = null;
    if (control.tagName === 'input') {
      const type = inputType(control);
      if (type === 'hidden') native = 'none';
      else if (TEXTBOX_INPUT_TYPES.has(type)) native = 'textbox';
      else if (type === 'checkbox') native = 'checkbox';
      else if (type === 'radio') native = 'radio';
      else if (type === 'submit' || type === 'image') native = 'button';
      else if (type === 'file') native = 'file';
      else native = type;
    } else if (control.tagName === 'textarea') native = 'textbox';
    else if (control.tagName === 'button') native = 'button';
    else if (control.tagName === 'select') {
      const multiple = hasAttribute(control, 'multiple');
      const size = Number(attribute(control, 'size') || 0);
      native = multiple || size > 1 ? 'listbox' : 'combobox';
    }
    const explicit = normalize(attribute(control, 'role') || '');
    if (explicit && explicit !== native) return `custom:${explicit}`;
    return native;
  }

  controlIdentity(control) {
    if (control.tagName === 'input') return `input:${inputType(control)}`;
    if (control.tagName === 'select') return `select:${hasAttribute(control, 'multiple') ? 'multiple' : 'single'}`;
    if (control.tagName === 'button') return `button:${buttonType(control)}`;
    return control.tagName;
  }

  isSubmitter(control) {
    if (control.tagName === 'button') return buttonType(control) === 'submit';
    if (control.tagName === 'input') {
      const type = inputType(control);
      return type === 'submit' || type === 'image';
    }
    return false;
  }

  inFirstLegend(fieldset, control) {
    const firstLegend = (fieldset.childNodes || []).find(node => node.tagName === 'legend');
    if (!firstLegend) return false;
    return isAncestor(firstLegend, control);
  }

  isHidden(control) {
    return isHiddenTree(control);
  }

  isDisabled(control) {
    if (hasAttribute(control, 'disabled')) return true;
    for (let current = control.parentNode; current; current = current.parentNode) {
      if (current.tagName === 'fieldset' && hasAttribute(current, 'disabled')) {
        if (!this.inFirstLegend(current, control)) return true;
      }
    }
    return false;
  }

  isReadonly(control) {
    if (control.tagName !== 'input' && control.tagName !== 'textarea') return false;
    return hasAttribute(control, 'readonly');
  }

  options(select) {
    return descendants(select, 'option');
  }

  isOptionDisabled(option) {
    if (hasAttribute(option, 'disabled')) return true;
    for (let current = option.parentNode; current && current.tagName !== 'select'; current = current.parentNode) {
      if (current.tagName === 'optgroup' && hasAttribute(current, 'disabled')) return true;
    }
    return false;
  }

  optionValue(option) {
    const explicit = attribute(option, 'value');
    return explicit !== undefined ? explicit : normalize(rawText(option));
  }

  selectedOptions(select) {
    const options = this.options(select);
    if (hasAttribute(select, 'multiple')) {
      return options.filter(option => hasAttribute(option, 'selected') && !this.isOptionDisabled(option));
    }
    const selected = options.filter(option => hasAttribute(option, 'selected'));
    const chosen = selected.length > 0 ? selected[selected.length - 1] : options.find(option => !this.isOptionDisabled(option));
    return chosen && !this.isOptionDisabled(chosen) ? [chosen] : [];
  }

  matchOption(select, wanted) {
    const matches = this.options(select).filter(option => !this.isOptionDisabled(option))
      .filter(option => this.optionValue(option) === wanted || normalize(rawText(option)) === wanted);
    if (matches.length === 0) return failure('option-not-found', `combobox 中没有值为 "${wanted}" 的可选 option`, select);
    if (matches.length > 1) return failure('ambiguous-option', `combobox 中有多个值为 "${wanted}" 的可选 option`, select);
    return { ok: true, node: matches[0], value: this.optionValue(matches[0]) };
  }

  submitTarget(form, submitter = null) {
    const rawAction = (submitter && attribute(submitter, 'formaction')) ?? attribute(form, 'action') ?? '';
    let url;
    try {
      url = new URL(rawAction === '' ? this.view.finalUrl : rawAction, this.view.baseUrl);
    } catch {
      return failure('invalid-action', `无法解析表单目标 "${rawAction}"`, form);
    }
    const rawMethod = ((submitter && attribute(submitter, 'formmethod')) ?? attribute(form, 'method') ?? 'get').toLowerCase();
    const method = rawMethod === 'post' || rawMethod === 'get' || rawMethod === 'dialog'
      ? rawMethod
      : 'get';
    return {
      ok: true,
      url: url.href,
      origin: url.origin,
      pathname: url.pathname,
      method,
      action: url.href,
    };
  }
}

export function semanticPage(view, options) {
  return new SemanticPage(view, options);
}

export { STRUCTURAL_NAME_ERRORS };
