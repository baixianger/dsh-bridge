import assert from "node:assert/strict";
import test from "node:test";
import { Inbox } from "@deepseek-ai/dsh-agent";
import { LocalSessionMessagingImpl, apply } from "../lib/index.js";

function agent(id) {
  const removed = [];
  const inbox = {
    nextTurn: [],
    nextStep: [],
    remove(itemId) {
      for (const queue of [this.nextTurn, this.nextStep]) {
        const index = queue.findIndex((item) => item.id === itemId);
        if (index < 0) continue;
        queue.splice(index, 1);
        removed.push(itemId);
        return true;
      }
      return false;
    }
  };
  return { session: { id }, inbox, removed, followup(message) { inbox.nextTurn.push(message); } };
}

function harness(options) {
  const own = agent("target");
  const foreign = agent("foreign");
  const agents = new Map([["target", own], ["foreign", foreign]]);
  const ctx = {
    agents: { get(id) { return agents.get(String(id)); }, list() { return [...agents.values()]; } },
    workspaceRegistry: { archivedSessionIds: [] },
    get(name) { return this[name]; }
  };
  return { own, foreign, ctx, bridge: new LocalSessionMessagingImpl(ctx, options) };
}

function send(bridge, id, to = "target") {
  return bridge.deliver({ id, from: "sender", to, text: `body-${id}` });
}

function human(id, text = "human") {
  return { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

test("delivery uses the producer-owned relay source, not the legacy plugin discriminator", async () => {
  const { own, bridge } = harness();
  await send(bridge, "one");
  // This is the v4 producer contract; a separate codec dependency is not required.
  assert.deepEqual(own.inbox.nextTurn[0].source, { kind: "plugin:dsh-bridge", form: "relay" });
});

test("read acknowledges exact delivered followups while retaining the audit log", async () => {
  const { own, bridge } = harness();
  await send(bridge, "one");
  const pending = own.inbox.nextTurn[0];
  const audit = structuredClone(bridge.receive("target", 10));
  assert.deepEqual(bridge.read(own, 10), audit);
  assert.deepEqual(own.inbox.nextTurn, []);
  assert.deepEqual(own.removed, [pending.id]);
  assert.deepEqual(bridge.receive("target", 10), audit);
});

test("latest-limit selection preserves unread records, human ordering and foreign queues", async () => {
  const { own, foreign, bridge } = harness();
  own.inbox.nextTurn.push(human("first"));
  await send(bridge, "one");
  await send(bridge, "elsewhere", "foreign");
  await send(bridge, "two");
  own.inbox.nextTurn.push(human("last"));
  const before = [...own.inbox.nextTurn];
  const foreignBefore = structuredClone(foreign.inbox.nextTurn);
  assert.deepEqual(bridge.read(own, 1).map((message) => message.id), ["two"]);
  assert.deepEqual(own.inbox.nextTurn, [before[0], before[1], before[3]]);
  assert.deepEqual(foreign.inbox.nextTurn, foreignBefore);
});

test("a delivered followup moved to nextStep is acknowledged", async () => {
  const { own, bridge } = harness();
  await send(bridge, "one");
  own.inbox.nextStep.push(own.inbox.nextTurn.shift());
  bridge.read(own, 10);
  assert.deepEqual(own.inbox.nextStep, []);
  assert.equal(own.removed.length, 1);
});

test("claimed followups and repeated reads are idempotent", async () => {
  const { own, bridge } = harness();
  await send(bridge, "one");
  own.inbox.nextTurn.shift();
  const audit = bridge.read(own, 10);
  assert.equal(audit.length, 1);
  assert.deepEqual(bridge.read(own, 10), audit);
  assert.deepEqual(own.removed, []);
});

for (const [label, edit] of [
  ["edited body", (message) => { message.content[0].text += " edited"; }],
  ["human source", (message) => { message.source = { kind: "user" }; }],
  ["foreign source", (message) => { message.source = { kind: "plugin:other", form: "relay" }; }],
  ["changed form", (message) => { message.source.form = "other"; }]
]) {
  test(`read protects same-identity followups with ${label}`, async () => {
    const { own, bridge } = harness();
    await send(bridge, "one");
    const changed = structuredClone(own.inbox.nextTurn[0]);
    edit(changed);
    own.inbox.nextTurn[0] = changed;
    const before = structuredClone(own.inbox.nextTurn);
    assert.equal(bridge.read(own, 10).length, 1);
    assert.deepEqual(own.inbox.nextTurn, before);
    assert.deepEqual(own.removed, []);
  });
}

test("matching text with a different identity is not acknowledged", async () => {
  const { own, bridge } = harness();
  await send(bridge, "one");
  const copy = structuredClone(own.inbox.nextTurn[0]);
  copy.id = "unrelated-plugin-copy";
  const humanCopy = human("human-copy", copy.content[0].text);
  own.inbox.nextTurn.push(copy, humanCopy);
  bridge.read(own, 10);
  assert.deepEqual(own.inbox.nextTurn, [copy, humanCopy]);
});

test("receive remains nonmutating for existing audit consumers", async () => {
  const { own, bridge } = harness();
  await send(bridge, "one");
  const before = structuredClone(own.inbox.nextTurn);
  assert.equal(bridge.receive("target", 10).length, 1);
  assert.deepEqual(own.inbox.nextTurn, before);
  assert.deepEqual(own.removed, []);
});

test("external deliveries use the same acknowledgement path", async () => {
  const { own, bridge } = harness();
  await bridge.deliverExternal("external:sender", "target", "external body", { id: "external" });
  assert.equal(bridge.read(own, 10)[0].transport, "external");
  assert.deepEqual(own.inbox.nextTurn, []);
});

test("delivery dedupe survives acknowledgement without requeuing", async () => {
  const { own, bridge } = harness();
  const receipt = await send(bridge, "one");
  bridge.read(own, 10);
  assert.deepEqual(await send(bridge, "one"), receipt);
  assert.deepEqual(own.inbox.nextTurn, []);
  assert.equal(bridge.receive("target", 10).length, 1);
});

test("retention eviction leaves unread older followups queued", async () => {
  const { own, bridge } = harness({ recentMessages: 2 });
  await send(bridge, "one");
  const oldest = own.inbox.nextTurn[0];
  await send(bridge, "two");
  await send(bridge, "three");
  assert.deepEqual(bridge.read(own, 10).map((message) => message.id), ["two", "three"]);
  assert.deepEqual(own.inbox.nextTurn, [oldest]);
});

test("synchronous remove failure remains visible and permits a safe retry", async () => {
  const { own, bridge } = harness();
  await send(bridge, "one");
  const audit = structuredClone(bridge.receive("target", 10));
  const remove = own.inbox.remove;
  own.inbox.remove = () => { throw new Error("fixture queue error"); };
  assert.throws(() => bridge.read(own, 10), /fixture queue error/);
  assert.deepEqual(bridge.receive("target", 10), audit);
  assert.equal(own.inbox.nextTurn.length, 1);
  own.inbox.remove = remove;
  assert.deepEqual(bridge.read(own, 10), audit);
  assert.deepEqual(own.inbox.nextTurn, []);
});

test("failed followup is not logged as delivered or acknowledged", async () => {
  const { own, bridge } = harness();
  own.inbox.nextTurn.push(human("first"));
  own.followup = () => { throw new Error("fixture followup error"); };
  await assert.rejects(send(bridge, "one"), /fixture followup error/);
  assert.deepEqual(bridge.receive("target", 10), []);
  assert.deepEqual(bridge.read(own, 10), []);
  assert.deepEqual(own.inbox.nextTurn, [human("first")]);
});

test("read commits one real Inbox deletion and preserves unread work and audit", async () => {
  const { own, bridge } = harness();
  const events = [];
  const discarded = [];
  const session = {
    header: {}, events,
    append(type, data) {
      const event = { type, data: structuredClone(data) };
      events.push(event);
      return event;
    }
  };
  own.inbox = new Inbox(session, {
    inserted() {}, claimed() {}, discarded(message) { discarded.push(message.id); }
  });
  own.followup = (message) => own.inbox.append("next-turn", message);
  own.inbox.append("next-turn", human("first"));
  await send(bridge, "one");
  const unread = own.inbox.nextTurn[1];
  await send(bridge, "two");
  const returnedId = own.inbox.nextTurn[2].id;
  const audit = structuredClone(bridge.receive("target", 10));
  const start = events.length;
  assert.deepEqual(bridge.read(own, 1).map((message) => message.id), ["two"]);
  assert.deepEqual(own.inbox.nextTurn, [human("first"), unread]);
  assert.deepEqual(events.slice(start), [{ type: "agent/inbox/spliced", data: {
    target: "next-turn", start: 2, removedCount: 1, inserted: [], outcome: "canceled"
  } }]);
  assert.deepEqual(discarded, [returnedId]);
  assert.deepEqual(bridge.receive("target", 10), audit);
  bridge.read(own, 1);
  assert.equal(events.length, start + 1);
});

test("registered session_messages acknowledges only the caller's returned record", async () => {
  const { own, foreign, ctx } = harness();
  const tools = [];
  let bridge;
  ctx.tools = { register(tool) { tools.push(tool); } };
  ctx.provide = (name, service) => { if (name === "dshBridge") bridge = service; };
  ctx.accessor = () => {};
  apply(ctx, {});
  const tool = tools.find((item) => item.name === "session_messages");
  assert.ok(tool, "session_messages is registered");
  await send(bridge, "one");
  const unread = own.inbox.nextTurn[0];
  await send(bridge, "two");
  await send(bridge, "elsewhere", "foreign");
  assert.deepEqual((await tool.execute({ limit: 1 }, { agent: own })).map((message) => message.id), ["two"]);
  assert.deepEqual(own.inbox.nextTurn, [unread]);
  assert.equal(foreign.inbox.nextTurn.length, 1);
  assert.deepEqual(bridge.receive("target", 10).map((message) => message.id), ["one", "two"]);
});

test("a cancelled session_messages call leaves pending work and audit untouched", async () => {
  const { own, ctx } = harness();
  const tools = [];
  let bridge;
  ctx.tools = { register(tool) { tools.push(tool); } };
  ctx.provide = (name, service) => { if (name === "dshBridge") bridge = service; };
  ctx.accessor = () => {};
  apply(ctx, {});
  const tool = tools.find((item) => item.name === "session_messages");
  await send(bridge, "one");
  const before = structuredClone(own.inbox.nextTurn);
  const controller = new AbortController();
  const reason = new Error("fixture cancelled read");
  controller.abort(reason);
  await assert.rejects(tool.execute({ limit: 1 }, { agent: own, signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(own.inbox.nextTurn, before);
  assert.equal(bridge.receive("target", 10).length, 1);
});
