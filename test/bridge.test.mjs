import assert from "node:assert/strict";
import test from "node:test";
import { Config, LocalSessionMessagingImpl, apply } from "../lib/index.js";

function agent(id, status = "idle") {
  const messages = [];
  return { id, status, session: { id }, messages, followup(message) { messages.push(message); } };
}

function harness({ live, persisted = [] } = {}) {
  const agents = new Map(live ? [[live.id, live]] : []);
  let resumes = 0;
  const ctx = {
    agents: {
      get(id) { return agents.get(String(id)); },
      list() { return [...agents.values()]; }
    },
    typert: { lookups: { get(key) { return key === "agent" ? { async resolve(resumeSessionId) {
      resumes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!persisted.includes(String(resumeSessionId))) throw new Error("session is not persisted");
      const resumed = agent(String(resumeSessionId)); agents.set(resumed.id, resumed); return resumed;
    } } : undefined; } } },
    sessionPersistence: { async list() { return persisted.map((id) => ({ header: { id }, revision: `revision-${id}` })); } },
    workspaceRegistry: { archivedSessionIds: [] },
    get(name) { return this[name] }
  };
  return { ctx, agents, get resumes() { return resumes; } };
}

test("reports live, offline, archived, and missing session states", async () => {
  const live = agent("live", "running");
  const fixture = harness({ live, persisted: ["live", "cold"] });
  fixture.ctx.workspaceRegistry.archivedSessionIds.push("old");
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  assert.equal((await bridge.status("live")).state, "running");
  assert.equal((await bridge.status("cold")).state, "offline");
  assert.equal((await bridge.status("old")).state, "archived");
  assert.equal((await bridge.status("gone")).state, "missing");
});

test("archive masks live presence in status reports", async () => {
  const busy = agent("busy", "running");
  const fixture = harness({ live: busy });
  fixture.ctx.workspaceRegistry.archivedSessionIds.push("busy");
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  const report = await bridge.status("busy");
  assert.equal(report.state, "archived");
  assert.equal(report.live, false);
});

test("delivery to an archived live session is rejected", async () => {
  const busy = agent("busy", "running");
  const fixture = harness({ live: busy });
  fixture.ctx.workspaceRegistry.archivedSessionIds.push("busy");
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  await assert.rejects(() => bridge.deliverExternal("room", "busy", "hello"), /archived and cannot receive messages/);
  assert.equal(busy.messages.length, 0);
});

test("delivery to an archived cold session is rejected without resuming it", async () => {
  const fixture = harness({ persisted: ["cold"] });
  fixture.ctx.workspaceRegistry.archivedSessionIds.push("cold");
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  await assert.rejects(() => bridge.deliverExternal("room", "cold", "hello"), /archived and cannot receive messages/);
  assert.equal(fixture.resumes, 0);
});

test("session target resolution supports ids and titles in auto, id, and name modes", async () => {
  const bob = agent("session-bob");
  const fixture = harness({ live: bob, persisted: ["session-carol"] });
  fixture.ctx.sessionTitle = { get(session) { return session.id === "session-bob" ? { title: "Build Bot" } : undefined; } };
  fixture.ctx.sessionProjectionCache = { cachedSnapshot(header) { return header.id === "session-carol" ? { values: { title: "Carol's Task" } } : undefined; } };
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  assert.equal(await bridge.resolveTarget("session-bob"), "session-bob");
  assert.equal(await bridge.resolveTarget("session-carol"), "session-carol");
  assert.equal(await bridge.resolveTarget("Build Bot"), "session-bob");
  assert.equal(await bridge.resolveTarget("Carol's Task"), "session-carol");
  assert.equal(await bridge.resolveTarget("session-carol", "id"), "session-carol");
  await assert.rejects(() => bridge.resolveTarget("Build Bot", "id"), /no session with id "Build Bot"/);
  assert.equal(await bridge.resolveTarget("Build Bot", "name"), "session-bob");
  await assert.rejects(() => bridge.resolveTarget("session-bob", "name"), /no session named "session-bob"/);
  await assert.rejects(() => bridge.resolveTarget("Nobody"), /no session named "Nobody"/);
});

test("ambiguous session titles reject with the candidate ids", async () => {
  const one = agent("session-one");
  const two = agent("session-two");
  const fixture = harness({ live: one });
  fixture.agents.set("session-two", two);
  fixture.ctx.sessionTitle = { get() { return { title: "Duplicate" }; } };
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  await assert.rejects(() => bridge.resolveTarget("Duplicate"), /ambiguous/);
  await assert.rejects(() => bridge.resolveTarget("Duplicate"), /session-one/);
});

test("a session that is both live and persisted resolves by title without ambiguity", async () => {
  const bob = agent("session-bob");
  const fixture = harness({ live: bob, persisted: ["session-bob"] });
  fixture.ctx.sessionTitle = { get() { return { title: "Both" }; } };
  fixture.ctx.sessionProjectionCache = { cachedSnapshot() { return { values: { title: "Both" } }; } };
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  assert.equal(await bridge.resolveTarget("Both"), "session-bob");
});

test("resumes a cold session before delivery", async () => {
  const fixture = harness({ persisted: ["cold"] });
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  const result = await bridge.deliverExternal("room", "cold", "wake up", { id: "message-1", transport: "chat" });
  assert.equal(result.delivered, true);
  assert.equal(fixture.resumes, 1);
  assert.equal(fixture.agents.get("cold").messages.length, 1);
});

test("concurrent cold deliveries share one resume", async () => {
  const fixture = harness({ persisted: ["cold"] });
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  await Promise.all([
    bridge.deliverExternal("one", "cold", "first"),
    bridge.deliverExternal("two", "cold", "second")
  ]);
  assert.equal(fixture.resumes, 1);
  assert.equal(fixture.agents.get("cold").messages.length, 2);
});

test("duplicate external message ids are acknowledged without a second follow-up", async () => {
  const live = agent("target");
  const fixture = harness({ live });
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  const request = ["room", "target", "once", { id: "message-stable", transport: "weave" }];
  const [first, second] = await Promise.all([
    bridge.deliverExternal(...request),
    bridge.deliverExternal(...request),
  ]);
  assert.equal(first.messageId, "message-stable");
  assert.deepEqual(second, first);
  assert.equal(live.messages.length, 1);
  assert.equal(bridge.receive("target", 10).length, 1);
});

test("the same external message id can fan out to different recipients", async () => {
  const one = agent("target-one"); const two = agent("target-two");
  const fixture = harness({ live: one }); fixture.agents.set(two.id, two);
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  await Promise.all([
    bridge.deliverExternal("room", "target-one", "broadcast", { id: "same-id", transport: "chat" }),
    bridge.deliverExternal("room", "target-two", "broadcast", { id: "same-id", transport: "chat" })
  ]);
  assert.equal(one.messages.length, 1);
  assert.equal(two.messages.length, 1);
});

test("session_messages output schema declares the delivered-message transport field", () => {
  const captured = [];
  apply({
    accessor() {},
    provide() {},
    tools: { register(definition) { captured.push(definition); } }
  });
  const tool = captured.find((definition) => definition.name === "session_messages");
  const items = tool.output.schema.items;
  assert.equal(items.properties.transport.type, "string");
  assert.equal(items.required.includes("transport"), true);
});

test("session_list hides pre-created blank rows and subagent children", () => {
  const conversation = { id: "live", header: {}, seq: 2, eventAt: (seq) => (seq === 1 ? { type: "turn/start" } : { type: "session" }) };
  const blank = { id: "shell", header: {}, seq: 1, eventAt: () => ({ type: "session" }) };
  const child = { id: "child", header: { origin: "subagent", parentSession: "live" }, seq: 1, eventAt: () => ({ type: "turn/start" }) };
  const depthChild = { id: "depth-child", header: { delegationDepth: 1 }, seq: 1, eventAt: () => ({ type: "turn/start" }) };
  const opaque = { id: "opaque" };
  const ctx = {
    agents: { get() {}, list: () => [conversation, blank, child, depthChild, opaque].map((session) => ({ session })) },
    get() {},
    sessionPersistence: { async list() { return []; } },
    workspaceRegistry: { archivedSessionIds: [] }
  };
  const bridge = new LocalSessionMessagingImpl(ctx);
  assert.deepEqual(bridge.list(), ["live", "opaque"]);
});

test("a forked conversation stays listed: fork lineage is not a subagent marker", () => {
  // parentSession is fork lineage (delegationDepth 0, no origin); the Workspace UI
  // hides only origin === "subagent", so a fork child remains a message target.
  const fork = { id: "fork", header: { parentSession: "live" }, seq: 2, eventAt: (seq) => (seq === 1 ? { type: "turn/start" } : { type: "session" }) };
  const ctx = {
    agents: { get() {}, list: () => [{ session: fork }] },
    get() {},
    sessionPersistence: { async list() { return []; } },
    workspaceRegistry: { archivedSessionIds: [] }
  };
  assert.deepEqual(new LocalSessionMessagingImpl(ctx).list(), ["fork"]);
});

test("title lookup passes the projection-cache inherited cut", async () => {
  const fixture = harness({ persisted: ["cold"] });
  const calls = [];
  fixture.ctx.sessionProjectionCache = {
    cachedSnapshot(header, inheritedEventCount, keys) {
      calls.push([String(header.id), inheritedEventCount, keys]);
      return { values: { title: "Release notes" } };
    }
  };
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  assert.equal(await bridge.resolveTarget("Release notes"), "cold");
  assert.deepEqual(calls, [["cold", 0, ["title"]]]);
});

test("Config exposes the deployment-varying bounds with defaults", () => {
  assert.deepEqual(Config({}), { recentMessages: 1000, dedupeCapacity: 10000, maxMessagesPerRead: 100 });
  assert.deepEqual(Config({ recentMessages: 3 }), { recentMessages: 3, dedupeCapacity: 10000, maxMessagesPerRead: 100 });
});

test("the retained-message bound follows the configured capacity", async () => {
  const fixture = harness({ live: agent("live") });
  const bridge = new LocalSessionMessagingImpl(fixture.ctx, { recentMessages: 2 });
  for (const id of ["a", "b", "c"]) await bridge.deliverExternal("room", "live", id, { id });
  assert.deepEqual(bridge.receive("live", 10).map((message) => message.text), ["b", "c"]);
});

test("an aborted execution signal stops title resolution", async () => {
  const fixture = harness({ persisted: ["cold"] });
  const controller = new AbortController();
  controller.abort();
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  await assert.rejects(() => bridge.resolveTarget("Release notes", "auto", controller.signal));
});

test("cancelling delivery while a cold session resumes never posts a late followup", async () => {
  const resumed = agent("cold"); const ready = Promise.withResolvers();
  const fixture = harness({ persisted: ["cold"] });
  fixture.ctx.typert.lookups.get = () => ({ resolve: () => ready.promise });
  const bridge = new LocalSessionMessagingImpl(fixture.ctx);
  const controller = new AbortController();
  const sending = bridge.deliverExternal("sender", "cold", "test", { id: "cancelled-message", signal: controller.signal });
  controller.abort(new Error("cancel delivery"));
  await assert.rejects(sending, /cancel delivery/);
  ready.resolve(resumed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumed.messages.length, 0);
  assert.equal(bridge.receive("cold", 10).length, 0);
  await bridge.deliverExternal("sender", "cold", "test", { id: "cancelled-message" });
  assert.equal(resumed.messages.length, 1, "an explicitly retried cancelled id is allowed");
});
