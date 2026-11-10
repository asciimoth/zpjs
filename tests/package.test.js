import assert from "node:assert/strict";
import { test } from "node:test";

test("the package entry point loads as an ES module", async () => {
  const library = await import("zpjs");
  assert.equal(library[Symbol.toStringTag], "Module");
});
