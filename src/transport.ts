import { Buffer } from "node:buffer";
import fs from "node:fs";
import { Socket } from "node:net";

const owners = new Set<number>();

export function environmentFd(value: string | undefined): number | undefined {
  if (!value || !/^[0-9]+$/.test(value)) return undefined;
  const fd = Number(value);
  return Number.isInteger(fd) && fd <= 65535 ? fd : undefined;
}

/** Own a pipe or Node's socket-based stdio channel, with bounded output. */
export class Transport {
  #socket: Socket;
  #pending: Buffer | undefined;
  #lastSent: Buffer | undefined;
  #offset = 0;
  #closed = false;

  static open(fd: number): Transport | undefined {
    if (process.platform === "win32" || owners.has(fd)) return undefined;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFIFO() && !stat.isSocket()) return undefined;
      // A zero-byte write rejects read-only pipe ends without changing data or
      // flags. Check before taking ownership or changing the blocking mode.
      fs.writeSync(fd, Buffer.alloc(0));
      // libuv sets O_NONBLOCK. Socket owns fd, as in Node's net.Socket API.
      const socket = new Socket({ fd, readable: false, writable: true });
      socket.unref();
      return new Transport(fd, socket);
    } catch {
      return undefined;
    }
  }

  private constructor(
    private readonly fd: number,
    socket: Socket,
  ) {
    this.#socket = socket;
    owners.add(fd);
    socket.on("error", () => this.close());
    // Keep the ownership guard until libuv actually releases the descriptor.
    socket.once("close", () => owners.delete(fd));
  }

  get enabled(): boolean {
    return !this.#closed;
  }

  send(packet: Buffer, final = false): boolean {
    if (this.#closed) return false;
    // Do not start a final duplicate, including one queued on a full pipe.
    // Once any bytes were sent, the pending frame must still be completed.
    if (final && this.#offset === 0 && this.#lastSent?.equals(packet)) {
      this.#pending = undefined;
      return true;
    }
    // Finish an earlier partial frame before starting the current snapshot.
    if (this.#pending) {
      const unchanged = this.#pending.equals(packet);
      if (!this.#drain()) return false;
      if (unchanged) return true;
    }
    this.#pending = packet;
    this.#offset = 0;
    return this.#drain();
  }

  #drain(): boolean {
    const packet = this.#pending;
    if (!packet) return true;
    try {
      // One syscall per frame per flush. Do not spin on a full pipe or EINTR.
      const bytes = fs.writeSync(
        this.fd,
        packet,
        this.#offset,
        packet.length - this.#offset,
      );
      this.#offset += bytes;
      if (this.#offset !== packet.length) return false;
      this.#lastSent = packet;
      this.#pending = undefined;
      this.#offset = 0;
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EINTR")
        this.close();
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = undefined;
    this.#lastSent = undefined;
    this.#socket.destroy();
  }
}
