import { setTimeout as delay } from "node:timers/promises";
import { Progress } from "zpjs";

async function worker() {
  const progress = new Progress({
    name: "JS fork worker",
    estimatedTotalItems: 2,
    initialDelay: 0,
  });
  try {
    for (const name of ["JS assets", "JS code"]) {
      const task = progress.root.start(name, 10);
      try {
        for (let i = 0; i < 10; i++) {
          await delay(100);
          task.completeOne();
        }
      } finally {
        task.end();
      }
    }
    console.log("JS worker stdout: complete");
    console.error("JS worker stderr: complete");
  } finally {
    progress.close();
  }
}

async function demo() {
  const progress = new Progress({
    name: "JS demo",
    estimatedTotalItems: 2,
    initialDelay: 0,
  });
  const children = [];

  function watch(task, child) {
    const entry = { child, closed: false, done: null };
    entry.done = new Promise((resolve) => {
      let error;
      child.on("error", (cause) => {
        error = cause;
      });
      child.once("close", (code, signal) => {
        entry.closed = true;
        progress.flush();
        task.end();
        resolve(
          error ??
            (code === 0 ? null : new Error(`Worker failed: ${signal ?? code}`)),
        );
      });
    });
    children.push(entry);
  }

  try {
    const native = progress.root.start("zpg --mock");
    watch(
      native,
      native.spawn(process.env.ZPJS_ZPG || "zpg", ["--mock"], {
        stdio: ["ignore", "inherit", "inherit"],
      }),
    );
    const forked = progress.root.start("JS fork worker");
    watch(forked, forked.fork(new URL(import.meta.url), ["--worker"]));
    // Automatic updates collect both child trees and send them to zpg.
    const errors = (await Promise.all(children.map(({ done }) => done))).filter(
      Boolean,
    );
    if (errors.length) throw new AggregateError(errors, "Demo worker failed");
  } finally {
    // Also stop and wait for children if a later launch throws.
    for (const { child, closed } of children) {
      if (!closed) child.kill();
    }
    await Promise.all(children.map(({ done }) => done));
    progress.close();
  }
}

try {
  await (process.argv.includes("--worker") ? worker() : demo());
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
