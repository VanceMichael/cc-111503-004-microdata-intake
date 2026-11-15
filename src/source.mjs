import { serve } from './http.mjs';

export const page = `<!doctype html><html><head><base href="/catalog/"></head><body>
<article id="device-a" itemscope itemtype="https://schema.org/Product" itemid="urn:unit:A" itemref="shared">
 <h1 itemprop="name alternateName">Machine A</h1><a itemprop="url" href="a">view</a>
 <section id="part-p" itemscope itemprop="isRelatedTo" itemtype="https://schema.org/Product">
  <meta itemprop="name" content="Part P"><data itemprop="sku" value="P-1">not the sku</data>
 </section>
</article>
<article id="observation-b" itemscope itemtype="https://schema.org/Product" itemid="urn:unit:A" itemref="shared">
 <span itemprop="name">Machine A revised observation</span>
</article>
<aside id="shared"><meta itemprop="manufacturer" content="Maker M"></aside>
</body></html>`;

function revised() {
  const html = page.replace('content="Maker M"', 'content="Maker M2"');
  const second = html.match(/<article id="observation-b"[\s\S]*?<\/article>/)[0];
  return html.replace(second, '').replace('<body>', '<body>' + second);
}

export async function fixture(scenario = 'normal') {
  const requests = [];
  const source = await serve((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/html' });
    let html = request.url === '/r2' ? revised() : page;
    if (scenario === 'cycle') html = html.replace('<body>', '<body id="body">').replace('itemref="shared"', 'itemref="shared body"');
    response.end(html);
  });
  return { ...source, path: '/entry', requests, pageKey: 'repair-catalog',
    revisions: scenario === 'revision'
      ? [{ revision: 'r1', path: '/entry' }, { revision: 'r2', path: '/r2' }]
      : [{ revision: 'r1', path: '/entry' }] };
}
