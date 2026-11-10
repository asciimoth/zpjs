import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "./helpers.js";

// Optional source checkout: no downloads or Python installation during tests.
test("zppy child and zpjs grandchild interoperate through real FIFOs", {
  skip: !process.env.ZPJS_ZPPY
    ? "Set ZPJS_ZPPY to the zppy src directory"
    : false,
}, async () => {
  const python = `
import os
from zppy import Progress
with Progress("python", refresh_rate=None) as p:
    assert p.enabled
    task = p.root.start("javascript")
    code = 'import {Progress} from "@asciimoth/zpjs"; const p=new Progress({name:"JS grandchild",refreshInterval:null}); p.root.setCompletedItems(6); p.close();'
    child = task.spawn([os.environ["NODE"], "--input-type=module", "-e", code])
    assert child.wait() == 0
    p.flush()
`;
  const { frames } = await run(`
    const p=new Progress({name:'JS parent',refreshInterval:null});
    const child=p.root.start('python placeholder').spawn('python3',['-c',${JSON.stringify(python)}],{
      env:{...process.env,PYTHONPATH:process.env.ZPJS_ZPPY,NODE:process.execPath},stdio:'inherit',
    });
    assert.equal((await once(child,'close'))[0],0);p.close();
  `);
  assert.deepEqual(
    frames[0].map((node) => node.name),
    ["JS parent", "python", "JS grandchild"],
  );
  assert.deepEqual(
    frames[0].map((node) => node.parent),
    [255, 0, 1],
  );
  assert.equal(frames[0][2].completed, 6);
});
