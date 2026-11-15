import { formFixture } from './form-source.mjs';
import { previewForm } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await formFixture();
const store = new Inbox();
try {
  const result = await previewForm(source, store);
  console.log(JSON.stringify({ result, requests: source.requests, evidence: store.evidence() }, null, 2));
} finally { store.close(); await source.close(); }
