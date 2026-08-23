# DeepSeek Enhanced for Oh My Pi

DeepSeek 增强扩展：在 Oh My Pi 中把 DeepSeek 会话切换到 **Eternal Minimal** 工具面，并通过 **we need** 锚定提示词稳定模型思维链。

## 特性

- 仅增强 DeepSeek 模型：根据模型的 provider / id / name 判断是否包含 `deepseek`。
- Eternal Minimal 工具面：DeepSeek 会话只直接暴露 `bash`、`str_replace_editor`（以及可用于 `xd://` 传输的 `read` / `write`）。
- `xd://` 传输：模型通过 `read xd://<tool>` 获取工具文档与 JSON schema，再通过 `write xd://<tool>` 以 JSON 参数调用完整工具。
- 内置 `str_replace_editor`：提供 `view`、`create`、`str_replace`、`insert` 四种文件编辑命令。
- 思维链锚定：首轮注入 `we need ...` 规则；检测到大量 `but`、`wait`、`let me`、`hold on`、`hmm` 等回归信号时自动重新注入锚定提示。
- 上下文净化：移除自动注入的日期 / 当前工作目录 reminder，并过滤自动 agent 上下文，保留用户 skill 手势。
- 运行时安全边界：拦截未授权工具的直接调用，并提示模型改用 `xd://`。

## 安装

将仓库根目录的 `deepseek-enhanced.ts` 放入 Oh My Pi 的用户扩展目录：

```text
~/.omp/agent/extensions/deepseek-enhanced.ts
```

Windows 用户对应路径：

```text
C:\Users\<用户名>\.omp\agent\extensions\deepseek-enhanced.ts
```

也可以直接在 Oh My Pi 配置中指定扩展文件路径：

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/DeepSeek-Enhanced-for-Oh-My-Pi/deepseek-enhanced.ts
```

放置完成后重启 Oh My Pi，或在新的会话中切换 DeepSeek 模型。

## 使用

- 当会话使用 DeepSeek 模型时，扩展自动生效。
- 直接可调用工具：`bash`、`str_replace_editor`。
- 如果 `read` / `write` 也在基础工具中，则 `read`、`write` 可直接调用，并通过 `xd://` 访问其他非核心工具。
- 其他工具不要直接调用，应当先 `read xd://<tool>` 获取文档，再 `write xd://<tool>` 执行。

## 工作原理

| 阶段 | 行为 |
| --- | --- |
| `session_start` | 检测 DeepSeek 模型并准备 Eternal Minimal 状态。 |
| `before_agent_start` | 注入最小系统提示、`xd://` 使用说明；首轮追加 `we need` 锚定提示。 |
| `before_provider_request` | 在 wire 层裁剪工具列表、清理 reminder、固定 thinking 与 token 上限，并执行思维链回归检测。 |
| `tool_call` | 阻止直接调用未授权工具，要求改用 `read` / `write` 的 `xd://` 路径。 |
| `context` | 过滤自动注入的上下文消息。 |

## 行为细节

- 若 `bash` 或 `str_replace_editor` 不可用，Eternal Minimal 会被禁用并恢复完整工具目录。
- 若 `read` 与 `write` 未同时启用，则只保留核心工具，`xd://` 传输不可用。
- provider payload 会被强制设置为 `thinking: { type: "enabled" }` 与 `max_completion_tokens` / `max_tokens` 为 `256000`。
- 非 DeepSeek 模型不会触发增强，并会恢复原始工具目录。

## 仓库

- GitHub: https://github.com/mytianyi0712/DeepSeek-Enhanced-for-Oh-My-Pi

## License

MIT
