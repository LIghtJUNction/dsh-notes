import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { MessageId } from '@deepseek-ai/dsh-llm';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import * as plugin from '../src/index.js';
import { createHost, textResponse, toolResponse } from './host.js';

async function fixture(t: TestContext, explicit = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notes-'));
  const host = await createHost(root);
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const fiber = await host.ctx.plugin(plugin, explicit ? { root } : {});
  return { ...host, root, fiber };
}
function success(result: ToolExecutionResult) {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.value;
}
function revision(result: ToolExecutionResult): string {
  const value = success(result);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && typeof value.revision === 'string');
  return value.revision;
}
function failure(result: ToolExecutionResult, pattern: RegExp) {
  assert.equal(result.isError, true, JSON.stringify(result));
  if (!result.isError) throw new Error('Expected failure');
  assert.match(result.error.message, pattern);
}

test('real ToolRuntime Markdown CRUD and template copy', async (t) => {
  const host = await fixture(t);
  const template = await host.execute('notes_create', { collection: 'templates', path: 'daily.md', content: '# Daily\n' });
  revision(template);
  const created = await host.execute('notes_create', { path: 'today.md', template: 'daily.md', content: 'Explicit excerpt.' });
  const rev = revision(created);
  assert.equal(await readFile(join(host.root, '.dsh-notes/notes/today.md'), 'utf8'), '# Daily\nExplicit excerpt.');
  assert.deepEqual(success(await host.execute('notes_list', {})), { paths: ['today.md'], limited: false });
  assert.deepEqual(success(await host.execute('notes_list', { collection: 'templates' })), { paths: ['daily.md'], limited: false });
  const updated = await host.execute('notes_update', { path: 'today.md', revision: rev, content: '# Updated' });
  assert.notEqual(revision(updated), rev);
  failure(await host.execute('notes_update', { path: 'today.md', revision: rev, content: 'stale' }), /stale revision/i);
  failure(await host.execute('notes_delete', { path: 'today.md', revision: rev }), /stale revision/i);
  success(await host.execute('notes_delete', { path: 'today.md', revision: revision(updated) }));
  assert.deepEqual(success(await host.execute('notes_list', {})), { paths: [], limited: false });
  failure(await host.execute('notes_read', { path: 'today.md' }), /ENOENT/);
});

test('concurrent creates and stale updates publish exactly one winner', async (t) => {
  const host = await fixture(t);
  const creates = await Promise.all(['a', 'b'].map((content) => host.execute('notes_create', { path: 'race.md', content })));
  assert.equal(creates.filter((result) => !result.isError).length, 1);
  const rev = revision(await host.execute('notes_read', { path: 'race.md' }));
  const updates = await Promise.all(['c', 'd'].map((content) => host.execute('notes_update', { path: 'race.md', revision: rev, content })));
  assert.equal(updates.filter((result) => !result.isError).length, 1);
  assert.deepEqual((await readdir(join(host.root, '.dsh-notes'))).sort(), ['notes', 'templates']);
  assert.deepEqual(await readdir(join(host.root, '.dsh-notes/notes')), ['race.md']);
});

test('reject traversal, symlinked files/directories, hardlinks and oversized Markdown', async (t) => {
  const host = await fixture(t);
  for (const path of ['../escape.md', '/tmp/escape.md', 'nested/a.md', 'bad\n.md', 'a.txt']) {
    failure(await host.execute('notes_create', { path, content: 'x' }), /filename/);
  }
  await writeFile(join(host.root, 'outside.md'), 'untouched');
  await symlink(join(host.root, 'outside.md'), join(host.root, '.dsh-notes/notes/link.md'));
  failure(await host.execute('notes_read', { path: 'link.md' }), /ELOOP|symbolic/);
  failure(await host.execute('notes_create', { path: 'link.md', content: 'x' }), /exists/);
  await link(join(host.root, 'outside.md'), join(host.root, '.dsh-notes/notes/hard.md'));
  failure(await host.execute('notes_read', { path: 'hard.md' }), /regular/);
  assert.equal(await readFile(join(host.root, 'outside.md'), 'utf8'), 'untouched');
  failure(await host.execute('notes_create', { path: 'big.md', content: 'x'.repeat(256 * 1024 + 1) }), /256 KiB/);
  await rm(join(host.root, '.dsh-notes/templates'), { recursive: true });
  await symlink(host.root, join(host.root, '.dsh-notes/templates'));
  failure(await host.execute('notes_list', { collection: 'templates' }), /symbolic/);
});

test('pre-abort, cross-process lock and plugin disposal leave no owned work', async (t) => {
  const host = await fixture(t);
  const controller = new AbortController(); controller.abort();
  assert.equal((await host.execute('notes_create', { path: 'abort.md', content: 'x' }, controller.signal)).isError, true);
  await host.execute('notes_list', {});
  const lock = join(host.root, '.dsh-notes/.write-lock');
  await writeFile(lock, 'external writer');
  failure(await host.execute('notes_create', { path: 'locked.md', content: 'x' }), /locked/);
  assert.equal(await readFile(lock, 'utf8'), 'external writer');
  await rm(lock);
  const pending = Array.from({ length: 12 }, (_, i) => host.execute('notes_create', { path: `queued-${i}.md`, content: 'x' }));
  await host.fiber.dispose();
  await Promise.all(pending);
  assert.equal((await host.execute('notes_list', {})).isError, true);
  const files = await readdir(join(host.root, '.dsh-notes/notes'));
  assert.ok(files.every((path) => !path.startsWith('.tmp-')));
  assert.ok(!(await readdir(join(host.root, '.dsh-notes'))).includes('.write-lock'));
});

test('offline model calls real notes tool using agent working directory without config.root', async (t) => {
  const host = await fixture(t, false);
  host.model.responses.push(toolResponse('notes_create', { path: 'model.md', content: '# Saved excerpt\nUser supplied text.' }), textResponse());
  const { agent } = await host.create();
  agent.followup({ id: MessageId('notes-prompt'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Explicitly save this excerpt as model.md' }] });
  await agent.whenIdle();
  assert.deepEqual(host.errors, []);
  assert.equal(host.model.requests.length, 2);
  assert.equal(await readFile(join(host.root, '.dsh-notes/notes/model.md'), 'utf8'), '# Saved excerpt\nUser supplied text.');
  assert.match(JSON.stringify(host.model.requests[1]), /revision/);
});

test('preexisting symlinked store is refused', async (t) => {
  const host = await fixture(t);
  const external = join(host.root, 'external'); await mkdir(external);
  await symlink(external, join(host.root, '.dsh-notes'));
  failure(await host.execute('notes_list', {}), /symbolic/);
  assert.deepEqual(await readdir(external), []);
});
