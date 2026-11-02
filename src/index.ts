import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool, type ToolRunContext, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { workspace } from './support.js';
import { exclusive, list, read, remove, storeRoot, write } from './storage.js';

export const name = 'dsh-notes';
export const inject = ['tools'];
export const Config = Schema.object({ root: Schema.string().description('Host-local workspace root; defaults to the calling agent working directory') });
export type Config = ReturnType<typeof Config>;

export function apply(ctx: Context, config: Config) {
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Notes plugin disposed'));
    await Promise.allSettled([...active]);
  });
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, content: { type: 'string', required: true }, revision: { type: 'string', required: true } } } satisfies ValueSchemaSpec,
    render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }],
  };
  const listOutput = { ...output, schema: { type: 'object', additionalProperties: false, properties: { paths: { type: 'array', items: { type: 'string' }, required: true }, limited: { type: 'boolean', required: true } } } satisfies ValueSchemaSpec };
  const deleteOutput = { ...output, schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, deleted: { type: 'boolean', required: true } } } satisfies ValueSchemaSpec };
  function run<T>(exec: ToolRunContext, task: (root: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([exec.signal, lifetime.signal]);
    const pending = (async () => {
      signal.throwIfAborted();
      const root = await storeRoot(workspace(ctx, exec, config.root));
      signal.throwIfAborted();
      return exclusive(root, signal, () => task(root, signal));
    })();
    active.add(pending);
    void pending.then(() => active.delete(pending), () => active.delete(pending));
    return pending;
  }
  ctx.tools.register(defineTool({
    name: 'notes_list', description: 'List explicitly saved local Markdown notes or templates (at most 1000). Does not search DSH sessions.',
    parameters: { collection: { type: 'string', enum: ['notes', 'templates'] } }, output: listOutput,
    async execute(args, exec) { return run(exec, (root, signal) => list(root, args.collection ?? 'notes', signal)); },
  }));
  ctx.tools.register(defineTool({
    name: 'notes_read', description: 'Read a local Markdown note/template and its SHA-256 content revision.',
    parameters: { path: { type: 'string', required: true }, collection: { type: 'string', enum: ['notes', 'templates'] } }, output,
    async execute(args, exec) { return run(exec, (root, signal) => read(root, args.collection ?? 'notes', args.path, signal)); },
  }));
  ctx.tools.register(defineTool({
    name: 'notes_create', description: 'Explicitly save a Markdown note or supplied conversation excerpt. Optionally copy a named template, appending content. No automatic session capture.',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true }, template: { type: 'string' }, collection: { type: 'string', enum: ['notes', 'templates'] } }, output,
    async execute(args, exec) {
      return run(exec, async (root, signal) => {
        const prefix = args.template ? (await read(root, 'templates', args.template, signal)).content : '';
        return write(root, args.collection ?? 'notes', args.path, prefix + args.content, null, signal);
      });
    },
  }));
  ctx.tools.register(defineTool({
    name: 'notes_update', description: 'Replace a complete note/template only when the expected revision still matches. Read again after a stale revision error.',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true }, revision: { type: 'string', required: true }, collection: { type: 'string', enum: ['notes', 'templates'] } }, output,
    async execute(args, exec) { return run(exec, (root, signal) => write(root, args.collection ?? 'notes', args.path, args.content, args.revision, signal)); },
  }));
  ctx.tools.register(defineTool({
    name: 'notes_delete', description: 'Delete a note/template only when its expected content revision still matches. Permanent deletion.',
    parameters: { path: { type: 'string', required: true }, revision: { type: 'string', required: true }, collection: { type: 'string', enum: ['notes', 'templates'] } }, output: deleteOutput,
    async execute(args, exec) { return run(exec, (root, signal) => remove(root, args.collection ?? 'notes', args.path, args.revision, signal)); },
  }));
}
