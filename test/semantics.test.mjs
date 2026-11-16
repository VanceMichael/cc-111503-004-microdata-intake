import test from 'node:test';
import assert from 'node:assert/strict';
import { document, attribute } from '../src/document.mjs';
import { semanticPage } from '../src/semantics.mjs';

function pageOf(html) {
  return semanticPage(document(Buffer.from(html), 'http://example.test/form'), { evidenceId: 'e1' });
}

test('名称计算区分原生 label、aria-labelledby、隐藏供名与 aria-label', () => {
  const page = pageOf(`<form aria-label="设备申请">
    <label for="a">联系人</label><input id="a" name="contact">
    <span id="h" hidden>设备名称</span><input name="device" aria-labelledby="h">
    <input name="region" aria-label="区域">
    <input name="anonymous">
    <span aria-hidden="true">仅供视觉</span>
  </form>`);
  const byName = name => page.nodes.find(node => attribute(node, 'name') === name);
  assert.equal(page.name(byName('contact')).value, '联系人');
  assert.equal(page.name(byName('device')).value, '设备名称');
  assert.equal(page.name(byName('region')).value, '区域');
  assert.equal(page.name(byName('anonymous')).ok, false);
  const hiddenSpan = page.nodes.find(node => attribute(node, 'aria-hidden') === 'true');
  assert.equal(page.roleOf(byName('contact')), 'textbox');
  assert.equal(page.isHidden(hiddenSpan), true);
});

test('引用缺失、重复 id 与引用回环都不猜测目标', () => {
  const missing = pageOf('<form aria-label="x"><input name="a" aria-labelledby="nope"></form>');
  assert.equal(missing.name(missing.nodes.find(n => attribute(n, 'name') === 'a')).code, 'missing-reference');

  const duplicate = pageOf('<form aria-label="x"><span id="t">A</span><span id="t">B</span><input name="a" aria-labelledby="t"></form>');
  assert.equal(duplicate.name(duplicate.nodes.find(n => attribute(n, 'name') === 'a')).code, 'duplicate-id');

  const cycle = pageOf('<form aria-label="x"><span id="a" aria-labelledby="b"></span><span id="b" aria-labelledby="a"></span><input name="c" aria-labelledby="a"></form>');
  assert.equal(cycle.name(cycle.nodes.find(n => attribute(n, 'name') === 'c')).code, 'reference-cycle');
});

test('表单所有权、disabled fieldset 例外与只读字段按 HTML 规则解释', () => {
  const page = pageOf(`<form id="f" aria-label="申请">
    <fieldset disabled><legend><label>批次<input name="batch"></label></legend>
      <label>内部<input name="internal"></label></fieldset>
    <input name="note" form="f" readonly value="固定">
  </form>
  <label>补充<textarea form="f" name="remarks">已审核</textarea></label>`);
  const form = page.forms()[0];
  const owned = page.ownedControls(form).map(node => attribute(node, 'name'));
  assert.deepEqual(owned, ['batch', 'internal', 'note', 'remarks']);
  const byName = name => page.nodes.find(node => attribute(node, 'name') === name);
  assert.equal(page.isDisabled(byName('batch')), false);
  assert.equal(page.isDisabled(byName('internal')), true);
  assert.equal(page.isReadonly(byName('note')), true);
  assert.equal(page.formOwner(byName('remarks')).form, form);
});

test('select 与 checkbox 的选中状态来自页面声明', () => {
  const page = pageOf(`<form aria-label="x">
    <select name="region"><option value="east" selected>东区</option><option value="west">西区</option></select>
    <input type="checkbox" name="channel" value="mail" checked>
    <input type="checkbox" name="channel" value="sms"></form>`);
  const form = page.forms()[0];
  const select = page.nodes.find(node => attribute(node, 'name') === 'region');
  assert.deepEqual(page.selectedOptions(select).map(option => page.optionValue(option)), ['east']);
  assert.equal(page.roleOf(select), 'combobox');
  assert.equal(page.roleOf(page.nodes.find(node => attribute(node, 'name') === 'channel')), 'checkbox');
});
