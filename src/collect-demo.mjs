import { formFixture } from './form-source.mjs';
import { collect } from './intake.mjs';
import { Inbox } from './store.mjs';

const scenario = process.argv[2] || 'normal';
const source = await formFixture(scenario);
const store = new Inbox();
try {
  const result = await collect(source, store);
  console.log(JSON.stringify({
    scenario,
    result,
    requests: source.requests,
    submissions: source.submissions,
    evidence: store.evidence(),
    drafts: store.list('drafts'),
    pending: store.list('pending'),
  }, null, 2));
} finally { store.close(); await source.close(); }
