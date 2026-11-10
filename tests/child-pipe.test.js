import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { childPipe } from "../dist/child-pipe.js";

test("a directory cleanup error releases both pipe descriptors", async () => {
  const open = fs.openSync;
  const remove = fs.rmSync;
  const descriptors = [];
  let directory;
  const failure = Object.assign(new Error("cleanup failed"), {
    code: "EACCES",
  });
  try {
    fs.openSync = (...args) => {
      const fd = open(...args);
      descriptors.push(fd);
      return fd;
    };
    fs.rmSync = (path) => {
      directory = path;
      throw failure;
    };
    assert.throws(
      () => childPipe(),
      (error) => error === failure,
    );
  } finally {
    fs.openSync = open;
    fs.rmSync = remove;
    if (directory) remove(directory, { recursive: true, force: true });
  }
  // Socket destruction can defer descriptor release to the close callbacks.
  await setImmediate();
  await setImmediate();
  assert.equal(descriptors.length, 2);
  for (const fd of descriptors) {
    assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  }
});
