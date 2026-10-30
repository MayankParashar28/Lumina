const test = require("node:test");
const assert = require("node:assert/strict");
const { wantsJson } = require("../utils/http");

test("wantsJson tolerates a missing Accept header", () => {
  // This used to throw a TypeError and surface as a 500.
  assert.equal(wantsJson({ headers: {} }), false);
  assert.equal(wantsJson({ headers: { accept: undefined } }), false);
  assert.equal(wantsJson({}), false);
  assert.equal(wantsJson(null), false);
});

test("wantsJson detects JSON clients", () => {
  assert.equal(wantsJson({ headers: { accept: "application/json" } }), true);
  assert.equal(wantsJson({ headers: { accept: "text/html,application/json" } }), true);
  assert.equal(wantsJson({ xhr: true, headers: {} }), true);
});

test("wantsJson leaves plain browser requests alone", () => {
  assert.equal(wantsJson({ headers: { accept: "text/html" } }), false);
  assert.equal(wantsJson({ headers: { accept: "*/*" } }), false);
});
