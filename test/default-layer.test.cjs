'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const layerDefinition = require('../src/resources/layers/cursor-default.json');
const { cursorLayer } = require('../src/resources/layers/platform.cjs');
const mappings = require('../docs/input-mappings.json');

test('default layer maps controls and preserves the unused microphone switch', () => {
  assert.deepEqual(layerDefinition.devices, ['codex_micro', 'creator_micro_v2', 'creator_micro_v2_base', 'creator_micro_v2_pro']);
  const byKeycode = new Map(layerDefinition.smartActions.map((action) => [`SA_${action.id}`, action]));
  const ids = layerDefinition.smartActions.map((action) => action.payload.id);
  assert.equal(ids.length, 10); assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith('cursor.')), 'API identifiers use the Cursor namespace');
  for (const action of layerDefinition.smartActions) assert.equal(action.type, 'API');
  const resolve = (key) => key.keycode === 'KC_NONE' ? null : byKeycode.get(key.keycode)?.payload.id ?? mappings.nativeActions.find((action) => action.keycode === key.keycode)?.control;
  assert.deepEqual(layerDefinition.layer.layout.base.map((row) => row.map(resolve)), mappings.base);
  assert.deepEqual(layerDefinition.layer.layout.encoders.map((row) => row.map(resolve)), mappings.encoders);
  const resolveKeycode = (keycode) => byKeycode.get(keycode)?.payload.id ?? mappings.nativeActions.find((action) => action.keycode === keycode)?.control;
  assert.deepEqual(layerDefinition.layer.layout.joystick.sectors.map((sector) => resolveKeycode(sector.k)), Object.values(mappings.joystick));
  assert.deepEqual(layerDefinition.layer.layout.base.map((row) => row.length), [2, 4, 4, 3]);
  assert.deepEqual(layerDefinition.layer.layout.encoders.map((row) => row.length), [3]);
  assert.equal(layerDefinition.layer.layout.joystick.type, 'RADIAL');
  assert.equal(layerDefinition.layer.layout.base[3][1].keycode, 'KC_NONE');
});
test('Windows layer uses the Windows OS and Control-based Cursor shortcuts', () => {
  const windows = cursorLayer('win32');
  assert.deepEqual(windows.os, [1]);
  assert.equal(windows.layer.os, 1);
  assert.ok(windows.actions.every((action) => action.os === 1));
  for (const id of [2, 3, 4]) {
    const action = windows.actions.find((item) => item.id === id);
    assert.ok(action);
    assert.equal(action.keyInputs[0].keycode, 'KC_LCTL');
    assert.equal(action.keyInputs.at(-1).keycode, 'KC_LCTL');
    assert.equal(action.keyInputs.some((input) => input.keycode === 'KC_LGUI'), false);
  }
  const microphone = windows.actions.find((item) => item.id === 1);
  assert.deepEqual(microphone.keyInputs.map((input) => input.keycode), ['KC_LCTL', 'KC_M']);
});
test('native Cursor shortcuts and every imported action are configured correctly', () => {
  const microphone = layerDefinition.layer.layout.base[3][0].keycode;
  const action = layerDefinition.actions.find((action) => `KA_${action.id}` === microphone);
  assert.ok(action, 'microphone uses a firmware action, not an API click');
  assert.deepEqual(action.keyInputs, [
    { keycode: 'KC_LCTL', delay: 0, actionType: 1 },
    { keycode: 'KC_M', delay: 0, actionType: 1 },
  ]);
  assert.equal(layerDefinition.layer.layout.base[3][2].keycode, 'KC_ENT');
  assert.equal(layerDefinition.layer.layout.encoders[0][2].keycode, 'KC_ENT');
  assert.equal(layerDefinition.smartActions.some((item) => item.payload.id === 'cursor.command.send'), false);
  assert.equal(layerDefinition.smartActions.some((item) => item.payload.id === 'cursor.dial.press'), false);
  const approve = layerDefinition.actions.find((item) => `KA_${item.id}` === layerDefinition.layer.layout.base[2][1].keycode);
  assert.deepEqual(approve?.keyInputs, [
    { keycode: 'KC_LGUI', delay: 0, actionType: 1 },
    { keycode: 'KC_ENT', delay: 0, actionType: 1 },
    { keycode: 'KC_LGUI', delay: 0, actionType: 0 },
  ]);
  assert.equal(layerDefinition.layer.layout.base[2][2].keycode, 'KC_ESC');
  assert.equal(layerDefinition.smartActions.some((item) => ['cursor.command.approve', 'cursor.command.decline'].includes(item.payload.id)), false);
  const newChat = layerDefinition.actions.find((item) => `KA_${item.id}` === layerDefinition.layer.layout.base[2][0].keycode);
  assert.deepEqual(newChat?.keyInputs, [
    { keycode: 'KC_LGUI', delay: 0, actionType: 1 },
    { keycode: 'KC_N', delay: 0, actionType: 1 },
    { keycode: 'KC_LGUI', delay: 0, actionType: 0 },
  ]);
  assert.equal(layerDefinition.smartActions.some((item) => item.payload.id === 'cursor.command.fast'), false);
  const modelPicker = layerDefinition.actions.find((item) => `KA_${item.id}` === layerDefinition.layer.layout.base[2][3].keycode);
  assert.deepEqual(modelPicker?.keyInputs, [
    { keycode: 'KC_LGUI', delay: 0, actionType: 1 },
    { keycode: 'KC_SLSH', delay: 0, actionType: 1 },
    { keycode: 'KC_LGUI', delay: 0, actionType: 0 },
  ]);
  assert.equal(layerDefinition.layer.layout.joystick.sectors[0].k, 'KC_UP');
  assert.equal(layerDefinition.layer.layout.joystick.sectors[2].k, 'KC_DOWN');
  assert.equal(layerDefinition.smartActions.some((item) => ['cursor.command.fork', 'cursor.stick.up', 'cursor.stick.down'].includes(item.payload.id)), false);
  for (const [items, groups] of [['actions', 'actionGroups'], ['multiactions', 'multiactionGroups'], ['smartActions', 'smartActionGroups']]) {
    const expected = new Set(layerDefinition[items].map((action) => action.id));
    const members = layerDefinition[groups].filter((group) => group.name === 'Cursor').flatMap((group) => group.actionIds);
    assert.deepEqual(new Set(members), expected, `all ${items} are in Cursor without dangling group members`);
    assert.equal(members.length, expected.size, 'no duplicate group members');
  }
  for (const definition of [layerDefinition, cursorLayer('darwin'), cursorLayer('win32')]) {
    assert.deepEqual(definition.layer.lights, { backlight: { effect: 0 }, underglow: { effect: 0 } }, 'layer lighting is off on both sides');
    for (const group of [...definition.actionGroups, ...definition.multiactionGroups, ...definition.smartActionGroups]) {
      assert.equal(group.color, '#0D72FF', `group ${group.name} uses Input's blue`);
    }
  }
});
