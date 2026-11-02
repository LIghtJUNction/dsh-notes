import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_BYTES = 256 * 1024;
export type Collection = 'notes' | 'templates';
const queues = new Map<string, Promise<void>>();

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function filename(path: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.md$/.test(path)) {
    throw new Error('Use a flat Markdown filename: letters, digits, dots, underscores or hyphens, ending in .md (max 123 characters)');
  }
  return path;
}
async function directory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed directory must not be a symbolic link');
}
export async function storeRoot(root: string): Promise<string> {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Host does not support no-follow filesystem reads');
  const canonical = await realpath(root);
  const managed = join(canonical, '.dsh-notes');
  await directory(managed);
  await directory(join(managed, 'notes'));
  await directory(join(managed, 'templates'));
  return managed;
}
async function verify(root: string, collection: Collection): Promise<string> {
  for (const path of [root, join(root, collection)]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed directory changed or is a symbolic link');
  }
  return join(root, collection);
}
function snapshot(path: string, content: string) {
  return { path, content, revision: createHash('sha256').update(content).digest('hex') };
}
export async function read(root: string, collection: Collection, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const target = join(await verify(root, collection), filename(path));
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Expected a regular, single-link Markdown file of at most 256 KiB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('Markdown exceeds 256 KiB');
    signal.throwIfAborted();
    return snapshot(path, buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}
export async function list(root: string, collection: Collection, signal: AbortSignal) {
  signal.throwIfAborted();
  const entries = await readdir(await verify(root, collection), { withFileTypes: true });
  const paths = entries.filter((entry) => entry.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.md$/.test(entry.name)).map((entry) => entry.name).sort();
  signal.throwIfAborted();
  return { paths: paths.slice(0, 1000), limited: paths.length > 1000 };
}
export async function exclusive<T>(root: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  queues.set(root, pending);
  await previous;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal.throwIfAborted();
    await verify(root, 'notes');
    try { lock = await open(join(root, '.write-lock'), 'wx', 0o600); } catch {
      throw new Error('Notes store is locked by another process; retry later (after a crash remove .write-lock only when no writer is active)');
    }
    signal.throwIfAborted();
    return await task();
  } finally {
    try {
      if (lock) { await lock.close(); await unlink(join(root, '.write-lock')); }
    } finally {
      release();
      if (queues.get(root) === pending) queues.delete(root);
    }
  }
}
export async function write(root: string, collection: Collection, path: string, content: string, revision: string | null, signal: AbortSignal) {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Markdown exceeds 256 KiB');
  const target = join(await verify(root, collection), filename(path));
  const validate = async () => {
    signal.throwIfAborted();
    await verify(root, collection);
    if (revision === null) {
      try { await lstat(target); } catch (error) { if (missing(error)) return; throw error; }
      throw new Error('Markdown already exists');
    }
    const current = await read(root, collection, path, signal);
    if (current.revision !== revision) throw new Error('Stale revision; read the current Markdown before updating');
  };
  await validate();
  const temp = join(root, collection, `.tmp-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, { encoding: 'utf8', signal });
    await handle.sync();
    await handle.close();
    await validate();
    signal.throwIfAborted();
    await rename(temp, target);
    return snapshot(path, content);
  } finally {
    await handle.close();
    await unlink(temp).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
}
export async function remove(root: string, collection: Collection, path: string, revision: string, signal: AbortSignal) {
  const current = await read(root, collection, path, signal);
  if (current.revision !== revision) throw new Error('Stale revision; read the current Markdown before deleting');
  const target = join(await verify(root, collection), filename(path));
  signal.throwIfAborted();
  await unlink(target);
  return { path, deleted: true };
}
