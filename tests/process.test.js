import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "./helpers.js";

const worker = new URL("./fixtures/worker.js", import.meta.url).href;
const workerPath = fileURLToPath(worker);

for (const disabled of [false, true]) {
  test(`spawn preserves inherited environment entries (disabled: ${disabled})`, async () => {
    const { stdout } = await run(`
      const p=new Progress({disabled:${disabled},refreshInterval:null});
      const inherited={ZPJS_TEST_VALUE:'inherited',ZIG_PROGRESS:'123'};
      const env=Object.create(inherited);
      env.ZPJS_TEST_OWN='own';
      try {
        const child=p.root.spawn(process.execPath,['-e',
          'console.log(JSON.stringify([process.env.ZPJS_TEST_VALUE,process.env.ZPJS_TEST_OWN,process.env.ZIG_PROGRESS??null]))'],{env});
        child.stdout.pipe(process.stdout);
        assert.equal((await once(child,'close'))[0],0);
        assert.equal(Object.hasOwn(env,'ZIG_PROGRESS'),false);
        assert.equal(inherited.ZIG_PROGRESS,'123');
      } finally {p.close();}
    `);
    assert.deepEqual(JSON.parse(stdout), [
      "inherited",
      "own",
      disabled ? null : "3",
    ]);
  });

  test(`spawn ignores inherited process options (disabled: ${disabled})`, async () => {
    await run(`
      const p=new Progress({disabled:${disabled},refreshInterval:null});
      try {
        const options=Object.create({stdio:'ignore',env:{ZPJS_TEST_VALUE:'unexpected'}});
        const child=p.root.spawn(process.execPath,['-e',
          'if(process.env.ZPJS_TEST_VALUE)process.exit(1)'],options);
        assert.ok(child.stdout);
        assert.equal((await once(child,'close'))[0],0);
      } finally {p.close();}
    `);
  });
}

test("disabled children cannot inherit a progress value from Object.prototype", async () => {
  const { stdout } = await run(`
    const p=new Progress({disabled:true});
    let child;
    try {
      Object.defineProperty(Object.prototype,'ZIG_PROGRESS',{
        value:'123',enumerable:true,configurable:true,writable:true,
      });
      child=p.root.spawn(process.execPath,['-e',
        'console.log(process.env.ZIG_PROGRESS??"none")'],{env:{}});
    } finally {
      delete Object.prototype.ZIG_PROGRESS;
      p.close();
    }
    child.stdout.pipe(process.stdout);
    assert.equal((await once(child,'close'))[0],0);
  `);
  assert.equal(stdout, "none\n");
});

for (const disabled of [false, true]) {
  test(`spawn rejects null options before launch (disabled: ${disabled})`, async () => {
    await run(`
      const p=new Progress({disabled:${disabled},refreshInterval:null});
      try {
        for (const args of [[], undefined, null]) {
          assert.throws(()=>{
            const child=p.root.spawn(process.execPath,args,null);
            child.stdin?.end();
            child.on('error',()=>{});
          },TypeError);
        }
        const child=p.root.spawn(process.execPath,['-e','']);
        assert.equal((await once(child,'close'))[0],0);
      } finally {p.close();}
    `);
  });
}

test("fork accepts null options like Node.js", async () => {
  await run(`
    const p=new Progress({refreshInterval:null});
    try {
      const child=p.root.fork(new URL(${JSON.stringify(worker)}),[],null);
      assert.equal((await once(child,'close'))[0],0);
    } finally {p.close();}
  `);
});

for (const method of ["spawn", "fork"]) {
  for (const nameSize of [40, 120]) {
    test(`${method} grafts child tree and retains it after exit (${nameSize})`, async () => {
      const { frames } = await run(
        `
        const p=new Progress({name:'parent',refreshInterval:null,nameSize:${nameSize}});
        const task=p.root.start('placeholder');
        const env={...process.env,NAME_SIZE:'${nameSize}'};
        const before={...env}; const stdio=['ignore','pipe','pipe',${method === "fork" ? "'ipc'," : ""}'pipe'];
        const original=[...stdio];
        const child=task.${method}(${method === "fork" ? `new URL(${JSON.stringify(worker)})` : `process.execPath,[${JSON.stringify(workerPath)}]`},{env,stdio});
        assert.deepEqual(env,before);assert.deepEqual(stdio,original);
        assert.equal(process.env.ZIG_PROGRESS,'3');
        p.flush();
        const [code]=await once(child,'close');assert.equal(code,0);
        p.flush(); await delay(10); p.flush();
        assert.throws(()=>task.spawn(process.execPath,['-e','']),/already attached/);
        task.end();p.close();
      `,
        { nameSize },
      );
      assert.equal(frames[0][1].name, "placeholder");
      assert.deepEqual(frames[1], [
        { name: "parent", parent: 255, completed: 0, total: 0 },
        { name: "worker", parent: 0, completed: 4, total: 10 },
        { name: "leaf", parent: 1, completed: 1, total: 3 },
      ]);
      assert.deepEqual(frames[1], frames[2]);
      assert.equal(frames.at(-1)[0].completed, 1);
      assert.equal(frames.at(-1).length, 1);
    });
  }
}

test("fork preserves bidirectional IPC and silent stdio", async () => {
  const { frames, stdout, stderr } = await run(`
    const p=new Progress({refreshInterval:null});
    const child=p.root.start('fork').fork(new URL(${JSON.stringify(worker)}),{silent:true,env:{...process.env,WAIT_IPC:'1',LOGS:'1'}});
    child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
    const [message]=await once(child,'message');assert.equal(message.ready,true);
    assert.notEqual(message.channel,'3'); child.send({update:7});
    const [code]=await once(child,'close');assert.equal(code,0);p.close();
  `);
  assert.equal(frames.at(-1)[1].completed, 7);
  assert.equal(stdout, "worker stdout\n");
  assert.equal(stderr, "worker stderr\n");
});

test("nested forks and concurrent children have separate trees", async () => {
  const { frames } = await run(`
    const p=new Progress({name:'parent',refreshInterval:5,initialDelay:0});
    const a=p.root.start('a').fork(new URL(${JSON.stringify(worker)}),[],{env:{...process.env,NESTED:'1',WORKER_NAME:'first'}});
    const b=p.root.start('b').spawn(process.execPath,[${JSON.stringify(workerPath)}],{env:{...process.env,WORKER_NAME:'second'}});
    const results=await Promise.all([once(a,'close'),once(b,'close')]);
    assert.deepEqual(results.map(r=>r[0]),[0,0]);p.close();
  `);
  const last = frames.at(-1);
  assert.deepEqual(
    last.map((r) => r.name),
    ["parent", "first", "second", "leaf", "grandchild", "leaf", "leaf"],
  );
  assert.deepEqual(
    last.map((r) => r.parent),
    [255, 0, 0, 1, 1, 4, 2],
  );
});

test("unnamed child root keeps the local task name", async () => {
  const { frames } = await run(`
    const p=new Progress({refreshInterval:null});
    const c=p.root.start('label').fork(new URL(${JSON.stringify(worker)}),{env:{...process.env,WORKER_NAME:''}});
    assert.equal((await once(c,'close'))[0],0);p.close();
  `);
  assert.equal(frames[0][1].name, "label");
  assert.equal(frames[0][1].completed, 4);
});

for (const mode of ["disabled", "ended", "closed"]) {
  test(`${mode} nodes run children with progress removed`, async () => {
    const { stdout } = await run(`
      const p=new Progress({disabled:${mode === "disabled"},refreshInterval:null});
      const node=p.root.start('task');
      ${mode === "ended" ? "node.end();" : mode === "closed" ? "p.close();" : ""}
      const env={...process.env,ZIG_PROGRESS:'123'};
      const c=node.spawn(process.execPath,['-e','console.log(process.env.ZIG_PROGRESS ?? "none")'],{env});
      c.stdout.pipe(process.stdout);assert.equal((await once(c,'close'))[0],0);
      assert.equal(env.ZIG_PROGRESS,'123');p.close();
    `);
    assert.equal(stdout, "none\n");
  });
}

test("spawn failures release the attachment and preserve Node error events", async () => {
  const { frames } = await run(`
    const p=new Progress({refreshInterval:null});const task=p.root.start('retry');
    assert.throws(()=>task.spawn('x',[],{stdio:'invalid'}));
    assert.throws(()=>task.fork(new URL(${JSON.stringify(worker)}),{stdio:['ignore','ignore','ignore']}));
    assert.throws(()=>task.spawn('bad\\0command'));
    const failed=task.spawn('/no/such/zpjs-command');
    let error;failed.on('error',e=>{error=e});
    await new Promise(resolve=>failed.once('close',resolve));assert.equal(error.code,'ENOENT');
    const child=task.spawn(process.execPath,[${JSON.stringify(workerPath)}]);
    assert.equal((await once(child,'close'))[0],0);p.close();
  `);
  assert.equal(frames[0][1].name, "worker");
});

test("AbortSignal and process exit codes retain Node behavior", async () => {
  await run(`
    const p=new Progress({refreshInterval:null});
    const controller=new AbortController();
    const c=p.root.start('abort').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
    let error;c.on('error',e=>{error=e});
    const closed=new Promise(resolve=>c.once('close',resolve));controller.abort();await closed;
    assert.equal(error.name,'AbortError');
    const other=p.root.start('exit').spawn(process.execPath,['-e','process.exit(7)']);
    assert.equal((await once(other,'close'))[0],7);p.close();
  `);
});

test("ending a node and closing a reporter do not kill its process", async () => {
  const { stdout } = await run(`
    const p=new Progress({refreshInterval:null}); const task=p.root.start('still running');
    const c=task.spawn(process.execPath,['-e','setTimeout(()=>console.log("alive"),80)']);
    c.stdout.pipe(process.stdout);task.end();p.close();
    assert.equal((await once(c,'close'))[0],0);
  `);
  assert.equal(stdout, "alive\n");
});

test("spawn preserves shell, cwd, env, input, output, and extra descriptors", async () => {
  const { stdout } = await run(`
    const p=new Progress({refreshInterval:null});
    const env={TEST_VALUE:'present',PATH:process.env.PATH};
    const c=p.root.spawn('cat; printf "%s" "$TEST_VALUE"',{shell:true,cwd:'/',env,stdio:['pipe','pipe','pipe','pipe']});
    c.stdout.pipe(process.stdout);c.stdin.end('input:');
    assert.equal((await once(c,'close'))[0],0);assert.equal(env.ZIG_PROGRESS,undefined);p.close();
  `);
  assert.equal(stdout, "input:present");
});

test("a malformed child cannot corrupt other task reports", async () => {
  const { frames } = await run(`
    const p=new Progress({name:'parent',refreshInterval:null});
    const task=p.root.start('bad');
    const c=task.spawn(process.execPath,['-e',
      'require("node:fs").writeSync(Number(process.env.ZIG_PROGRESS),Buffer.from([255]))']);
    assert.equal((await once(c,'close'))[0],0);p.close();
  `);
  assert.deepEqual(
    frames[0].map((r) => r.name),
    ["parent", "bad"],
  );
});

for (const nameSize of [40, 120]) {
  test(`partial and malformed child reports retain the last valid tree (${nameSize})`, async () => {
    // Build wire bytes independently of the library encoder. IPC confirms that
    // each write has finished before the parent collects the private pipe.
    const source = `
      import {writeSync} from 'node:fs';
      const fd=Number(process.env.ZIG_PROGRESS);
      const packet=Buffer.alloc(1+9+${nameSize});
      packet[0]=1;
      packet.writeUInt32LE(1,1);
      packet.write('child',9);
      packet[packet.length-1]=255;
      writeSync(fd,packet);
      packet.writeUInt32LE(2,1);
      writeSync(fd,packet.subarray(0,11));
      process.send('partial');
      process.on('message',message=>{
        if(message==='finish') {
          writeSync(fd,packet.subarray(11));
          process.send('complete');
        } else {
          const bad=Buffer.from(packet);
          bad[bad.length-1]=0; // The root cannot be its own parent.
          packet.writeUInt32LE(3,1);
          writeSync(fd,Buffer.concat([bad,packet]));
          process.send('bad');
          process.disconnect();
        }
      });
    `;
    const { frames } = await run(
      `
      const p=new Progress({name:'parent',refreshInterval:null,nameSize:${nameSize}});
      const task=p.root.start('placeholder');
      const other=p.root.start('other');
      const child=task.spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(source)}],{
        stdio:['ignore','ignore','inherit','ipc'],
      });
      const closed=once(child,'close');
      try {
        assert.equal((await once(child,'message'))[0],'partial');
        p.flush();
        child.send('finish');
        assert.equal((await once(child,'message'))[0],'complete');
        p.flush();
        child.send('bad');
        assert.equal((await once(child,'message'))[0],'bad');
        other.completeOne();p.flush();
        assert.equal((await closed)[0],0);
        other.completeOne();p.flush();
      } finally {child.kill();p.close();}
    `,
      { nameSize },
    );
    assert.deepEqual(
      frames.map((frame) => frame[1].completed),
      [1, 2, 2, 2],
    );
    assert.deepEqual(
      frames.map((frame) => frame[2].completed),
      [0, 0, 1, 2],
    );
    for (const frame of frames) {
      assert.deepEqual(
        frame.map((node) => node.name),
        ["parent", "child", "other"],
      );
      assert.deepEqual(
        frame.map((node) => node.parent),
        [255, 0, 0],
      );
    }
  });
}

test("local tasks take priority when a child tree exceeds capacity", async () => {
  const { frames } = await run(`
    const p=new Progress({name:'parent',refreshInterval:null});
    const task=p.root.start('child');
    const nodes=Array.from({length:250},(_,i)=>p.root.start('local'+i));
    const child=task.fork(new URL(${JSON.stringify(worker)}));
    assert.equal((await once(child,'close'))[0],0);p.flush();
    nodes[0].end();p.close();
  `);
  assert.equal(frames[0].length, 253);
  assert.equal(frames[0][1].name, "worker");
  assert.equal(frames[0].at(-1).name, "leaf");
  assert.equal(frames[0].at(-1).parent, 1);
  assert.equal(frames[1].length, 252);
});

test("explicit undefined args preserve third-argument options", async () => {
  const { stdout } = await run(`
    const p=new Progress({refreshInterval:null});
    const c=p.root.spawn('printf "argument options"',undefined,{shell:true});
    c.stdout.pipe(process.stdout);assert.equal((await once(c,'close'))[0],0);p.close();
  `);
  assert.equal(stdout, "argument options");
});

test("missing mkfifo fails cleanly and the task remains reusable", async () => {
  await run(`
    const p=new Progress({refreshInterval:null});const task=p.root.start('retry');
    const path=process.env.PATH;process.env.PATH='/no/such/directory';
    try { assert.throws(()=>task.spawn(process.execPath,['-e','']),{code:'ENOENT'}); }
    finally {process.env.PATH=path;}
    const c=task.spawn(process.execPath,['-e','']);assert.equal((await once(c,'close'))[0],0);p.close();
  `);
});

test("extra caller descriptors are usable and separate from progress", async () => {
  const { stdout } = await run(`
    const p=new Progress({refreshInterval:null});
    const c=p.root.spawn(process.execPath,['-e',
      'require("node:fs").writeSync(4,"extra");console.log(process.env.ZIG_PROGRESS)'],
      {stdio:['ignore','pipe','pipe','pipe','pipe']});
    let extra='';c.stdio[4].on('data',b=>extra+=b);c.stdout.pipe(process.stdout);
    assert.equal((await once(c,'close'))[0],0);assert.equal(extra,'extra');p.close();
  `);
  assert.equal(stdout, "5\n");
});

test("private progress channels do not prevent ChildProcess.unref", async () => {
  await run(
    `
    const p=new Progress({refreshInterval:null});
    const child=p.root.spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'ignore'});
    child.unref();
  `,
    { timeout: 800 },
  );
});

test("disabled fork preserves IPC and removes the inherited progress value", async () => {
  await run(`
    import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    const directory=mkdtempSync(join(tmpdir(),'zpjs-disabled-'));
    try {
      const script=join(directory,'child.cjs');
      writeFileSync(script,'process.send({progress:process.env.ZIG_PROGRESS??null});process.disconnect()');
      const p=new Progress({disabled:true});
      const child=p.root.fork(script,{env:{...process.env,ZIG_PROGRESS:'123'}});
      const done=once(child,'close');const [message]=await once(child,'message');
      assert.deepEqual(message,{progress:null});assert.equal((await done)[0],0);p.close();
    } finally {rmSync(directory,{recursive:true});}
  `);
});
