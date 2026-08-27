# dsh-bridge

[English](README.md) | [简体中文](README.zh.md)

> Local, cross-session messaging for DeepSeek Harness.

**DSH Bridge** is the local messaging foundation of the DSH family. It lets live
sessions in one DSH host discover one another and exchange messages. It has no
Web UI and no network transport.

`dsh-weave` can extend Bridge across machines; `dsh-chat` can present its
messages as a human-facing group chat. Neither is required for local use.

## What it gives you

- Session discovery and direct delivery inside one DSH Host.
- Human-readable title lookup as well as exact session-id targeting.
- Cold-session resume before delivery, preserving the recorded agent preset and model.
- Clear `idle`, `running`, `waking`, `offline`, `archived`, and `missing` states.
- One controlled inbound seam for trusted transports such as `dsh-weave`.

## Quick start

```bash
dsh plugin --profile web add dsh-bridge@next
dsh web
```

After installation, agents can use `session_list`, `session_send`, and
`session_messages` directly. There is no separate settings page or Web UI.

## How delivery works

The plugin exposes the `ctx.dshBridge` service and registers `session_list`,
`session_send`, and `session_messages` for agents. The old `ctx.sessionMessaging`
accessor remains as a temporary compatibility alias.

`ctx.dshBridge.deliverExternal()` is the controlled inbound seam for a trusted
transport such as Weave: it emits the same session follow-up and audit record
as local delivery, rather than letting a transport manipulate agents directly.
Delivery uses the public `ctx.agents` registry and `Agent.followup()`. An idle
target is woken, a running target receives ordinary queued work, and a persisted
offline target is resumed through DSH's configured Host agent resolver before
delivery. Concurrent messages to the same cold session share one resume operation.
The resolver reconstructs the recorded agent preset and model selection exactly
as the Web host does. A bounded
in-memory recent log (the latest 1,000 delivered messages) is kept only for
`session_messages` replay and diagnostics; it is not a second delivery queue.
Messages carry sender, target, UUID, and timestamp metadata.

`ctx.dshBridge.status(sessionId)` reports a session's presentation state:
`waking` while a cold resume is in flight, `archived` when the id is in the
workspace registry's archive set, `idle`/`running` for live agents, `offline`
for persisted sessions, and `missing` otherwise. Archive takes precedence over
live presence: archiving a session hides it from live surfaces (such as
dsh-chat room member indicators) without stopping its agent. Delivery to an
archived session is rejected: `session_send` and `deliverExternal` refuse to
wake or reach an archived target, so an archived agent stops receiving messages
entirely rather than merely dropping off live surfaces.

`session_send` accepts a target session id or its human-readable title. The
optional `mode` parameter controls interpretation: `auto` (default) tries the
id first then the title, `id` accepts an exact known id only, and `name`
matches titles only. Titles resolve accent-insensitively through the live
`sessionTitle` service and the persisted projection cache; an unknown name or
an ambiguous title rejects with the candidate ids.

This package intentionally does not implement cross-host transport. `dsh-weave`
will provide the authenticated network backend while preserving the local
message semantics.

## Known Limitations and Deferred Work

- **Process boundary** — sessions in another process or host are not visible;
  add an authenticated relay/backend before advertising cross-host delivery.
- **In-memory retention** — messages are lost when the plugin process exits and
  older than the latest 1,000 are evicted; durable inbox/outbox persistence is
  still deferred until a cross-process relay needs it.
- **Delivery acknowledgement** — the current result means the target was live
  (or successfully resumed) and accepted the follow-up call, not that the target
  model processed it.

## Model Experience

None, as `session_list`, `session_send`, and `session_messages` expose their
schemas directly through the tool registry.

### KV Cache effect

Independent tool schemas; sending a message changes only the target session's
queued input and does not alter the sender's cached prompt prefix.
