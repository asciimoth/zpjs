import { Buffer } from "node:buffer";
import {
  type ChildProcess,
  type ForkOptions,
  fork,
  type SpawnOptions,
  type StdioOptions,
  spawn,
} from "node:child_process";
import { closeSync, readSync } from "node:fs";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
import { childPipe } from "./child-pipe.js";
import {
  count,
  Decoder,
  encode,
  MAX_COMPLETED,
  MAX_NODES,
  MAX_TOTAL,
  type NameSize,
  type TaskName,
  type Record as WireRecord,
  wireName,
} from "./protocol.js";
import { environmentFd, Transport } from "./transport.js";

export type { NameSize, TaskName } from "./protocol.js";

export interface ProgressOptions {
  name?: TaskName;
  estimatedTotalItems?: number;
  /** Milliseconds between automatic reports; null selects manual flush(). */
  refreshInterval?: number | null;
  /** Milliseconds before the first automatic report. Default: 200. */
  initialDelay?: number;
  /** Owned descriptor. Defaults to the ZIG_PROGRESS environment variable. */
  fd?: number;
  disabled?: boolean;
  /** 120 for zpg and recent Zig; 40 for the published 2024 protocol. */
  nameSize?: NameSize;
}

interface State {
  parent: State | undefined;
  record: WireRecord;
  child?: { decoder: Decoder; stream: Readable; collect(): void };
}

function interval(value: number, allowZero: boolean): number {
  if (typeof value !== "number")
    throw new TypeError("timer interval must be a number");
  if (
    !Number.isFinite(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 0x7fffffff
  ) {
    throw new RangeError("timer interval must be within Node.js timer limits");
  }
  return value;
}

// A single exit listener avoids EventEmitter warnings for many channels.
const reporters = new Set<Progress>();
function closeReporters(): void {
  for (const reporter of reporters) reporter.close();
}

/** Reports one task tree. Use one reporter per progress channel. */
export class Progress {
  readonly root: ProgressNode;
  #nameSize: NameSize;
  #states = new Set<State>();
  #transport: Transport | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: ProgressOptions = {}) {
    this.#nameSize = options.nameSize ?? 120;
    if (this.#nameSize !== 40 && this.#nameSize !== 120)
      throw new RangeError("nameSize must be 40 or 120");
    const name = wireName(options.name ?? "", this.#nameSize);
    const total = count(options.estimatedTotalItems ?? 0, MAX_TOTAL);
    const refresh =
      options.refreshInterval === null
        ? null
        : interval(options.refreshInterval ?? 80, false);
    const delay = interval(options.initialDelay ?? 200, true);
    if (
      options.fd !== undefined &&
      (!Number.isInteger(options.fd) || options.fd < 0 || options.fd > 65535)
    ) {
      throw new RangeError("fd must be an integer from 0 to 65535");
    }
    const fd = options.fd ?? environmentFd(process.env.ZIG_PROGRESS);
    if (!options.disabled && fd !== undefined)
      this.#transport = Transport.open(fd);
    const state: State = {
      parent: undefined,
      record: { name, total, completed: 0, parent: 255 },
    };
    if (this.enabled) {
      this.#states.add(state);
      if (reporters.size === 0) process.once("exit", closeReporters);
      reporters.add(this);
      if (refresh !== null) {
        const tick = () => {
          this.flush();
          if (this.enabled) this.#timer = setTimeout(tick, refresh).unref();
        };
        this.#timer = setTimeout(tick, delay).unref();
      }
    }
    this.root = this.#node(state);
  }

  get enabled(): boolean {
    return !this.#closed && (this.#transport?.enabled ?? false);
  }

  #node(state: State): ProgressNode {
    return new ProgressNode({
      start: (name, total) => {
        const child: State = {
          parent: state,
          record: {
            name: wireName(name, this.#nameSize),
            total: count(total, MAX_TOTAL),
            completed: 0,
            parent: 255,
          },
        };
        if (
          this.enabled &&
          this.#states.has(state) &&
          this.#states.size < MAX_NODES
        )
          this.#states.add(child);
        return this.#node(child);
      },
      update: (field, value) => {
        if (this.enabled && this.#states.has(state))
          state.record[field] = value(state.record[field]);
      },
      name: (name) => {
        const value = wireName(name, this.#nameSize);
        if (this.enabled && this.#states.has(state)) state.record.name = value;
      },
      end: () => this.#end(state),
      launch: (launch, options, isFork) =>
        this.#launch(state, launch, options, isFork),
    });
  }

  #end(state: State): void {
    if (!this.#states.has(state)) return;
    if (!state.parent) {
      this.close();
      return;
    }
    const removed = new Set([state]);
    // Insertion order always puts a local parent before its descendants.
    for (const current of this.#states) {
      if (current.parent && removed.has(current.parent)) removed.add(current);
      if (removed.has(current)) {
        current.child?.stream.destroy();
        this.#states.delete(current);
      }
    }
    state.parent.record.completed = Math.min(
      MAX_COMPLETED,
      state.parent.record.completed + 1,
    );
  }

  #launch(
    state: State,
    launch: (options: SpawnOptions) => ChildProcess,
    options: SpawnOptions,
    isFork: boolean,
  ): ChildProcess {
    if (typeof options !== "object" || Array.isArray(options))
      throw new TypeError("options must be an object");
    const active = this.enabled && this.#states.has(state);
    if (active && state.child)
      throw new Error("a process is already attached to this node");
    const env = { ...(options.env ?? process.env) };
    for (const key of Object.keys(env)) {
      if (
        key === "ZIG_PROGRESS" ||
        (process.platform === "win32" && key.toUpperCase() === "ZIG_PROGRESS")
      )
        delete env[key];
    }
    if (!active) return launch({ ...options, env });
    const stdio = childStdio(
      options.stdio,
      isFork,
      (options as ForkOptions).silent,
    );
    const fd = stdio.length;
    if (fd > 65535)
      throw new RangeError("child progress descriptor exceeds 65535");
    const { reader: stream, writer, readFd } = childPipe();
    stdio.push(writer);
    env.ZIG_PROGRESS = String(fd);
    let child: ChildProcess;
    try {
      child = launch({ ...options, env, stdio });
    } catch (error) {
      stream.destroy();
      throw error;
    } finally {
      closeSync(writer);
    }
    const decoder = new Decoder(this.#nameSize);
    const attachment = {
      decoder,
      stream,
      collect: () => {
        if (stream.destroyed) return;
        const buffer = Buffer.allocUnsafe(4096);
        // Bound work even when a child writes continuously.
        for (let budget = 65536; budget > 0; ) {
          let bytes: number;
          try {
            bytes = readSync(readFd, buffer);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EINTR")
              stream.destroy();
            return;
          }
          if (bytes === 0) {
            stream.destroy();
            return;
          }
          budget -= bytes;
          decoder.push(buffer.subarray(0, bytes));
          if (decoder.failed) {
            stream.destroy();
            return;
          }
        }
      },
    };
    state.child = attachment;
    // This private channel must not defeat ChildProcess.unref().
    if (stream instanceof Socket) stream.unref();
    stream.on("error", () => stream.destroy());
    // Do not add an 'error' listener to ChildProcess: preserve Node's normal
    // unhandled-error behavior. A failed spawn closes its stdio streams.
    child.once("close", () => {
      attachment.collect();
      if (child.pid === undefined && state.child === attachment) {
        stream.destroy();
        delete state.child;
      }
    });
    return child;
  }

  #snapshot(): Buffer {
    const records: WireRecord[] = [];
    const indices = new Map<State, number>();
    for (const state of this.#states) {
      indices.set(state, records.length);
      records.push({
        ...state.record,
        parent: state.parent ? (indices.get(state.parent) ?? 255) : 255,
      });
    }
    // Local tasks have priority. Each child root replaces its assigned task.
    for (const state of this.#states) {
      state.child?.collect();
      const snapshot = state.child?.decoder.snapshot;
      const index = indices.get(state);
      const root = snapshot?.[0];
      const local = index === undefined ? undefined : records[index];
      if (!snapshot || !root || index === undefined || !local) continue;
      records[index] = {
        ...root,
        parent: local.parent,
        name: root.name[0] === 0 ? local.name : root.name,
      };
      const mapped = [index];
      for (let i = 1; i < snapshot.length && records.length < MAX_NODES; i++) {
        const record = snapshot[i];
        if (!record) continue;
        mapped[i] = records.length;
        records.push({ ...record, parent: mapped[record.parent] ?? index });
      }
    }
    return encode(records, this.#nameSize);
  }

  /** Try to send the current tree without waiting for channel space. */
  flush(): boolean {
    if (!this.enabled) {
      if (this.#transport && !this.#closed) this.close();
      return false;
    }
    const sent = this.#transport?.send(this.#snapshot()) ?? false;
    if (!this.#transport?.enabled) this.close();
    return sent;
  }

  /** Try a final report and release all channels. Does not stop child processes. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#transport?.enabled) this.#transport.send(this.#snapshot(), true);
    clearTimeout(this.#timer);
    reporters.delete(this);
    if (reporters.size === 0) process.removeListener("exit", closeReporters);
    for (const state of this.#states) state.child?.stream.destroy();
    this.#states.clear();
    this.#transport?.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

function childStdio(
  value: StdioOptions | undefined,
  isFork: boolean,
  silent: boolean | undefined,
): Exclude<StdioOptions, string> {
  if (Array.isArray(value)) {
    // Node fills missing stdin/stdout/stderr entries with its defaults.
    const result = [...value];
    while (result.length < 3) result.push(undefined);
    if (isFork && !result.includes("ipc"))
      throw new Error("Forked processes must have an IPC channel");
    return result;
  }
  const mode = value ?? (isFork && !silent ? "inherit" : "pipe");
  if (
    mode !== "pipe" &&
    mode !== "ignore" &&
    mode !== "inherit" &&
    mode !== "overlapped"
  ) {
    throw new TypeError("invalid stdio option");
  }
  const result: Exclude<StdioOptions, string> = [mode, mode, mode];
  if (isFork) result.push("ipc");
  return result;
}

interface NodeActions {
  start(name: TaskName, total: number): ProgressNode;
  update(
    field: "completed" | "total",
    value: (previous: number) => number,
  ): void;
  name(name: TaskName): void;
  end(): void;
  launch(
    launch: (options: SpawnOptions) => ChildProcess,
    options: SpawnOptions,
    isFork: boolean,
  ): ChildProcess;
}

/** A task handle. Create tasks with progress.root.start(). */
export class ProgressNode {
  /** @internal */
  constructor(private readonly actions: NodeActions) {}

  start(name: TaskName, estimatedTotalItems = 0): ProgressNode {
    return this.actions.start(name, estimatedTotalItems);
  }
  completeOne(): void {
    this.actions.update("completed", (previous) =>
      Math.min(MAX_COMPLETED, previous + 1),
    );
  }
  setCompletedItems(value: number): void {
    const next = count(value, MAX_COMPLETED);
    this.actions.update("completed", () => next);
  }
  setEstimatedTotalItems(value: number): void {
    const next = count(value, MAX_TOTAL);
    this.actions.update("total", () => next);
  }
  increaseEstimatedTotalItems(value: number): void {
    const increment = count(value, MAX_TOTAL);
    this.actions.update("total", (previous) =>
      Math.min(MAX_TOTAL, previous + increment),
    );
  }
  setName(name: TaskName): void {
    this.actions.name(name);
  }
  end(): void {
    this.actions.end();
  }
  [Symbol.dispose](): void {
    this.end();
  }

  /** Node.js spawn arguments and return types, with a private progress channel. */
  spawn: typeof spawn = ((
    command: string,
    args?: readonly string[] | SpawnOptions,
    options?: SpawnOptions,
  ) => {
    if (args != null && typeof args !== "object")
      throw new TypeError("args must be an array or options object");
    const argv = Array.isArray(args) ? args : [];
    const opts = (Array.isArray(args) || args == null ? options : args) as
      | SpawnOptions
      | undefined;
    return this.actions.launch(
      (configured) => spawn(command, argv, configured),
      opts ?? {},
      false,
    );
  }) as typeof spawn;

  /** Node.js fork (a new Node process), including its normal IPC channel. */
  fork: typeof fork = ((
    modulePath: string | URL,
    args?: readonly string[] | ForkOptions,
    options?: ForkOptions,
  ) => {
    if (args != null && typeof args !== "object")
      throw new TypeError("args must be an array or options object");
    const argv = Array.isArray(args) ? args : [];
    const opts = (Array.isArray(args) || args == null ? options : args) as
      | ForkOptions
      | undefined;
    return this.actions.launch(
      (configured) => fork(modulePath, argv, configured as ForkOptions),
      opts ?? {},
      true,
    );
  }) as typeof fork;
}

export { ProgressNode as Node };
