import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Progress } from "zpjs";

const p = new Progress({
  name: "JS root",
  estimatedTotalItems: 3,
  initialDelay: 0,
  refreshInterval: 10,
});
assert.equal(p.enabled, true);
const local = p.root.start("local", 4);
local.setCompletedItems(2);
p.flush();
const spawned = p.root.start("spawn placeholder");
const forked = p.root.start("fork placeholder");
const native = p.root.start("native placeholder");
const children = [
  spawned.spawn(
    process.execPath,
    [fileURLToPath(new URL("./worker.js", import.meta.url))],
    {
      env: { ...process.env, WORKER_NAME: "spawn worker", LOGS: "1" },
      stdio: "inherit",
    },
  ),
  forked.fork(new URL("./worker.js", import.meta.url), {
    env: { ...process.env, WORKER_NAME: "fork worker", NESTED: "1" },
  }),
  native.spawn(
    process.env.ZPJS_ZPG || "zpg",
    ["--report", "3", "8", "--name", "Zig child"],
    { stdio: "inherit" },
  ),
];
const results = await Promise.all(
  children.map((child) => once(child, "close")),
);
assert.deepEqual(
  results.map((result) => result[0]),
  [0, 0, 0],
);
p.flush();
await delay(20);
local.end();
spawned.end();
forked.end();
native.end();
p.close();
