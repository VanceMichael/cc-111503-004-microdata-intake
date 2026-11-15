import { document, attribute } from './document.mjs';

export async function preview(source, store) {
  const response = await fetch(source.url + source.path);
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence('html', { url: response.url }, bytes);
  const view = document(bytes, response.url);
  return { mode: 'preview', evidence, baseUrl: view.baseUrl,
    items: view.nodes.filter(node => attribute(node, 'itemscope') !== undefined)
      .map(node => ({ type: attribute(node, 'itemtype'), id: attribute(node, 'itemid') || null,
        offset: node.sourceCodeLocation?.startOffset })) };
}
