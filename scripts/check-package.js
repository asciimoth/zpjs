import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "zpjs-package-"));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run test:package");

function run(args, cwd = directory) {
  return execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120000,
  });
}

try {
  // Skip lifecycle scripts here to avoid calling prepack recursively.
  const [archive] = JSON.parse(
    run(
      [
        npm,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        directory,
      ],
      root,
    ),
  );
  const paths = archive.files.map(({ path }) => path);
  for (const path of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    assert.ok(paths.includes(path), `Missing package file: ${path}`);
  }
  for (const path of paths) {
    assert.match(
      path,
      /^(package\.json|README\.md|LICENSE|dist\/[^/]+\.(js|d\.ts))$/,
      `Unexpected package file: ${path}`,
    );
  }

  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "zpjs-package-check", private: true }),
  );
  run([
    npm,
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(directory, archive.filename),
  ]);

  const assertions = `
    assert.equal(typeof Progress, "function");
    assert.equal(Node, ProgressNode);
    const progress = new Progress({ disabled: true });
    const task = progress.root.start("installed package", 1);
    task.completeOne();
    task.end();
    assert.equal(progress.flush(), false);
    progress.close();
  `;
  run([
    "--input-type=module",
    "-e",
    `import assert from "node:assert/strict";
     import { Progress, ProgressNode, Node } from "@asciimoth/zpjs";
     ${assertions}`,
  ]);
  run([
    "--input-type=commonjs",
    "-e",
    `const assert = require("node:assert/strict");
     const { Progress, ProgressNode, Node } = require("@asciimoth/zpjs");
     ${assertions}`,
  ]);

  // Check declarations through the installed export map in both module modes.
  for (const extension of ["mts", "cts"]) {
    copyFileSync(
      join(root, "tests/types.ts"),
      join(directory, `consumer.${extension}`),
    );
  }
  run([
    join(root, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--target",
    "ES2023",
    "--types",
    "node",
    "--typeRoots",
    join(root, "node_modules/@types"),
    "consumer.mts",
    "consumer.cts",
  ]);
  console.log(
    `Verified ${archive.filename}: contents, ESM, CommonJS, and TypeScript consumers.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
