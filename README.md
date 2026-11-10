# zpjs

`zpjs` reports JavaScript and TypeScript task trees through the Zig progress
protocol. A supervisor such as [zpg](https://github.com/asciimoth/zpg) displays
the progress. The library does not write to stdout or stderr.

Requires Node.js 22.23.4 or later. Pipe reporting supports Linux and macOS.
On Windows, reporting is disabled; process methods still run their commands.
There are no runtime npm dependencies. On Unix, `spawn()` and `fork()` require
`mkfifo` on the parent's `PATH` and a writable temporary directory.

## Install and use

```sh
npm install zpjs
```

```js
import { Progress } from "zpjs";

const progress = new Progress({ name: "build", estimatedTotalItems: 2 });
try {
  for (const name of ["assets", "code"]) {
    const task = progress.root.start(name, 10);
    try {
      for (let i = 0; i < 10; i++) {
        await buildItem(name, i); // Your work goes here.
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

Run your script with `zpg node build.js`. Without a valid `ZIG_PROGRESS`
channel, task operations have no effect. Counts and names are still validated.

Ending a task removes it and its descendants. It adds one completed item to
its parent. Do not also call `parent.completeOne()` for that task. Repeated
`end()` calls have no effect. Ending the root closes the reporter.

ES module imports and CommonJS `require("zpjs")` use the same implementation.
The package includes TypeScript declarations. TypeScript users can use
`using` with both `Progress` and its task nodes through `Symbol.dispose`.

## Child processes

`node.spawn(command[, args][, options])` and
`node.fork(modulePath[, args][, options])` use the Node.js `child_process`
arguments and return types. They return normal `ChildProcess` objects.

```js
import { once } from "node:events";
import { Progress } from "zpjs";

const progress = new Progress({ name: "build", estimatedTotalItems: 2 });
try {
  const compile = progress.root.start("compile");
  const worker = progress.root.start("worker");
  const children = [
    compile.spawn("compiler", ["input"], { stdio: "inherit" }),
    worker.fork(new URL("./worker.js", import.meta.url), [], { silent: true }),
  ];
  // Consume piped output as needed. Handle process errors and exit codes.
  children[1].stdout.pipe(process.stdout);
  children[1].stderr.pipe(process.stderr);
  await Promise.all(children.map((child) => once(child, "close")));
  compile.end();
  worker.end();
} finally {
  progress.close();
}
```

Create a new `Progress` in each worker. A worker can start more processes.
`fork()` starts a new Node.js process and preserves its IPC channel, including
`send()` and message events. It is not the POSIX `fork()` system call.
`execArgv`, `cwd`, `env`, `stdio`, shell options, and cancellation retain their
Node.js meanings. For example, a fork inherits `process.execArgv` by default.

Each active task can have one process. Use a separate task for each concurrent
process. A second attachment throws. A failed launch releases the attachment
when the process emits `close`. Process errors use normal Node.js error events.

The child's root replaces the assigned task in reports. An empty root name
keeps the local label. Child descendants appear below this root. Local state
stays visible until the first complete report. The last valid report stays
visible after the child exits. Process exit does not end the task or indicate
success or failure. Wait for the process, then end its task.

The library copies options, environment entries, and `stdio` arrays. It appends
one private descriptor and sets `ZIG_PROGRESS` in the child's environment.
Existing descriptors and the fork IPC channel keep their indices. The parent
environment does not change. Disabled, ended, and closed nodes still launch
processes, with `ZIG_PROGRESS` removed. Do not pass the upstream descriptor in
your own `stdio` entries.

Node's Unix `stdio: "pipe"` uses sockets. Some protocol clients accept only
POSIX pipes. To support those clients, `zpjs` uses `mkfifo` to create a private
FIFO, opens both ends in nonblocking mode, then removes its directory before
launching the child. This adds one short synchronous setup command per active
process launch. No temporary path remains during the child's work.

Ending a task or closing the reporter releases its progress channels. Neither
operation waits for or stops child processes. The private channels and update
timer do not keep the Node.js event loop alive.

## API

`new Progress(options = {})` creates a reporter. `progress.root` is its root
node. `ProgressNode` is also exported as `Node`.

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `""` | Root name: a string or `Uint8Array`. |
| `estimatedTotalItems` | `0` | Root total; zero means unknown. |
| `refreshInterval` | `80` | Milliseconds between reports; `null` for manual. |
| `initialDelay` | `200` | Milliseconds before the first automatic report. |
| `fd` | Environment | Owned pipe or socket descriptor; from 0 to 65535. |
| `disabled` | `false` | Disable reporting. |
| `nameSize` | `120` | Name field size: `120` or `40`. |

Intervals must be finite and at most 2147483647 milliseconds.
`refreshInterval` must be at least 1; `initialDelay` must be nonnegative.
Omitted or `undefined` options use their defaults. Only `refreshInterval`
accepts `null`. Invalid options throw before the reporter takes ownership of a
descriptor, even when reporting is disabled.

- `progress.enabled`: whether reporting is active.
- `progress.flush()`: collect child reports and try to send a snapshot. Returns
  `true` if the current snapshot was sent in full. Does not wait for pipe space.
- `progress.close()`: try a final report, cancel the timer, and close channels.
  Repeated calls have no effect. It does not change task counts.

| Node method | Action |
| --- | --- |
| `start(name, estimatedTotalItems = 0)` | Create a child task. |
| `completeOne()` | Add one completed item. |
| `setCompletedItems(count)` | Set the completed count. |
| `setEstimatedTotalItems(count)` | Set the estimated total. |
| `increaseEstimatedTotalItems(count)` | Add to the estimated total. |
| `setName(name)` | Change the label. |
| `end()` | Remove this branch and complete one parent item. |
| `spawn(command[, args][, options])` | Start a process with progress. |
| `fork(modulePath[, args][, options])` | Start Node.js with progress and IPC. |

Counts must be nonnegative safe JavaScript integers. Completed counts saturate
at 4294967295; totals saturate at 4294967294. Completed counts can exceed totals.
Strings use UTF-8 and are cut at a character boundary. Byte names are copied
without decoding. Bytes after the first NUL are ignored. Name fields are padded
with zeros.

The tree holds up to 253 active local nodes. Additional nodes have no effect.
Ending a branch makes room for new tasks. Combined reports also have a limit
of 253 nodes. Local nodes take priority; child trees use the remaining space
in local task order. Omitted descendants can appear when space becomes free.

## Protocol and channel lifetime

The [published specification][protocol] and Zig 0.15.2 use 40-byte names.
`zpg` and the sibling clients use 120-byte names by default. Select
`{ nameSize: 40 }` for the original format. Both formats use `ZIG_PROGRESS`;
there is no negotiation. All processes must use the receiver's name size.

The packet contains a node count, all node records, then all parent indices.
Each record has two little-endian 32-bit counters and a fixed-size name.
Parent `255` marks the root. Each packet replaces the previous tree.

A reporter takes ownership of a valid descriptor, like `net.Socket({ fd })`.
It sets nonblocking mode and closes the descriptor on `close()`. Do not close
or reuse that descriptor yourself. Invalid descriptors and regular files are
left untouched. Only one reporter can own a descriptor in a JavaScript isolate.
Do not share a progress channel between worker threads or independent writers.
Use process methods to combine separate reporters.

Updates run on the event loop. Long synchronous work delays automatic reports;
call `flush()` during such work. With `refreshInterval: null`, also call
`flush()` regularly while children run. Each collection has a bounded read
budget. Bad child packets close that child's channel and retain its last valid
tree. They do not disable unrelated tasks.

Full channels can delay or drop snapshots. Partial packets finish before new
packets begin. Memory use is bounded. A permanent write error disables
reporting. `close()` and normal process exit try a final report, but never wait
for space. They do not send another copy of the last complete report if the
tree has not changed. A final packet can be lost or incomplete. If final delivery
matters, retry `flush()` while the receiver is reading, then close. `SIGKILL` and
forced termination cannot run cleanup.

[protocol]: https://andrewkelley.me/post/zig-new-cli-progress-bar-explained.html#the-zig-progress-protocol-specification

## Development and tests

```sh
npm ci
npm run check
npm run test:coverage
npm run test:compat
```

The compatibility command requires `zpg` with `--test` support. Use `ZPJS_ZPG`
to select an executable outside `PATH`. The normal test command skips this
suite if `zpg` is absent. The Nix check requires it.

Tests cover wire bytes, both name sizes, UTF-8, malformed trees, split packets,
node limits, timers, cleanup, full pipes, partial writes, child processes,
fork IPC, nested workers, cancellation, and `zpg` validation. To test a Python
child with a JavaScript grandchild, set `ZPJS_ZPPY` to a `zppy` checkout's `src`
directory and run `npm test` with `python3` on `PATH`.

Use `nix develop` for the pinned tools and supervisor. The `just` commands also
support build, tests, formatting, and checks. Run examples with:

```sh
just run
just run examples/processes.js
```

`just run` builds the library and runs the example under `zpg`. The default
demo starts `zpg --mock` and a Node.js fork worker at the same time. It collects
both progress trees and sends them to the supervisor. Each task ends when its
child exits. A failed child makes the demo exit with a nonzero status.
The mock's stdin is closed so piped input does not replace its built-in demo.

Reference implementations:
[Zig std.Progress](https://github.com/ziglang/zig/blob/0.15.2/lib/std/Progress.zig),
[zppy](https://github.com/asciimoth/zppy),
[zpgo](https://github.com/asciimoth/zpgo), and
[zprs](https://github.com/asciimoth/zprs).

## License

[CC0 1.0 Universal](LICENSE).
