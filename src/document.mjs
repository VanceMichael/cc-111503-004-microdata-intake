import { parse } from 'parse5';

export function elements(root) {
  const result = [];
  function visit(node) { if (node.tagName) result.push(node); for (const child of node.childNodes || []) visit(child); }
  visit(root); return result;
}

export function attribute(node, name) { return node.attrs?.find(item => item.name === name)?.value; }
export function document(bytes, finalUrl) {
  const root = parse(bytes.toString('utf8'), { sourceCodeLocationInfo: true });
  const nodes = elements(root);
  const base = nodes.find(node => node.tagName === 'base' && attribute(node, 'href'));
  let baseUrl = finalUrl;
  if (base) { try { baseUrl = new URL(attribute(base, 'href'), finalUrl).href; } catch {} }
  return { root, nodes, baseUrl, finalUrl };
}
