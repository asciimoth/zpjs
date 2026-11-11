# zpjs

`zpjs` is a JavaScript and TypeScript library for Node.js that reports task
progress through the Zig progress protocol. Use it to report tasks, subtasks,
and progress from child processes.

`zpjs` requires Node.js 22.23.4 or later. Pipe reporting supports Linux and
macOS. On Windows, reporting is disabled. Process methods still run their
commands. The library has no runtime npm dependencies. On Unix, `spawn()` and
`fork()` require `mkfifo` on the parent process's `PATH` and a writable
temporary directory.

## Installation

```sh
npm install @asciimoth/zpjs
```

The npm package name is `@asciimoth/zpjs`. It supports ES module imports and
CommonJS `require("@asciimoth/zpjs")`.
It includes TypeScript declarations.

## Zig progress protocol

The Zig progress protocol lets a process send a tree of tasks to its parent
process through a pipe. Each task has a name, a completed item count, and an
estimated total. The `ZIG_PROGRESS` environment variable identifies the pipe.
The parent process can combine progress from child processes and display it
in one place.

You can use the protocol outside the Zig toolchain. For example,
[`zpg`][zpg] runs commands and displays their progress in a terminal. With
`zpjs`, JavaScript and TypeScript programs can send progress to `zpg` or
another compatible receiver.

See Andrew Kelley's [Zig progress protocol specification][protocol] for the
protocol design. For clients in other languages, see [`zppy`][zppy] for
Python, [`zpgo`][zpgo] for Go, and [`zprs`][zprs] for Rust.

![zpg displaying a task tree](https://vhs.charm.sh/vhs-5OKsqixxKTapPmjdIv2Qhf.gif)

## Library usage

If you use this library, [open an issue][issues] or [send a pull request][pulls]
with a link to your project. The link helps us track use of the Zig progress
protocol outside the Zig toolchain.

Add the [`zig-progress-protocol` topic][topic] to your GitHub repository. Use
the same tag on other platforms so people can find related projects.

### Report tasks

Save this example as `build.mjs`:

```js
import { setTimeout as delay } from "node:timers/promises";
import { Progress } from "@asciimoth/zpjs";

const progress = new Progress({ name: "build", estimatedTotalItems: 2 });
try {
  for (const name of ["assets", "code"]) {
    const task = progress.root.start(name, 10);
    try {
      for (let i = 0; i < 10; i++) {
        await delay(100); // Replace this delay with one item of work.
        task.completeOne();
      }
    } finally {
      task.end();
    }
  }
} finally {
  progress.close();
}
```

Install [`zpg`][zpg] and make sure it is on `PATH`. Then run:

```sh
zpg node build.mjs
```

Each task can start child tasks. When you end a task, the library removes the
task and its descendants. The library also adds one completed item to the
parent task. Do not also call `parent.completeOne()` for the same task.
Repeated `end()` calls have no effect. Ending the root closes the reporter.
Ending a task does not report success or failure.

Use `try`/`finally` to end tasks and close the reporter if work throws an
error. TypeScript users can also use `using` with both `Progress` and its task
nodes through `Symbol.dispose`.

Without a valid `ZIG_PROGRESS` channel, reporting is disabled. Task updates
have no effect, but the library still validates counts and names. The library
does not print to stdout or stderr or draw its own terminal display.

### Child processes

Use `task.spawn(command[, args][, options])` to start a command with its own
progress pipe. Use `task.fork(modulePath[, args][, options])` to start a Node.js
worker with progress and an IPC channel. Both methods accept the arguments
of the corresponding Node.js `child_process` methods. Both return
`ChildProcess` objects.

Save this example as `parent.mjs` next to `build.mjs`. It runs two copies of
the task example at the same time:

```js
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Progress } from "@asciimoth/zpjs";

const workerPath = new URL("./build.mjs", import.meta.url);
const progress = new Progress({ name: "workers", estimatedTotalItems: 2 });
try {
  const spawned = progress.root.start("spawn");
  const forked = progress.root.start("fork");
  const children = [
    spawned.spawn(process.execPath, [fileURLToPath(workerPath)], {
      stdio: "inherit",
    }),
    forked.fork(workerPath),
  ];
  const results = await Promise.all(
    children.map((child) => once(child, "close")),
  );
  spawned.end();
  forked.end();
  if (results.some(([code]) => code !== 0)) process.exitCode = 1;
} finally {
  progress.close();
}
```

Run `parent.mjs` with a progress display:

```sh
zpg node parent.mjs
```

Create a new `Progress` in each worker, as `build.mjs` does. A worker can start
more processes. Workers in other languages can use any compatible protocol
library. Use the same `nameSize` for the receiver and all reporters in the
process tree.

`fork()` starts a new Node.js process and preserves its IPC channel, including
`send()` and message events. It is not the POSIX `fork()` system call.
`execArgv`, `cwd`, `env`, `stdio`, shell options, and cancellation have their
Node.js meanings. For example, `fork()` inherits `process.execArgv` by default.

Use a separate task for each process. If you attach a second process to the
same active task, the method throws an error. This also applies after the
first process exits. After a failed launch, the library releases the
attachment when the process emits `close`. Process errors use Node.js error
events. If the child emits an error, `once(child, "close")` rejects.

The child process's root replaces the assigned task in reports. If the root
name is empty, the report keeps the local task name. The root's descendants
appear below it. The local task state stays visible until the first complete
child report. The last valid report stays visible after the child process
exits. Process exit does not end the task or indicate success or failure.
Wait for the process to exit, then end its task.

The library preserves your process options and sets `ZIG_PROGRESS` only in
the child's environment. Existing descriptors and the fork IPC channel keep
their indices. Disabled, ended, and closed nodes still launch processes, with
`ZIG_PROGRESS` removed. Do not pass the upstream progress descriptor in your
own `stdio` entries. If you select piped stdout or stderr, read those streams
so the child can continue writing.

When you end a task or close the reporter, the library releases the associated
progress channels. Neither operation waits for or stops child processes. The
private channels and update timer do not keep the Node.js event loop alive.

### API reference

`new Progress(options = {})` creates a reporter. `progress.root` is its root
node. `ProgressNode` is also exported as `Node`.

<!-- markdownlint-disable MD013 -->

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `""` | Root task name: a string or `Uint8Array`. |
| `estimatedTotalItems` | `0` | Estimated total for the root task. Zero means unknown. |
| `refreshInterval` | `80` | Milliseconds between reports. Use `null` for manual reporting. |
| `initialDelay` | `200` | Milliseconds before the first automatic report. |
| `fd` | `ZIG_PROGRESS` | Pipe or socket descriptor that the reporter owns, from 0 to 65535. |
| `disabled` | `false` | Disable reporting. |
| `nameSize` | `120` | Name field size: `120` or `40`. |

<!-- markdownlint-enable MD013 -->

Intervals must be finite and at most 2147483647 milliseconds.
`refreshInterval` must be at least 1. `initialDelay` must be at least 0.
Omitted or `undefined` options use their defaults. Only `refreshInterval`
accepts `null`. If an option is invalid, the constructor throws an error before
the reporter takes ownership of a descriptor. This check also applies when
reporting is disabled.

- `progress.enabled`: indicates whether reporting is active.
- `progress.flush()`: collects child reports and tries to send a report of the
  current task tree. It returns `true` if the report was sent in full. It
  returns `false` if reporting is disabled or the write could not finish. It
  does not wait for space in the pipe.
- `progress.close()`: tries to send a final report, cancels the timer, and
  closes channels. Repeated calls have no effect. The method does not change
  task counts.

| Node method | Action |
| --- | --- |
| `start(name, estimatedTotalItems = 0)` | Create a child task. |
| `completeOne()` | Add one completed item. |
| `setCompletedItems(count)` | Set the completed count. |
| `setEstimatedTotalItems(count)` | Set the estimated total. |
| `increaseEstimatedTotalItems(count)` | Add to the estimated total. |
| `setName(name)` | Change the task name. |
| `end()` | Remove this branch and add one completed item to the parent task. |
| `spawn(command[, args][, options])` | Start a process with progress. |
| `fork(modulePath[, args][, options])` | Start Node.js with progress and IPC. |

Task updates on ended nodes have no effect. If an argument is invalid, the
method throws an error. This check also applies when reporting is disabled.

Counts must be safe JavaScript integers greater than or equal to 0. Completed
counts are limited to 4294967295. Estimated totals are limited to 4294967294.
The library reduces larger values to these limits. Completed counts can
exceed estimated totals.

Names can be strings or `Uint8Array` values. The library encodes strings as
UTF-8 and shortens them at a character boundary. It copies byte names without
decoding them. It ignores bytes after the first NUL.

The tree holds up to 253 active local nodes, including the root. Additional
nodes have no effect. When you end a branch, space becomes available for new
tasks. Combined reports also have a limit of 253 nodes. Local nodes take
priority. Child trees use the remaining space in local task order. Omitted
descendants can appear when space becomes available.

## Compatibility and report delivery

### Protocol format

The [published specification][protocol] and Zig 0.15.2 use 40-byte names.
`zpg`, `zppy`, `zpgo`, and `zprs` use 120-byte names by default. Use
`{ nameSize: 40 }` for the original format. Both formats use `ZIG_PROGRESS`.
The protocol does not negotiate the name size. All processes must use the
receiver's name size.

### Progress channels

A reporter takes ownership of a valid pipe or socket descriptor from
`ZIG_PROGRESS` or the `fd` option. It sets nonblocking mode and closes the
descriptor on `close()`. Do not close or reuse that descriptor yourself.
The library does not change invalid descriptors or regular files. Only one
reporter can own a descriptor in a JavaScript isolate.

Do not share a progress channel between worker threads or independent writers.
Each report replaces the previous task tree. Use `spawn()` or `fork()` to
combine reports from separate processes.

### Update timing and final reports

Updates run on the event loop. Long synchronous work delays automatic reports.
During this work, call `flush()`. With `refreshInterval: null`, also call
`flush()` regularly while child processes run. If a child report is invalid,
the library closes that child's channel and keeps its last valid tree. Other
tasks remain active.

Full channels can delay or drop reports. A permanent write error disables
reporting. When you call `close()` or the process exits normally, the library
tries to send a final report. It does not wait for space in the channel. A
final report can be lost or incomplete. If you need the final report to reach
the receiver, retry `flush()` while the receiver is reading. Then call
`close()`. `SIGKILL` and forced termination prevent cleanup.

## License

Files in this repository are distributed under the
[CC0 1.0 Universal license](LICENSE).

<!-- markdownlint-disable MD033 -->
<p xmlns:dct="http://purl.org/dc/terms/">
  <a rel="license"
     href="https://creativecommons.org/publicdomain/zero/1.0/">
    <img src="https://i.creativecommons.org/p/zero/1.0/88x31.png"
         style="border-style: none;" alt="CC0" />
  </a>
  <br />
  To the extent possible under law,
  <a rel="dct:publisher"
     href="https://github.com/asciimoth">
    <span property="dct:title">ASCIIMoth</span></a>
  has waived all copyright and related or neighboring rights to
  <span property="dct:title">zpjs</span>.
</p>
<!-- markdownlint-enable MD033 -->

[zpg]: https://github.com/asciimoth/zpg
[zppy]: https://github.com/asciimoth/zppy
[zpgo]: https://github.com/asciimoth/zpgo
[zprs]: https://github.com/asciimoth/zprs
[protocol]: https://andrewkelley.me/post/zig-new-cli-progress-bar-explained.html#the-zig-progress-protocol-specification
[issues]: https://github.com/asciimoth/zpjs/issues
[pulls]: https://github.com/asciimoth/zpjs/pulls
[topic]: https://github.com/topics/zig-progress-protocol
