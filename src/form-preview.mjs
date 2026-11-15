import { document, attribute } from './document.mjs';

export async function previewForm(source, store) {
  const response = await fetch(source.url + source.pages.initial);
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence('form-html', { url: response.url }, bytes);
  const view = document(bytes, response.url);
  return {
    mode: 'form-preview', evidence,
    controls: view.nodes.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tagName))
      .map(node => ({ tag: node.tagName, name: attribute(node, 'name'), offset: node.sourceCodeLocation?.startOffset })),
  };
}
