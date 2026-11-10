import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const zpg = process.env.ZPJS_ZPG || "zpg";
const probe = spawnSync(zpg, ["--help"], { encoding: "utf8" });
const available =
  probe.status === 0 &&
  `${probe.stdout}${probe.stderr}`.includes("--test-output");
const required = process.env.ZPJS_REQUIRE_ZPG === "1";

test("zpg validates JS tasks, spawned processes, forks, and Zig child reports", {
  skip:
    !available && !required
      ? "zpg with --test support is not on PATH (or ZPJS_ZPG)"
      : false,
  timeout: 15000,
}, () => {
  assert.equal(
    available,
    true,
    "Install zpg or set ZPJS_ZPG to its executable",
  );
  const dir = fs.mkdtempSync(join(tmpdir(), "zpjs-zpg-"));
  try {
    const logPath = join(dir, "progress.log");
    const result = spawnSync(
      zpg,
      [
        "--test",
        "--test-output",
        logPath,
        process.execPath,
        "tests/fixtures/compat.js",
      ],
      {
        env: { ...process.env, ZPJS_ZPG: zpg },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    const log = fs.readFileSync(logPath, "utf8");
    assert.equal(result.status, 0, `${result.stderr}\n${log}`);
    assert.equal(result.stdout, "worker stdout\n");
    assert.equal(result.stderr, "worker stderr\n");
    assert.match(log, /protocol=no errors detected/);
    for (const name of [
      "JS root",
      "local",
      "spawn worker",
      "fork worker",
      "grandchild",
      "Zig child",
    ]) {
      assert.ok(log.includes(`name="${name}"`), log);
    }
    assert.match(log, /completed=3 total=8 name="Zig child"/);
    assert.match(log, /nodes=1 changed\n.*completed=4 total=3 name="JS root"/);
    assert.doesNotMatch(log, /incomplete|no progress received|protocol error/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
