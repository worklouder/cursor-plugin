'use strict';
const defaultLayer = require('./cursor-default.json');

function cursorLayer(platform = process.platform) {
  const definition = structuredClone(defaultLayer);
  if (platform !== 'win32') return definition;
  definition.os = [1];
  definition.layer.os = 1;
  for (const action of definition.actions) {
    action.os = 1;
    for (const input of action.keyInputs) {
      if (input.keycode === 'KC_LGUI') input.keycode = 'KC_LCTL';
    }
  }
  return definition;
}

module.exports = { cursorLayer };
