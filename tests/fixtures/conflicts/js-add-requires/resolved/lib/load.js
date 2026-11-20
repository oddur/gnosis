const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const util = require('node:util');

module.exports = function load(file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
};
