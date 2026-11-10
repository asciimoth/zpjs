import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  ForkOptions,
  SpawnOptions,
} from "node:child_process";
import {
  type Node,
  Progress,
  type ProgressNode,
  type ProgressOptions,
} from "zpjs";

const options: ProgressOptions = {
  name: "compile",
  estimatedTotalItems: 4,
  refreshInterval: null,
  initialDelay: 0,
  nameSize: 40,
  disabled: true,
};
using progress = new Progress(options);
using task = progress.root.start(new Uint8Array([65]), 1);
const same: ProgressNode = task;
const alias: Node = same;
alias.setName("work");
alias.completeOne();
alias.setCompletedItems(1);
alias.setEstimatedTotalItems(2);
alias.increaseEstimatedTotalItems(3);
const spawnOptions: SpawnOptions = {
  stdio: "inherit",
  cwd: "/",
  signal: new AbortController().signal,
};
const forkOptions: ForkOptions = {
  silent: true,
  serialization: "advanced",
  execArgv: [],
};
const piped: ChildProcessWithoutNullStreams = task.spawn("node", ["worker.js"]);
piped.stdout.on("data", (chunk: Buffer) => {
  void chunk;
});
const inherited: ChildProcess = task.spawn("node", spawnOptions);
const worker: ChildProcess = task.fork(
  new URL("file:///worker.js"),
  ["one"],
  forkOptions,
);
worker.send({ hello: true });
void inherited;
const enabled: boolean = progress.enabled;
const flushed: boolean = progress.flush();
void enabled;
void flushed;
// @ts-expect-error invalid wire format
new Progress({ nameSize: 80 });
// @ts-expect-error counts are numbers
progress.root.setCompletedItems("4");
// @ts-expect-error Node's process options are preserved
task.spawn("node", { stdio: "bad" });
