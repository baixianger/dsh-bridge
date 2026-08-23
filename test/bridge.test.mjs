import assert from "node:assert/strict";
import test from "node:test";
import { LocalSessionMessagingImpl, apply } from "../lib/index.js";

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
    sessionPersistence: { async list() { return persisted.map((id) => ({ id })); } },
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

test("session_messages output schema declares the delivered-message transport field", () => {
  const captured = [];
  apply({
    accessor() {},
    tools: { register(definition) { captured.push(definition); } }
  });
  const tool = captured.find((definition) => definition.name === "session_messages");
  const items = tool.output.schema.items;
  assert.equal(items.properties.transport.type, "string");
  assert.equal(items.required.includes("transport"), true);
});
