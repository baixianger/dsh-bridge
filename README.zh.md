# dsh-bridge

[English](README.md) | [简体中文](README.zh.md)

> 为 DeepSeek Harness 提供 Host 内的跨会话消息与事件桥接。

**DSH Bridge** 是 DSH 系列的本地消息基础层。它让同一个 DSH Host 中的会话
可以发现彼此并交换消息，本身不提供 Web UI，也不实现跨主机网络传输。

`dsh-weave` 可以把 Bridge 延伸到多台机器；`dsh-chat` 可以把这些消息呈现为面向用户的群聊。
只在同一 Host 内使用时，不需要安装后两者。

## 核心能力

- 发现同一 DSH Host 中的会话并直接投递消息。
- 既支持精确的 session id，也支持人类可读的会话标题。
- 投递到离线持久化会话前自动恢复 Agent，并还原已记录的 preset 和模型。
- 区分 `idle`、`running`、`waking`、`offline`、`archived` 与 `missing` 状态。
- 为 `dsh-weave` 等可信传输插件提供受控的入站交付边界。

## 快速开始

```bash
dsh plugin --profile web add dsh-bridge@next
dsh web
```

安装后，Agent 可以直接使用以下工具：

| 工具 | 作用 |
| --- | --- |
| `session_list` | 列出可见会话及其状态 |
| `session_send` | 按 session id 或标题向目标会话发送消息 |
| `session_messages` | 读取 Bridge 保留的最近投递记录 |

插件没有独立设置页或 Web 界面，工具 schema 会直接告诉 Agent 如何调用。

## 投递方式

插件暴露 `ctx.dshBridge` 服务，并保留临时兼容别名 `ctx.sessionMessaging`。

`session_send` 接受目标 session id 或会话标题，`mode` 用于控制解析方式：

- `auto`（默认）：先按 id 查找，再按标题查找；
- `id`：仅接受精确的已知 id；
- `name`：仅按标题匹配。

标题查找通过实时 `sessionTitle` 服务与持久化投影缓存完成，并忽略重音符号差异。
未知标题或有歧义的标题会被拒绝；有歧义时会返回候选 id。

投递使用 DSH 公开的 `ctx.agents` 注册表与 `Agent.followup()`：

- 空闲 Agent 会被唤醒；
- 运行中 Agent 会收到普通排队工作；
- 离线持久化会话会先通过 Host Agent resolver 恢复；
- 多条并发消息投递到同一冷会话时，共享一次恢复操作。

已归档会话的状态优先于实时 Agent 存在状态。`session_send` 和
`deliverExternal` 都会拒绝向已归档会话投递，不会在后台继续唤醒它。

## 与跨主机传输的边界

`ctx.dshBridge.deliverExternal()` 是面向可信传输层的受控入口。它会产生与本地投递相同的
session follow-up 和审计记录，传输插件不需要直接操作 Agent。

`dsh-bridge` 刻意不实现跨 Host 传输。需要在多台机器之间传递时，由
`dsh-weave` 提供认证网络后端，Bridge 仍然负责本地会话语义。

## 已知限制

- **进程边界**：另一进程或 Host 中的会话不可见，需要额外的认证传输层。
- **内存保留**：最近日志仅在内存中保留最新 1,000 条；进程退出后丢失，它不是第二个投递队列。
- **投递确认**：成功结果表示目标已接受 follow-up，不表示目标模型已处理完消息。

## 开发

```bash
npm run check
```

## 许可证

MIT © Xiang Bai
