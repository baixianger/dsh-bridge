import assert from "node:assert/strict";
import test from "node:test";
import { LocalSessionMessagingImpl } from "../lib/index.js";

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
    workspaceRegistry: { archivedSessionIds: [] }
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
