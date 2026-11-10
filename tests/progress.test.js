import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Progress } from "zpjs";
import { run } from "./helpers.js";

for (const nameSize of [40, 120]) {
  test(`task lifetime and counters (${nameSize}-byte names)`, async () => {
    const { frames } = await run(
      `
      const p = new Progress({name:'build',estimatedTotalItems:2,refreshInterval:null,nameSize:${nameSize}});
      assert.equal(p.enabled,true);
      const a=p.root.start('a',4), b=p.root.start('b');
      const nested=a.start('nested'); nested.completeOne();
      a.setCompletedItems(2); a.increaseEstimatedTotalItems(3); a.setName('assets');
      b.setEstimatedTotalItems(5); b.completeOne(); p.flush();
      a.end(); a.end(); nested.end(); a.completeOne();
      a.start('invisible'); p.flush();
      b.end(); p.root.end(); p.close(); assert.equal(p.enabled,false);
    `,
      { nameSize },
    );
    assert.deepEqual(frames[0], [
      { name: "build", completed: 0, total: 2, parent: 255 },
      { name: "assets", completed: 2, total: 7, parent: 0 },
      { name: "b", completed: 1, total: 5, parent: 0 },
      { name: "nested", completed: 1, total: 0, parent: 1 },
    ]);
    assert.equal(frames[1].length, 2);
    assert.equal(frames[1][0].completed, 1);
    assert.deepEqual(frames.at(-1), [
      { name: "build", completed: 2, total: 2, parent: 255 },
    ]);
  });
}

test("counts saturate and do not wrap", async () => {
  const { frames } = await run(`
    const p=new Progress({refreshInterval:null,estimatedTotalItems:Number.MAX_SAFE_INTEGER});
    p.root.setCompletedItems(Number.MAX_SAFE_INTEGER);p.root.completeOne();
    p.root.increaseEstimatedTotalItems(Number.MAX_SAFE_INTEGER);p.close();
  `);
  assert.equal(frames[0][0].completed, 0xffffffff);
  assert.equal(frames[0][0].total, 0xfffffffe);
});

test("capacity is bounded, released slots work, and stale handles stay inactive", async () => {
  const { frames } = await run(`
    const p=new Progress({refreshInterval:null});
    const nodes=Array.from({length:252},(_,i)=>p.root.start(String(i)));
    const overflow=p.root.start('overflow'); p.flush();
    nodes[0].end(); const fresh=p.root.start('fresh');
    nodes[0].setName('stale'); overflow.setName('overflow'); fresh.completeOne(); p.close();
  `);
  assert.equal(frames[0].length, 253);
  assert.equal(frames[1].length, 253);
  assert.equal(frames[1].at(-1).name, "fresh");
  assert.equal(frames[1].at(-1).completed, 1);
  assert.equal(frames[1][0].completed, 1);
});

test("automatic reports, initial delay, and exit report", async () => {
  const { frames } = await run(`
    const p=new Progress({name:'timer',initialDelay:0,refreshInterval:10});
    await delay(60); p.root.completeOne();
  `);
  assert.ok(frames.length >= 2);
  assert.equal(frames.at(-1)[0].completed, 1);
});

test("unreferenced timer does not keep the process alive", async () => {
  const { frames } = await run(
    `new Progress({name:'exit',initialDelay:100000});`,
    { timeout: 2000 },
  );
  assert.equal(frames[0][0].name, "exit");
});

test("dispose ends nodes and reporter", async () => {
  const { frames } = await run(`
    const p=new Progress({refreshInterval:null});
    const task=p.root.start('one'); task[Symbol.dispose](); p[Symbol.dispose]();
  `);
  assert.equal(frames[0][0].completed, 1);
  assert.equal(frames[0].length, 1);
});

test("disabled reporters have no output or exit listeners", () => {
  const before = process.listenerCount("exit");
  const p = new Progress({ disabled: true });
  p.root.start("task").end();
  p.root.completeOne();
  assert.equal(p.enabled, false);
  assert.equal(p.flush(), false);
  p.close();
  p.close();
  assert.equal(process.listenerCount("exit"), before);
});

for (const options of [
  { nameSize: null },
  { nameSize: 41 },
  { refreshInterval: 0 },
  { refreshInterval: -1 },
  { refreshInterval: Infinity },
  { refreshInterval: NaN },
  { initialDelay: -1 },
  { initialDelay: null },
  { initialDelay: 2147483648 },
  { fd: -1 },
  { fd: 65536 },
  { fd: 1.5 },
  { estimatedTotalItems: -1 },
  { estimatedTotalItems: null },
  { estimatedTotalItems: 1.2 },
  { name: 4 },
  { name: null },
  { disabled: null },
  { disabled: "false" },
]) {
  test(`invalid options: ${JSON.stringify(options)}`, () => {
    assert.throws(() => new Progress({ disabled: true, ...options }));
  });
}

test("invalid constructor inputs leave the progress descriptor available", async () => {
  await run(`
    for (const options of [null, false, 42, 'options', [], ()=>{}]) {
      assert.throws(()=>new Progress(options),TypeError);
    }
    for (const options of [
      {name:null}, {estimatedTotalItems:null}, {initialDelay:null},
      {nameSize:null}, {disabled:'false'},
    ]) {
      assert.throws(()=>new Progress({...options,fd:3}));
    }
    const p=new Progress({
      name:undefined,estimatedTotalItems:undefined,initialDelay:undefined,
      nameSize:undefined,disabled:undefined,refreshInterval:null,
    });
    assert.equal(p.enabled,true);assert.equal(p.flush(),true);p.close();
  `);
});

test("the reporter opens the same descriptor value that it validates", async () => {
  await run(`
    let reads=0;
    const p=new Progress({
      refreshInterval:null,
      get fd() {return ++reads===1 ? 3 : 65535;},
    });
    try {
      assert.equal(p.enabled,true);
      assert.equal(p.flush(),true);
    } finally {p.close();}
  `);
});

test("invalid updates fail even for disabled nodes", () => {
  const p = new Progress({ disabled: true });
  for (const count of [
    -1,
    NaN,
    Infinity,
    0.2,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ]) {
    assert.throws(() => p.root.setCompletedItems(count));
    assert.throws(() => p.root.setEstimatedTotalItems(count));
    assert.throws(() => p.root.increaseEstimatedTotalItems(count));
    assert.throws(() => p.root.start("x", count));
  }
  assert.throws(() => p.root.setName({}));
});

test("invalid environment and ordinary files disable reporting", () => {
  for (const value of [
    "",
    "-1",
    "+3",
    " 3",
    "3 ",
    "3.0",
    "65536",
    "９",
    "99999999999999999999",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {Progress} from 'zpjs';
      if(new Progress().enabled)process.exit(1);
    `,
      ],
      { env: { ...process.env, ZIG_PROGRESS: value } },
    );
    assert.equal(result.status, 0, result.stderr.toString());
  }
});
