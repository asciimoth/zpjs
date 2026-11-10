import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Node's stdio pipes are sockets on Unix. Use a FIFO for POSIX clients. */
export function childPipe(): {
  reader: Socket;
  writer: number;
  readFd: number;
} {
  const directory = fs.mkdtempSync(join(tmpdir(), "zpjs-"));
  const path = join(directory, "progress");
  let readerFd: number | undefined;
  let writer: number | undefined;
  try {
    // Node has no public pipe(2) or mkfifo(2) API. The private directory prevents
    // other users from opening the FIFO before it is unlinked.
    const env = { ...process.env };
    delete env.ZIG_PROGRESS;
    const result = spawnSync("mkfifo", ["-m", "600", path], {
      env,
      stdio: "pipe",
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`mkfifo failed: ${result.stderr.toString().trim()}`);
    readerFd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
    writer = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    const reader = new Socket({
      fd: readerFd,
      readable: false,
      writable: false,
    });
    const readFd = readerFd;
    readerFd = undefined;
    return { reader, writer, readFd };
  } catch (error) {
    if (readerFd !== undefined) fs.closeSync(readerFd);
    if (writer !== undefined) fs.closeSync(writer);
    throw error;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
