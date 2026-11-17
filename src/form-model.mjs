import { attribute } from './document.mjs';

// 项目限定的网页规则：HTML5 树 + Accessible Name 1.2 子集。
// 不按 CSS 位置或 DOM id 作为业务身份；不支持的名称结构报告缺陷，不猜值。

export class Defect extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const TEXT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button']);

export function isControl(node) { return CONTROL_TAGS.has(node.tagName); }
export function hasAttr(node, name) { return attribute(node, name) !== undefined; }

function collapse(text) { return text.replace(/\s+/g, ' ').trim(); }

export function inputType(node) {
  return (attribute(node, 'type') ?? 'text').toLowerCase().trim() || 'text';
}

export function roleOf(node) {
  if (node.tagName === 'textarea') return 'textbox';
  if (node.tagName === 'select') return hasAttr(node, 'multiple') ? 'listbox' : 'combobox';
  if (node.tagName === 'button') return 'button';
  if (node.tagName === 'input') {
    const type = inputType(node);
    if (type === 'hidden') return 'hidden';
    if (type === 'checkbox' || type === 'radio') return type;
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'file') return 'file';
    if (TEXT_TYPES.has(type)) return 'textbox';
    return 'textbox'; // HTML：未知 type 按 text 状态处理
  }
  return null;
}

export function isSubmitButton(node) {
  if (roleOf(node) !== 'button') return false;
  if (node.tagName === 'input') return inputType(node) === 'submit';
  const type = (attribute(node, 'type') ?? 'submit').toLowerCase().trim();
  return type === 'submit'; // button 缺省 type 即 submit
}

export class FormModel {
  constructor(view) {
    this.view = view;
    this.byId = new Map();
    for (const node of view.nodes) {
      const id = attribute(node, 'id');
      if (id === undefined) continue;
      if (!this.byId.has(id)) this.byId.set(id, []);
      this.byId.get(id).push(node);
    }
  }

  resolveId(id, context) {
    const found = this.byId.get(id) || [];
    if (found.length === 0) throw new Defect('name-reference-missing', `${context} 引用缺失 id "${id}"`);
    if (found.length > 1) throw new Defect('name-reference-duplicate', `${context} 引用重复 id "${id}"`);
    return found[0];
  }

  // 直接引用的隐藏文本可以供名；普通隐藏内容不自动参与。
  textOf(node, { referenced = false, state } = {}) {
    if (!referenced && hasAttr(node, 'hidden')) return '';
    if (hasAttr(node, 'aria-labelledby')) return this.labelledByText(node, state);
    const parts = [];
    const walk = current => {
      for (const child of current.childNodes || []) {
        if (child.nodeName === '#text') { parts.push(child.value); continue; }
        if (!child.tagName) continue;
        if (hasAttr(child, 'hidden')) continue;
        if (isControl(child)) continue; // 标签内嵌控件的值不属于标签文字
        walk(child);
      }
    };
    walk(node);
    return collapse(parts.join(''));
  }

  labelledByText(node, state) {
    const refs = (attribute(node, 'aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const key = node;
    if (state.stack.includes(key)) {
      throw new Defect('name-reference-cycle', `aria-labelledby 引用回环（${refs.join(' ')}）`);
    }
    if (state.seen.has(key)) return ''; // 已访问过的旁支节点按规则跳过
    state.seen.add(key);
    state.stack.push(key);
    try {
      const parts = refs.map(id => this.textOf(this.resolveId(id, 'aria-labelledby'), { referenced: true, state }));
      return collapse(parts.filter(Boolean).join(' '));
    } finally { state.stack.pop(); }
  }

  nativeLabelText(node) {
    const id = attribute(node, 'id');
    const parts = [];
    if (id !== undefined) {
      if ((this.byId.get(id) || []).length > 1) throw new Defect('name-reference-duplicate', `控件 id "${id}" 重复`);
      for (const label of this.view.nodes.filter(n => n.tagName === 'label')) {
        if (attribute(label, 'for') === id) {
          if (hasAttr(label, 'hidden')) continue;
          parts.push(this.textOf(label));
        }
      }
    }
    let parent = node.parentNode;
    while (parent) {
      if (parent.tagName === 'label' && attribute(parent, 'for') === undefined && !hasAttr(parent, 'hidden')) {
        parts.push(this.textOf(parent));
        break; // 最近的包裹 label
      }
      parent = parent.parentNode;
    }
    return collapse(parts.filter(Boolean).join(' '));
  }

  // 名称计算子集：aria-labelledby → aria-label → 原生关联/包裹 label →（按钮）自身文本。
  accessibleName(node) {
    const state = { stack: [], seen: new Set() };
    if (hasAttr(node, 'aria-labelledby')) return this.labelledByText(node, state);
    const ariaLabel = attribute(node, 'aria-label');
    if (ariaLabel !== undefined) return collapse(ariaLabel);
    const labelled = this.nativeLabelText(node);
    if (labelled) return labelled;
    if (node.tagName === 'button' || (node.tagName === 'input' && isSubmitButton(node))) return this.textOf(node);
    return '';
  }

  formName(form) {
    const state = { stack: [], seen: new Set() };
    if (hasAttr(form, 'aria-labelledby')) return this.labelledByText(form, state);
    const ariaLabel = attribute(form, 'aria-label');
    return ariaLabel !== undefined ? collapse(ariaLabel) : '';
  }

  // 表单所有权：显式 form 属性优先于最近祖先 form。
  ownerForm(node) {
    const formAttr = attribute(node, 'form');
    if (formAttr !== undefined) {
      if (formAttr === '') return null;
      const target = this.resolveId(formAttr, 'form 属性');
      return target.tagName === 'form' ? target : null;
    }
    let parent = node.parentNode;
    while (parent) {
      if (parent.tagName === 'form') return parent;
      parent = parent.parentNode;
    }
    return null;
  }

  controlsOf(form) {
    return this.view.nodes.filter(node => isControl(node) && this.ownerForm(node) === form);
  }

  isDisabled(node) {
    if (hasAttr(node, 'disabled')) return true;
    let parent = node.parentNode;
    while (parent) {
      if (parent.tagName === 'fieldset' && hasAttr(parent, 'disabled')) {
        const legend = (parent.childNodes || []).find(child => child.tagName === 'legend');
        const exempt = legend && isDescendant(legend, node);
        if (!exempt) return true; // 首个 legend 下的控件遵守 HTML 例外
      }
      parent = parent.parentNode;
    }
    return false;
  }

  optionsOf(select) {
    const options = this.view.nodes.filter(n => n.tagName === 'option' && isDescendant(select, n));
    const disabled = option => hasAttr(option, 'disabled')
      || (option.parentNode?.tagName === 'optgroup' && hasAttr(option.parentNode, 'disabled'));
    let selected = options.filter(option => hasAttr(option, 'selected'));
    if (selected.length === 0 && !hasAttr(select, 'multiple') && options.length > 0) selected = [options[0]];
    return { options, selected: selected.filter(option => !disabled(option)) };
  }
}

export function isDescendant(ancestor, node) {
  let current = node.parentNode;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode;
  }
  return false;
}

export function optionValue(option, model) {
  const value = attribute(option, 'value');
  return value !== undefined ? value : model.textOf(option);
}

export function controlValue(node, model) {
  if (node.tagName === 'textarea') {
    const raw = (node.childNodes || []).filter(child => child.nodeName === '#text').map(child => child.value).join('');
    return raw.replace(/^\n/, '').replace(/\r\n?/g, '\n');
  }
  const value = attribute(node, 'value');
  if (value !== undefined) return value;
  if (node.tagName === 'input' && ['checkbox', 'radio'].includes(inputType(node))) return 'on';
  return '';
}
