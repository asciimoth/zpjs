import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Progress } from "zpjs";

const worker = process.argv.includes("--worker");
const progress = new Progress({
  name: worker ? "worker" : "processes",
  estimatedTotalItems: 2,
});
try {
  if (worker) {
    const task = progress.root.start("items", 10);
    for (let i = 0; i < 10; i++) {
      await delay(80);
      task.completeOne();
    }
    task.end();
  } else {
    const spawned = progress.root.start("spawn");
    const forked = progress.root.start("fork");
    const children = [
      spawned.spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "--worker"],
        { stdio: "inherit" },
      ),
      forked.fork(new URL(import.meta.url), ["--worker"]),
    ];
    const results = await Promise.all(
      children.map((child) => once(child, "close")),
    );
    progress.flush();
    spawned.end();
    forked.end();
    if (results.some(([code]) => code !== 0)) process.exitCode = 1;
  }
} finally {
  progress.close();
}
