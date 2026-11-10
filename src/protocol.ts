import { Buffer } from "node:buffer";

export const MAX_NODES = 253;
export const MAX_COMPLETED = 0xffffffff;
export const MAX_TOTAL = 0xfffffffe;
export type NameSize = 40 | 120;
export type TaskName = string | Uint8Array;

export interface Record {
  completed: number;
  total: number;
  name: Buffer;
  parent: number;
}

export function count(value: number, limit: number): number {
  if (typeof value !== "number") throw new TypeError("count must be a number");
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("count must be a nonnegative safe integer");
  }
  return Math.min(value, limit);
}

export function wireName(value: TaskName, size: NameSize): Buffer {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new TypeError("name must be a string or Uint8Array");
  }
  // Buffer.write stops at a UTF-8 character boundary.
  const result = Buffer.alloc(size);
  if (typeof value === "string") {
    result.write(value.split("\0", 1)[0] ?? "", 0, size, "utf8");
  } else {
    const nul = value.indexOf(0);
    result.set(value.subarray(0, Math.min(size, nul < 0 ? value.length : nul)));
  }
  return result;
}

export function encode(records: readonly Record[], nameSize: NameSize): Buffer {
  const size = 8 + nameSize;
  const packet = Buffer.alloc(1 + records.length * (size + 1));
  packet[0] = records.length;
  records.forEach((record, index) => {
    const offset = 1 + index * size;
    packet.writeUInt32LE(record.completed, offset);
    packet.writeUInt32LE(record.total, offset + 4);
    record.name.copy(packet, offset + 8, 0, nameSize);
    packet[1 + records.length * size + index] = record.parent;
  });
  return packet;
}

// Validate the whole tree, including forward references. Return parent-first
// records so capacity limits cannot leave a descendant without its parent.
export function decode(packet: Buffer, nameSize: NameSize): Record[] | null {
  const length = packet[0];
  const size = 8 + nameSize;
  if (
    length === undefined ||
    length > MAX_NODES ||
    packet.length !== 1 + length * (size + 1)
  )
    return null;
  if (length === 0) return [];
  const parents = packet.subarray(1 + length * size);
  if (parents[0] !== 255) return null;
  const children: number[][] = Array.from({ length }, () => []);
  for (let index = 1; index < length; index++) {
    const parent = parents[index];
    if (parent === undefined || parent >= length) return null;
    children[parent]?.push(index);
  }
  const order = [0];
  for (let index = 0; index < order.length; index++) {
    order.push(...(children[order[index] ?? 0] ?? []));
  }
  if (order.length !== length) return null;
  const mapped = new Map(order.map((old, index) => [old, index]));
  const records: Record[] = [];
  for (const old of order) {
    const offset = 1 + old * size;
    const total = packet.readUInt32LE(offset + 4);
    if (total > MAX_TOTAL) return null;
    records.push({
      completed: packet.readUInt32LE(offset),
      total,
      name: wireName(packet.subarray(offset + 8, offset + size), nameSize),
      parent: old === 0 ? 255 : (mapped.get(parents[old] ?? 255) ?? 255),
    });
  }
  return records;
}

/** Bounded stream decoder. A bad frame stops this channel, not the reporter. */
export class Decoder {
  snapshot: Record[] = [];
  failed = false;
  #packet = Buffer.alloc(0);
  #offset = 0;
  constructor(private readonly nameSize: NameSize) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (!this.failed && offset < chunk.length) {
      if (this.#offset === 0) {
        const length = chunk[offset] ?? 255;
        if (length > MAX_NODES) {
          this.failed = true;
          break;
        }
        this.#packet = Buffer.alloc(1 + length * (9 + this.nameSize));
      }
      const bytes = Math.min(
        this.#packet.length - this.#offset,
        chunk.length - offset,
      );
      chunk.copy(this.#packet, this.#offset, offset, offset + bytes);
      this.#offset += bytes;
      offset += bytes;
      if (this.#offset === this.#packet.length) {
        const records = decode(this.#packet, this.nameSize);
        if (records === null) this.failed = true;
        else this.snapshot = records;
        this.#offset = 0;
        this.#packet = Buffer.alloc(0);
      }
    }
  }
}
