import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Progress } from "zpjs";
import { packets, run } from "./helpers.js";

test("regular files and invalid descriptors are left untouched", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "zpjs-test-"));
  try {
    const path = join(dir, "file");
    fs.writeFileSync(path, "untouched");
    const fd = fs.openSync(path, "r+");
    const p = new Progress({ fd, refreshInterval: null });
    assert.equal(p.enabled, false);
    p.close();
    assert.equal(fs.readFileSync(path, "utf8"), "untouched");
    fs.closeSync(fd);
    assert.equal(new Progress({ fd: 65535 }).enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("only one reporter owns a channel and close releases it", async () => {
  await run(`
    import fs from 'node:fs';
    const before=process.listenerCount('exit');
    const p=new Progress({refreshInterval:null});
    const other=new Progress({refreshInterval:null});assert.equal(other.enabled,false);other.close();
    assert.equal(p.enabled,true);p.close();await delay(10);
    assert.throws(()=>fs.fstatSync(3),{code:'EBADF'});
    assert.equal(process.listenerCount('exit'),before);
  `);
});

for (const code of ["EAGAIN", "EWOULDBLOCK", "EINTR"]) {
  test(`retry ${code} and short writes without mixing frames`, async () => {
    const { frames } = await run(`
      import fs from 'node:fs';
      const write=fs.writeSync; let calls=0;
      const p=new Progress({name:'first',refreshInterval:null});
      fs.writeSync=(fd,buffer,offset,length)=>{
        calls++;
        if(calls===1)return write(fd,buffer,offset,13);
        if(calls===2)throw Object.assign(new Error(),{code:'${code}'});
        return write(fd,buffer,offset,length);
      };
      assert.equal(p.flush(),false);p.root.setName('latest');
      assert.equal(p.flush(),false);assert.equal(p.flush(),true);
      fs.writeSync=write;p.close();
    `);
    assert.deepEqual(
      frames.map((f) => f[0].name),
      ["first", "latest", "latest"],
    );
  });
}

test("permanent write errors disable the reporter and cancel timers", async () => {
  await run(`
    import fs from 'node:fs';const write=fs.writeSync;
    const before=process.listenerCount('exit');const p=new Progress({initialDelay:0});
    fs.writeSync=()=>{throw Object.assign(new Error(),{code:'EPIPE'})};
    assert.equal(p.flush(),false);fs.writeSync=write;
    assert.equal(p.enabled,false);assert.equal(process.listenerCount('exit'),before);p.close();
  `);
});

test("a full real pipe does not block and retained frames remain valid", {
  timeout: 10000,
}, async () => {
  // The child fills its upstream socket while the parent deliberately does not
  // read it. A stdout handshake proves that flush() returned under backpressure.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {Progress} from 'zpjs';
    const p=new Progress({name:'full',refreshInterval:null});
    for(let i=0;i<252;i++)p.root.start('n'+i);
    let failed=false;
    for(let i=0;i<10000;i++){if(!p.flush()){failed=true;break}}
    console.log(failed?'full':'unexpected');
    process.stdin.once('data',()=>{
      const timer=setInterval(()=>{if(p.flush()){clearInterval(timer);p.close();process.stdin.destroy()}},5);
    });
  `,
    ],
    {
      env: { ...process.env, ZIG_PROGRESS: "3" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      timeout: 5000,
    },
  );
  const done = once(child, "close");
  const stderr = [];
  child.stderr.on("data", (b) => stderr.push(b));
  const [line] = await once(child.stdout, "data");
  assert.equal(line.toString(), "full\n");
  const bytes = [];
  child.stdio[3].on("data", (b) => bytes.push(b));
  child.stdin.end("read");
  const [code, signal] = await done;
  assert.equal(signal, null, Buffer.concat(stderr).toString());
  assert.equal(code, 0);
  const frames = packets(Buffer.concat(bytes));
  assert.ok(frames.length > 1);
  assert.ok(
    frames.every((frame) => frame.length === 253 && frame[252].parent === 0),
  );
});

test("real FIFO backpressure resumes partial packets", async () => {
  const { childPipe } = await import("../dist/child-pipe.js");
  const { reader, writer, readFd } = childPipe();
  const progress = new Progress({
    fd: writer,
    refreshInterval: null,
    name: "FIFO",
  });
  const chunks = [];
  const drain = () => {
    for (;;) {
      const buffer = Buffer.alloc(65536);
      try {
        const n = fs.readSync(readFd, buffer);
        if (!n) break;
        chunks.push(buffer.subarray(0, n));
      } catch (error) {
        if (error.code === "EAGAIN") break;
        throw error;
      }
    }
  };
  try {
    const nodes = Array.from({ length: 252 }, (_, i) =>
      progress.root.start(`node${i}`),
    );
    let full = false;
    for (let i = 0; i < 1000; i++) {
      if (!progress.flush()) {
        full = true;
        break;
      }
    }
    assert.equal(full, true);
    for (const node of nodes) node.end();
    let sent = false;
    for (let i = 0; i < 20; i++) {
      drain();
      if (progress.flush()) {
        sent = true;
        break;
      }
    }
    assert.equal(sent, true);
    drain();
    progress.close();
    drain();
    const frames = packets(Buffer.concat(chunks));
    assert.equal(frames[0].length, 253);
    assert.deepEqual(frames.at(-1), [
      { name: "FIFO", parent: 255, completed: 252, total: 0 },
    ]);
  } finally {
    progress.close();
    reader.destroy();
  }
});

test("read-only FIFO descriptors stay open and do not enable reporting", async () => {
  const { childPipe } = await import("../dist/child-pipe.js");
  const { reader, writer, readFd } = childPipe();
  try {
    const progress = new Progress({ fd: readFd });
    assert.equal(progress.enabled, false);
    progress.close();
    assert.equal(fs.fstatSync(readFd).isFIFO(), true);
  } finally {
    reader.destroy();
    fs.closeSync(writer);
  }
});

test("a closed receiver disables reporting without terminating the process", async () => {
  const { childPipe } = await import("../dist/child-pipe.js");
  const { reader, writer } = childPipe();
  const progress = new Progress({ fd: writer, refreshInterval: null });
  const closed = once(reader, "close");
  reader.destroy();
  await closed;
  assert.equal(progress.flush(), false);
  assert.equal(progress.enabled, false);
  progress.close();
});

test("many channels use one exit listener and release every handle", async () => {
  const { childPipe } = await import("../dist/child-pipe.js");
  const before = process.listenerCount("exit");
  const channels = Array.from({ length: 12 }, () => childPipe());
  const reporters = channels.map(
    ({ writer }) => new Progress({ fd: writer, refreshInterval: null }),
  );
  assert.equal(process.listenerCount("exit"), before + 1);
  for (const reporter of reporters) reporter.close();
  for (const { reader } of channels) reader.destroy();
  assert.equal(process.listenerCount("exit"), before);
});
