const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

module.exports = function load(file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
};
