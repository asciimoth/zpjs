import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Independent wire reader. Public API tests do not use the library decoder.
export function packets(bytes, nameSize = 120) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    const count = bytes[offset];
    assert.ok(count <= 253);
    const size = 8 + nameSize;
    assert.ok(
      offset + 1 + count * (size + 1) <= bytes.length,
      "complete frame",
    );
    const frame = [];
    for (let i = 0; i < count; i++) {
      const start = offset + 1 + i * size;
      const name = bytes.subarray(start + 8, start + size);
      const nul = name.indexOf(0);
      frame.push({
        completed: bytes.readUInt32LE(start),
        total: bytes.readUInt32LE(start + 4),
        name: name.subarray(0, nul < 0 ? name.length : nul).toString(),
        parent: bytes[offset + 1 + count * size + i],
      });
    }
    frames.push(frame);
    offset += 1 + count * (size + 1);
  }
  return frames;
}

export async function run(
  source,
  { env = {}, nameSize = 120, timeout = 10000 } = {},
) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {Progress} from 'zpjs';
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    import {setTimeout as delay} from 'node:timers/promises';
    process.execArgv = [];
    ${source}
  `,
    ],
    {
      env: { ...process.env, ...env, ZIG_PROGRESS: "3" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      timeout,
    },
  );
  const progress = [],
    stdout = [],
    stderr = [];
  child.stdio[3].on("data", (data) => progress.push(data));
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  const [code, signal] = await once(child, "close");
  const err = Buffer.concat(stderr).toString();
  assert.equal(signal, null, err);
  assert.equal(code, 0, err);
  return {
    frames: packets(Buffer.concat(progress), nameSize),
    stdout: Buffer.concat(stdout).toString(),
    stderr: err,
  };
}
