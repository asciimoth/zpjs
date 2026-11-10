import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Progress } from "@asciimoth/zpjs";

const p = new Progress({
  name: process.env.WORKER_NAME ?? "worker",
  nameSize: Number(process.env.NAME_SIZE ?? 120),
  refreshInterval: null,
});
assert.equal(p.enabled, true);
p.root.setEstimatedTotalItems(10);
p.root.setCompletedItems(4);
p.root.start("leaf", 3).completeOne();
if (process.env.NESTED) {
  const nested = p.root.start("nested");
  const child = nested.fork(new URL(import.meta.url), [], {
    env: { ...process.env, NESTED: "", WORKER_NAME: "grandchild" },
  });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
}
if (process.send) {
  process.send({ ready: true, channel: process.env.ZIG_PROGRESS });
  if (process.env.WAIT_IPC) {
    const [message] = await once(process, "message");
    assert.deepEqual(message, { update: 7 });
    p.root.setCompletedItems(message.update);
  }
  process.disconnect();
}
if (process.env.LOGS) {
  console.log("worker stdout");
  console.error("worker stderr");
}
p.flush();
if (process.env.WAIT) await delay(Number(process.env.WAIT));
p.close();
