import { serve } from './http.mjs';

export const page = `<!doctype html><html><head><base href="/catalog/"></head><body>
<article itemscope itemtype="https://schema.org/Product" itemid="urn:unit:A" itemref="shared">
 <h1 itemprop="name alternateName">Machine A</h1><a itemprop="url" href="a">view</a>
 <section itemscope itemprop="isRelatedTo" itemtype="https://schema.org/Product">
  <meta itemprop="name" content="Part P"><data itemprop="sku" value="P-1">not the sku</data>
 </section>
</article>
<article itemscope itemtype="https://schema.org/Product" itemid="urn:unit:A" itemref="shared">
 <span itemprop="name">Machine A revised observation</span>
</article>
<aside id="shared"><meta itemprop="manufacturer" content="Maker M"></aside>
</body></html>`;

export async function fixture(scenario = 'normal') {
  const source = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    const html = scenario === 'cycle'
      ? page.replace('id="shared"', 'id="shared" itemref="shared"') : page;
    response.end(html);
  });
  return { ...source, path: '/entry' };
}
