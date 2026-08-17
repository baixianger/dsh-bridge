# dsh-bridge

> The local event and session-messaging bridge for DeepSeek Harness.

`dsh-bridge` provides same-process messaging between live DeepSeek Harness sessions. It is the local contract beneath `dsh-weave`: bridge normalizes local session events; weave carries approved work across machines.

The plugin registers `session_list`, `session_send`, and `session_messages`.
Delivery uses the public `ctx.agents` registry and `Agent.followup()`, so an
idle target is woken and a busy target receives ordinary queued work. A bounded
in-memory recent log (the latest 1,000 delivered messages) is kept only for
`session_messages` replay and diagnostics; it is not a second delivery queue.
Messages carry sender, target, UUID, and timestamp metadata.

This package intentionally does not implement cross-host transport. `dsh-weave`
will provide the authenticated network backend while preserving this tool contract.

## Install

```bash
dsh plugin --profile web add dsh-bridge@next
```

## Known Limitations and Deferred Work

- **Process boundary** — sessions in another process or host are not visible;
  add an authenticated relay/backend before advertising cross-host delivery.
- **In-memory retention** — messages are lost when the plugin process exits and
  older than the latest 1,000 are evicted; durable inbox/outbox persistence is
  still deferred until a cross-process relay needs it.
- **Delivery acknowledgement** — the current result means the target was live
  and accepted the follow-up call, not that the target model processed it.

## Model Experience

None, as `session_list`, `session_send`, and `session_messages` expose their
schemas directly through the tool registry.

### KV Cache effect

Independent tool schemas; sending a message changes only the target session's
queued input and does not alter the sender's cached prompt prefix.
