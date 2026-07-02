const fs = require('fs');
const path = require('path');

const targetFile = path.join(
  __dirname,
  '..',
  'node_modules',
  '@webos-tools',
  'cli',
  'lib',
  'package.js'
);

if (!fs.existsSync(targetFile)) {
  process.exit(0);
}

let source = fs.readFileSync(targetFile, 'utf8');

// Patch 1: Fix rimraf compatibility
const before = [
  "    log = require('npmlog'),",
  "    path = require('path'),",
  "    rimraf = require('rimraf'),",
  "    shelljs = require('shelljs'),",
  "    stripbom = require('strip-bom'),"
].join('\n');

const after = [
  "    log = require('npmlog'),",
  "    path = require('path'),",
  "    rimrafImport = require('rimraf'),",
  "    rimraf = function(targetPath, cb) {",
  "        if (typeof rimrafImport === 'function') {",
  "            return rimrafImport(targetPath, cb);",
  "        }",
  "",
  "        return rimrafImport.rimraf(targetPath)",
  "            .then(function() { cb && cb(); })",
  "            .catch(function(err) { cb && cb(err); });",
  "    },",
  "    shelljs = require('shelljs'),",
  "    stripbom = require('strip-bom'),"
].join('\n');

if (source.includes(before) && !source.includes('rimrafImport = require(\'rimraf\')')) {
  source = source.replace(before, after);
}

// Patch 2: Disable minification (already minified by Vite)
const minifyBefore = "        this.minify = true;";
const minifyAfter = "        this.minify = false;";

if (source.includes(minifyBefore)) {
  source = source.replace(minifyBefore, minifyAfter);
}

fs.writeFileSync(targetFile, source, 'utf8');
