'use strict';
const VERSION = require('../../.cursor-plugin/plugin.json').version;
function compareVersions(left, right) {
  if (![left, right].every((value) => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value))) throw new Error('Unsupported Work Louder helper version');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
module.exports = { VERSION, compareVersions };
