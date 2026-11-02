# dsh-notes

DSH `0.2.1-rc.2` 的 Markdown 笔记工具。笔记和模板保存在工作区的 `.dsh-notes/notes`、`.dsh-notes/templates`，更新、删除必须携带上次读取的内容 revision。面向 Node 24+；本地验收环境为 Node 26。

## 安装

GitHub Release 发布 `v0.1.0` 后，可安装其 npm tarball；此说明不表示版本已经发布：

```sh
dsh plugin --profile tui add https://github.com/LIghtJUNction/dsh-notes/releases/download/v0.1.0/lightjunction-dsh-notes-0.1.0.tgz
```

软件包自带 `cordis.patch.yml`，注册 `dsh-notes`。在 profile 自己的 `cordis.patch.yml` 或 `--patch` overlay 中配置：

```yaml
- id: dsh-notes
  config:
    root: /absolute/path/to/project
```

不设置 `root` 时，使用调用 agent 的 workingDirectory 服务；没有 agent 的直接工具调用必须提供 root。**所有文件操作均使用 DSH 进程所在主机的 Node filesystem**，不是远程 world，也不是 sandbox 文件系统。仅在 host-local 工作区启用；远程执行器路径即使同名，也不会自动映射到远程文件。

## 工具与示例

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `notes_list` | `collection?` | 按名称列出笔记或模板，最多 1000 项，超出时 `limited: true` |
| `notes_read` | `path`, `collection?` | 返回 `{path, content, revision}` |
| `notes_create` | `path`, `content`, `template?`, `collection?` | 创建新文件，拒绝覆盖；模板原文加在 content 前，不自动添加换行 |
| `notes_update` | `path`, `content`, `revision`, `collection?` | revision 匹配后完整替换 |
| `notes_delete` | `path`, `revision`, `collection?` | revision 匹配后永久删除 |

`collection` 只能是 `notes`（默认）或 `templates`。用 `notes_create` 的 `collection: "templates"` 创建模板，再使用同名工具读取、更新或删除模板。

```json
{"tool":"notes_create","arguments":{"collection":"templates","path":"decision.md","content":"# Decision\n\n"}}
{"tool":"notes_create","arguments":{"path":"cache.md","template":"decision.md","content":"Use a bounded local cache."}}
{"tool":"notes_read","arguments":{"path":"cache.md"}}
```

将读取返回的完整 `revision` 放入下一次更新：

```json
{"tool":"notes_update","arguments":{"path":"cache.md","revision":"<revision returned by notes_read>","content":"# Decision\n\nUse a 256-entry local cache."}}
```

也可以直接要求 agent：“把我明确选择的这段对话摘录保存到 `decision.md`。”它通过 `notes_create` 保存给出的文本，不会自动读取/导出会话，不提供 DSH session-search 的重复实现，也没有自动召回或后台记忆。

## 一致性与限制

- 文件名为平面 ASCII Markdown 名称：首字符为字母或数字，其余为字母、数字、点、下划线或连字符，以 `.md` 结尾，最长 123 字符。不支持子目录、绝对路径、重命名或 Pi TUI。
- 单文件最多 256 KiB。拒绝托管目录/文件的符号链接和读取硬链接文件。已有工作区 root 会先 canonicalize；文件和目录权限分别以 0600、0700 创建（不修改已有目录权限）。需要支持 `O_NOFOLLOW` 的本地主机，已在 Linux 验证；未做 Windows 验收。
- revision 是 UTF-8 文本内容的 SHA-256，相同内容具有相同 revision；它不是递增序号，无法检测“修改后恢复原文”的 ABA 情况。
- 同一 Node 进程以 canonical store root 串行执行；多个合作进程以 `.dsh-notes/.write-lock` 排他写锁协调。锁忙会报错，请重试。进程崩溃留下的锁不会自动抢占；确认没有写入者后才能手动删除锁文件。
- 写入临时文件、sync 后重新检查 revision，再 rename。工具取消和插件 dispose 会中止未发布工作、清理临时文件和自有锁，dispose 等待在途操作完成。已经发布的改动不会因随后取消而回滚。
- 此锁只协调本插件。不要在工具写入期间用外部编辑器同时修改同一文件；Node 的路径检查无法防御恶意本地进程在检查和系统调用之间替换父目录。工具不是 OS 权限隔离机制。rename 后没有目录 fsync，不保证断电后的目录持久性。
- 笔记内容会返回模型并进入正常工具记录；不要将秘密保存在模型可读笔记中。列表只限制输出数量，目录枚举不是大型资料库索引。

## 开发验证

```sh
npm run check --workspace @lightjunction/dsh-notes
```

真实 DSH ToolRuntime 测试包含 Markdown/模板 CRUD、stale revision、并发赢家、路径/符号链接/硬链接拒绝、大小限制、取消、锁冲突、dispose，以及 offline model 驱动真实 agent 调用工具。无 Pi TUI 测试；没有远程 world/sandbox 验收。
