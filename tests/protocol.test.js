import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { Decoder, decode, encode, wireName } from "../dist/protocol.js";
import { environmentFd } from "../dist/transport.js";

function record(name, parent = 255, total = 7) {
  return { name: wireName(name, 40), parent, total, completed: 3 };
}

for (const size of [40, 120]) {
  test(`exact wire layout and zero padding (${size})`, () => {
    const packet = encode(
      [
        {
          name: wireName("abc", size),
          parent: 255,
          total: 0x10203040,
          completed: 0x50607080,
        },
      ],
      size,
    );
    const expected = Buffer.alloc(1 + 9 + size);
    expected[0] = 1;
    expected.set(
      [0x80, 0x70, 0x60, 0x50, 0x40, 0x30, 0x20, 0x10, 97, 98, 99],
      1,
    );
    expected[expected.length - 1] = 255;
    assert.deepEqual(packet, expected);
  });

  test(`UTF-8, NUL, and byte names (${size})`, () => {
    assert.equal(
      wireName(`${"a".repeat(size - 1)}€`, size).toString(),
      `${"a".repeat(size - 1)}\0`,
    );
    assert.equal(wireName("x\0rest", size)[1], 0);
    const source = new Uint8Array([255, 128, 0, 1]);
    const result = wireName(source, size);
    source[0] = 0;
    assert.deepEqual([...result.subarray(0, 4)], [255, 128, 0, 0]);
    assert.equal(wireName("a".repeat(size * 2), size).length, size);
    assert.equal(
      wireName("é".repeat(size / 2), size).toString(),
      "é".repeat(size / 2),
    );
  });
}

test("decoder accepts forward parents and orders the tree", () => {
  const result = decode(
    encode([record("root"), record("leaf", 2), record("branch", 0)], 40),
    40,
  );
  assert.deepEqual(
    result.map((r) => r.name[0]),
    [114, 98, 108],
  );
  assert.deepEqual(
    result.map((r) => r.parent),
    [255, 0, 1],
  );
});

for (const parents of [
  [0],
  [255, 255],
  [255, 254],
  [255, 1],
  [255, 2, 1],
  [255, 3],
]) {
  test(`decoder rejects invalid tree ${parents}`, () => {
    assert.equal(
      decode(
        encode(
          parents.map((p) => record("x", p)),
          40,
        ),
        40,
      ),
      null,
    );
  });
}

test("decoder rejects invalid length and reserved values", () => {
  for (const packet of [
    Buffer.alloc(0),
    Buffer.from([254]),
    Buffer.from([255]),
    Buffer.from([1]),
    encode([record("x", 255, 0xffffffff)], 40),
  ]) {
    assert.equal(decode(packet, 40), null);
  }
  assert.deepEqual(decode(Buffer.from([0]), 40), []);
});

test("stream decoder handles every split, coalesced frames, and empty frames", () => {
  const a = encode([record("first"), record("nested", 0)], 40);
  const b = encode([record("last")], 40);
  const bytes = Buffer.concat([a, b]);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new Decoder(40);
    decoder.push(bytes.subarray(0, split));
    decoder.push(bytes.subarray(split));
    assert.equal(decoder.failed, false);
    assert.deepEqual(decoder.snapshot, decode(b, 40));
  }
  const decoder = new Decoder(40);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(decoder.snapshot, decode(b, 40));
  decoder.push(Buffer.from([0]));
  assert.deepEqual(decoder.snapshot, []);
});

test("bad or incomplete frames cannot replace the last valid tree", () => {
  const good = encode([record("good")], 40);
  for (const bad of [Buffer.from([254]), encode([record("bad", 0)], 40)]) {
    const decoder = new Decoder(40);
    decoder.push(good);
    decoder.push(bad);
    decoder.push(good);
    assert.equal(decoder.failed, true);
    assert.deepEqual(decoder.snapshot, decode(good, 40));
  }
  const decoder = new Decoder(40);
  decoder.push(good);
  decoder.push(good.subarray(0, 7));
  assert.deepEqual(decoder.snapshot, decode(good, 40));
});

test("environment fd parser follows unsigned decimal range", () => {
  for (const [value, expected] of [
    [undefined, undefined],
    ["0", 0],
    ["65535", 65535],
    ["0003", 3],
    [`${"0".repeat(1000)}3`, 3],
    ["+3", undefined],
    ["3\n", undefined],
    ["65536", undefined],
  ]) {
    assert.equal(environmentFd(value), expected);
  }
});
