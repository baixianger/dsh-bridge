<div align="center">

<img src="docs/assets/hero.svg" alt="DSH Bridge" width="100%" />

# DSH Bridge

[English](README.md) · [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-bridge?style=flat-square&color=374151)](https://www.npmjs.com/package/dsh-bridge) [![License: MIT](https://img.shields.io/badge/License-MIT-374151?style=flat-square)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-374151?style=flat-square)](https://github.com/topics/dsh-plugin)

</div>

让同一 DeepSeek Harness 主机内的会话发现彼此并交换消息。Bridge 是 Chat 房间和受信任 Weave 投递共用的本地基础层。

## 五个工具，连接本机会话

| 工具 | 用途 |
| --- | --- |
| `session_list` | 查看会话、当前状态，以及每个会话所属的工作区。 |
| `session_spawn` | 一次调用创建新的顶层会话并投递任务。 |
| `session_status` | 查询一个或全部会话的工作区/项目归属与运行状态。 |
| `session_send` | 按准确会话 ID 或可读标题发送消息。 |
| `session_messages` | 读取有界的近期投递记录。 |

## 快速开始

```bash
dsh plugin --profile web add dsh-bridge@latest
dsh web
```

请 Agent 先列出会话，再给目标会话发送消息。Bridge 直接提供工具，没有独立设置页。

`session_send` 的 `mode: auto` 先匹配 ID，再匹配标题；`id`、`name` 可以指定一种方式。标题匹配不区分大小写，重名时返回候选 ID，不会自行选择收件人。

## 先找对目标

`session_list` 默认仍返回纯会话 ID，与早期版本完全一致。`session_list({ verbose: true })` 和 `session_status` 会补上识别目标所需的字段：标题、工作目录、所属工作区、运行状态（`waking` / `running` / `idle` / `offline` / `archived` / `missing`）。`session_status` 还会覆盖只有持久记录、尚未唤醒的会话——这是只看活跃会话的列表给不出的。

会话的工作区归属优先取注册表的持久账目；账目里没有时，用该会话自身的规范 `cwd` 与已注册工作区路径比对。确实不属于任何已注册工作区的会话返回 `null`，不做猜测。

## 派生一个新会话

`session_spawn` 创建的是与侧边栏同一种对话——持久顶层会话，不是子代理子会话——目录取调用方自己的工作目录。它会把新会话挂到该工作区下、挂载调用方的 preset、沿用调用方的模型路由，并把任务作为新会话的第一条用户消息投递过去。

这个调用把任务排入队列后立即返回，绝不等待任务完成。后续用返回的 `sessionId` 配合 `session_send` 追加消息，用 `session_status` 查看它落在哪里。

## 遵循会话状态投递

```mermaid
flowchart LR
  Send[发送消息] --> Resolve[解析目标]
  Resolve --> Live[活跃会话]
  Resolve --> Cold[恢复持久会话]
  Live --> Queue[加入后续任务队列]
  Cold --> Queue
```

- 空闲 Agent 会被唤醒，运行中的 Agent 接收排队任务。
- 持久会话按记录中的 preset 和模型恢复。
- 并发请求共用同一冷会话恢复过程。
- 已归档会话拒绝投递，不会被唤醒。
- 恢复期间取消会阻止迟到的后续任务，即使共享加载最终完成。
- `session_spawn` 把任务排入刚创建的会话后立即返回。会话尚未创建时取消，什么都不会创建；会话已创建后取消，任务仍会投递——不会留下一个没有首条消息的会话。

投递确认表示会话接受了后续任务，不表示模型已经处理消息或完成工作。

## 配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `recentMessages` | `1000` | 每台主机保留的近期消息数。 |
| `dedupeCapacity` | `10000` | 记住的外部消息 ID 数量。 |
| `maxMessagesPerRead` | `100` | 单次读取的消息上限。 |

## 插件集成

公开服务是 `ctx.dshBridge`。受信任传输层调用 `deliverExternal()`，让本地与外部投递使用相同的 follow-up 和审计路径；可选的 `signal` 将取消传递到会话解析。

[DSH Weave](https://github.com/baixianger/dsh-weave) 提供跨主机传输，[DSH Chat](https://github.com/baixianger/dsh-chat) 提供房间和 Web 对话界面。本地消息功能无需安装它们。

## 保留范围与边界

Bridge 作用于一个主机进程。近期消息和去重表保存在内存中，插件卸载或重载后会清空，不是持久邮箱。旧的 `ctx.sessionMessaging` 访问器暂时保留作兼容别名。

## 开发与反馈

```bash
npm ci
npm run check
```

[提交问题](https://github.com/baixianger/dsh-bridge/issues) · [版本记录](RELEASES.md) · [MIT 许可证](LICENSE)
