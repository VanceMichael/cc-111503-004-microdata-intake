import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/source.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await fixture(scenario); const store = new Inbox();
  try {
    const result = await intake.collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

test('nested entity boundary and shared itemref both retain their owners', async () => {
  await run('normal', async result => {
    assert.equal(result.records.length, 3);
    const machine = result.records.find(row => row.properties.name?.includes('Machine A'));
    assert.ok(machine); assert.deepEqual(machine.properties.alternateName, ['Machine A']);
    assert.equal(machine.properties.url[0].endsWith('/catalog/a'), true);
    assert.equal(machine.properties.manufacturer[0], 'Maker M');
    assert.equal(machine.properties.name.includes('Part P'), false);
    assert.equal(result.records.filter(row => row.itemid === 'urn:unit:A').length, 2);
    assert.ok(result.records.every(row => row.evidence.length > 0));
  });
});
test('shared-reference traversal terminates without global consumption', async () => {
  await run('cycle', async result => {
    const machines = result.records.filter(row => row.itemid === 'urn:unit:A');
    assert.ok(machines.every(row => row.properties.manufacturer[0] === 'Maker M'));
  });
});

test('shared property revisions propagate without turning reordered scopes into new observations', async () => {
  await run('revision', async (result, source) => {
    assert.ok(source.requests.includes('/entry') && source.requests.includes('/r2'));
    assert.equal(result.versions.length, 2);
    const updated = result.changes.filter(row => row.kind === 'updated').map(row => row.observationKey).sort();
    assert.deepEqual(updated, ['device-a', 'observation-b']);
    assert.equal(result.changes.some(row => row.kind === 'added' && row.revision === 'r2'), false);
    const current = result.records.filter(row => row.itemid === 'urn:unit:A');
    assert.ok(current.every(row => row.properties.manufacturer[0] === 'Maker M2'));
    assert.equal(result.versions[0].records.find(row => row.observationKey === 'device-a').properties.manufacturer[0], 'Maker M');
  });
});
