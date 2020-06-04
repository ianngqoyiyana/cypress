// TODO: This file was created by bulk-decaffeinate.
// Sanity-check the conversion and remove this comment.
/*
 * decaffeinate suggestions:
 * DS209: Avoid top-level return
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const path           = require("path");
const coffeeCoverage = require("coffee-coverage");

if (!process.env["NODE_COVERAGE"]) { return; }

const projectRoot = path.resolve(__dirname, "../../..");
const coverageVar = coffeeCoverage.findIstanbulVariable();

// Only write a coverage report if we"re not running inside of Istanbul.
const writeOnExit = coverageVar ? null : projectRoot + "/coverage/coverage-coffee.json";

coffeeCoverage.register({
  instrumentor: "istanbul",
  basePath: projectRoot,
  exclude: ["/gulpfile.coffee", "/deploy", "/build", "/dist", "/tmp", "/test", "/spec", "/app", "/bower_components", "/cache", "/support", "/node_modules", "/.git", "/.cy", "/.projects"],
  coverageVar,
  writeOnExit,
  initAll: true
});

// using hack found here to prevent problems with
// coffee-coverage being replaced by modules which
// use coffeescript/register
// https://github.com/abresas/register-coffee-coverage/blob/master/index.js
const loader = require.extensions[".coffee"];

Object.defineProperty(require.extensions, ".coffee", {
  get() { return loader; },
  set() { return loader; }
});
