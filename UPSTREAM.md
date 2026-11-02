# Upstream provenance

- Source: [https://github.com/narumiruna/pi-extensions/tree/a0e0079303415a1eb0eb58f68538a593c58182e5/packages/pi-notes](https://github.com/narumiruna/pi-extensions/tree/a0e0079303415a1eb0eb58f68538a593c58182e5/packages/pi-notes)
- Repository: https://github.com/narumiruna/pi-extensions
- Pinned commit: `a0e0079303415a1eb0eb58f68538a593c58182e5` (read from GitHub API before implementation).
- Package license: MIT, Copyright (c) 2026 narumiruna. Full upstream attribution and permission text are included in `NOTICE`.
- Reviewed actual sources: `src/index.ts`, `src/notes-extension.ts`, `src/storage.ts`, `src/constants.ts`, `src/workspace.ts`, and package LICENSE at the pinned commit.

## Migration differences

- Upstream registers `/notes`, global agent-dir storage, note picker, template editor, split-pane Markdown workspace and isolated Pi child sessions.
- This independent DSH implementation registers `notes_list/read/create/update/delete` using `defineTool` and real ToolRuntime output contracts; storage is scoped to `.dsh-notes` inside a host-local workspace.
- Retains the intent of Markdown templates, bounded reads, content revisions and atomic replacement. Uses a process-local queue plus an exclusive cooperating-process lock. No dependency on Pi's file mutation queue or terminal sanitizer.
- First release uses flat ASCII Markdown names and full replacements. It does not implement Pi TUI, child sessions, global notes, note renames, automatic names, interactive substring edits, or automatic conversation recall. Conversation excerpts are only explicitly supplied text saved by `notes_create`; DSH session search remains separate.

All filesystem access is host-local Node filesystem access. These are DSH-native migrations of the feature intent, not Pi extension compatibility wrappers. No Pi TUI or remote filesystem compatibility is claimed. Runtime target is DSH 0.2.1-rc.2 and Node 24+.
