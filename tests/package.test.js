import assert from "node:assert/strict";
import { test } from "node:test";

test("the package entry point loads as an ES module", async () => {
  const library = await import("@asciimoth/zpjs");
  assert.equal(library[Symbol.toStringTag], "Module");
});

test("the package entry point loads with CommonJS require", async () => {
  const { createRequire } = await import("node:module");
  const library = createRequire(import.meta.url)("@asciimoth/zpjs");
  assert.equal(typeof library.Progress, "function");
  assert.equal(library.Node, library.ProgressNode);
});
