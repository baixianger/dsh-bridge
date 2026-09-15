import assert from "node:assert/strict";
import test from "node:test";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { Config, LocalSessionMessagingImpl, apply } from "../lib/index.js";

function agent(id, status = "idle", header = {}) {
  const messages = [];
  return { id, status, session: { id, header }, messages, followup(message) { messages.push(message); } };
}

function harness({ live, persisted = [] } = {}) {
  const agents = new Map(live ? [[live.id, live]] : []);
  const created = [];
  let resumes = 0;
  const ctx = {
    agents: {
      get(id) { return agents.get(String(id)); },
      list() { return [...agents.values()]; },
      async create(options) {
        created.push(options);
        const made = agent(String(options.sessionId), "idle", { ...(options.meta ?? {}) });
        made.options = options.agentOptions;
        if (options.setup) await options.setup({ session: made.session });
        agents.set(made.id, made);
        return { agent: made, async dispose() { agents.delete(made.id); } };
      }
    },
    typert: { lookups: { get(key) { return key === "agent" ? { async resolve(resumeSessionId) {
      resumes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!persisted.includes(String(resumeSessionId))) throw new Error("session is not persisted");
      const resumed = agent(String(resumeSessionId)); agents.set(resumed.id, resumed); return resumed;
    } } : undefined; } } },
    sessionPersistence: { async list() { return persisted.map((id) => ({ header: { id }, revision: `revision-${id}` })); } },
    workspaceRegistry: { archivedSessionIds: [] },
    provide(name, value) { this[name] = value; },
    accessor() {},
    get(name) { return this[name] }
  };
  return { ctx, agents, created, get resumes() { return resumes; } };
}

/** Register the plugin's tools against one fixture and hand back a lookup by tool name. */
function toolsOf(fixture) {
  const captured = [];
  fixture.ctx.tools = { register(definition) { captured.push(definition); } };
  apply(fixture.ctx);
  return (name) => captured.find((definition) => definition.name === name);
}

/** One workspace record shaped like the registry entity the discovery tools read. */
function workspace(id, title, path, sessionIds = []) {
  return { id, title, path, sessionIds };
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

test("session_spawn creates a top-level session and delivers its task as the first message", async () => {
  const caller = agent("session-caller", "running", { cwd: "/work/alpha" });
  caller.options = { provider: "deepseek", model: "deepseek-v4.1", reasoningEffort: "high" };
  const fixture = harness({ live: caller });
  const tool = toolsOf(fixture)("session_spawn");
  const value = await tool.execute({ task: "Summarise the release notes." }, { agent: caller });
  assert.match(value.sessionId, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(value.cwd, "/work/alpha");
  assert.equal(value.delivered, true);
  assert.equal(value.state, "idle", "the spawn returns before any turn starts, so the caller is never blocked");
  assert.equal(value.title, null);
  assert.equal(value.workspace, null);
  const created = fixture.created.at(-1);
  assert.equal(String(created.sessionId), value.sessionId);
  // A root session: cwd only. Fork lineage and delegation depth are what turn a
  // session into a sidebar-visible peer, so neither may be set here.
  assert.deepEqual(created.meta, { cwd: "/work/alpha" });
  assert.deepEqual(created.agentOptions, { provider: "deepseek", model: "deepseek-v4.1", reasoningEffort: "high" });
  const spawned = fixture.agents.get(value.sessionId);
  assert.equal(spawned.messages.length, 1, "the task is the new session's first message");
  assert.match(spawned.messages[0].content[0].text, /dsh-bridge spawn message/);
  assert.match(spawned.messages[0].content[0].text, /Summarise the release notes\./);
  // Spawn reuses the same audited delivery path as session_send, not a private one.
  const record = fixture.ctx.dshBridge.receive(value.sessionId, 10);
  assert.equal(record.length, 1);
  assert.equal(record[0].transport, "spawn");
  assert.equal(record[0].from, "session-caller");
  assert.equal(record[0].text, "Summarise the release notes.");
  // The result the model receives is the one the tool declared to the registry.
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, "value"), []);
});

test("a spawned session is reachable with session_send by the returned id", async () => {
  const caller = agent("session-caller", "idle", { cwd: "/work/alpha" });
  const fixture = harness({ live: caller });
  const tools = toolsOf(fixture);
  const value = await tools("session_spawn").execute({ task: "First." }, { agent: caller });
  await tools("session_send").execute({ to: value.sessionId, text: "Second." }, { agent: caller });
  const spawned = fixture.agents.get(value.sessionId);
  assert.equal(spawned.messages.length, 2);
  assert.match(spawned.messages[1].content[0].text, /Second\./);
});

test("session_spawn follows the caller's preset and attaches to its workspace", async () => {
  const caller = agent("session-caller", "idle", { cwd: "/work/alpha", agentPreset: "feishu-ops" });
  const fixture = harness({ live: caller });
  const presetCalls = [];
  fixture.ctx.agentPresets = {
    async resolve(id) { presetCalls.push(["resolve", id]); return { id: id ?? "standard" }; },
    async mount(agentCtx, id) { presetCalls.push(["mount", id, agentCtx.session.id]); }
  };
  const attached = [];
  const alpha = workspace("ws-alpha", "Alpha", "/work/alpha");
  alpha.attachSession = async (id) => { attached.push(String(id)); };
  fixture.ctx.workspaceRegistry.resolveByPath = async (path) => (path === "/work/alpha" ? alpha : undefined);
  const tool = toolsOf(fixture)("session_spawn");
  const value = await tool.execute({ task: "Do the thing." }, { agent: caller });
  assert.deepEqual(presetCalls.map(([kind, id]) => [kind, id]), [["resolve", "feishu-ops"], ["mount", "feishu-ops"]]);
  assert.equal(presetCalls[1][2], value.sessionId, "the preset is mounted on the new session's own context");
  assert.equal(fixture.created.at(-1).meta.agentPreset, "feishu-ops");
  assert.deepEqual(attached, [value.sessionId]);
  assert.equal(value.workspace, "Alpha");
  assert.equal(value.workspaceId, "ws-alpha");
});

test("session_spawn applies an explicit title and survives a rejected one", async () => {
  const caller = agent("session-caller", "idle", { cwd: "/work/alpha" });
  const fixture = harness({ live: caller });
  const renamed = [];
  fixture.ctx.sessionTitle = { rename(session, title) {
    renamed.push([String(session.id), title]);
    if (title === "rejected") throw new Error("title invalid");
    return { title };
  } };
  const tool = toolsOf(fixture)("session_spawn");
  const named = await tool.execute({ task: "Do the thing.", title: "Release notes" }, { agent: caller });
  assert.deepEqual(renamed, [[named.sessionId, "Release notes"]]);
  assert.equal(named.title, "Release notes");
  // A title the host refuses must not cost the task: the session still spawns and delivers.
  const fallback = await tool.execute({ task: "Do the other thing.", title: "rejected" }, { agent: caller });
  assert.equal(fallback.title, null);
  assert.equal(fallback.delivered, true);
  assert.equal(fixture.agents.get(fallback.sessionId).messages.length, 1);
});

test("a spawn cancelled before creation creates nothing", async () => {
  const caller = agent("session-caller", "idle", { cwd: "/work/alpha" });
  const fixture = harness({ live: caller });
  const tool = toolsOf(fixture)("session_spawn");
  const controller = new AbortController();
  controller.abort(new Error("cancel spawn"));
  await assert.rejects(() => tool.execute({ task: "Do the thing." }, { agent: caller, signal: controller.signal }), /cancel spawn/);
  assert.equal(fixture.created.length, 0);
  await assert.rejects(() => tool.execute({ task: "   " }, { agent: caller }), /task must not be empty/);
});

test("session_list stays id-only by default and reports workspace and state when verbose", async () => {
  const live = agent("session-live", "running", { cwd: "/work/alpha" });
  const fixture = harness({ live, persisted: ["session-live", "session-cold"] });
  fixture.ctx.workspaceRegistry = {
    archivedSessionIds: [],
    list: () => [
      workspace("ws-alpha", "Alpha", "/work/alpha", ["session-live"]),
      workspace("ws-beta", "Beta", "/work/beta", ["session-cold"])
    ]
  };
  fixture.ctx.sessionTitle = { get(session) { return session.id === "session-live" ? { title: "Alpha work" } : undefined; } };
  fixture.ctx.sessionProjectionCache = { cachedSnapshot(header) { return header.id === "session-cold" ? { values: { title: "Cold work" } } : undefined; } };
  const tool = toolsOf(fixture)("session_list");
  assert.deepEqual(await tool.execute({}, { agent: live }), ["session-live"], "the default result is unchanged");
  const verbose = await tool.execute({ verbose: true }, { agent: live });
  assert.deepEqual(verbose.sessions, [{
    sessionId: "session-live",
    title: "Alpha work",
    cwd: "/work/alpha",
    workspace: "Alpha",
    workspaceId: "ws-alpha",
    state: "running",
    live: true,
    archived: false
  }]);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, ["session-live"], "value"), []);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, { sessions: verbose.sessions }, "value"), []);
});

test("session_list declares both result shapes and rejects a value matching neither", () => {
  const tool = toolsOf(harness({}))("session_list");
  // Both branches must accept the empty case exactly once: an empty array
  // satisfies an array branch, an object does not.
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, [], "value"), []);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, { sessions: [] }, "value"), []);
  assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, [{ sessionId: "s" }], "value"), [], "a bare id list must not accept objects");
  assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, { sessions: [{ sessionId: "s" }] }, "value"), [], "a descriptor must carry every field");
});

test("session_status reports a cold session's workspace, title, state, and archive flag", async () => {
  const live = agent("session-live", "idle", { cwd: "/work/alpha" });
  const fixture = harness({ live });
  fixture.ctx.workspaceRegistry = {
    archivedSessionIds: ["session-cold"],
    list: () => [
      workspace("ws-alpha", "Alpha", "/work/alpha", ["session-live"]),
      workspace("ws-beta", "Beta", "/work/beta", ["session-cold"])
    ]
  };
  fixture.ctx.sessionPersistence = { async list() { return [
    { header: { id: "session-live", cwd: "/work/alpha" }, revision: "r1" },
    { header: { id: "session-cold", cwd: "/work/beta" }, revision: "r2" }
  ]; } };
  fixture.ctx.sessionTitle = { get: () => undefined };
  const folded = [];
  fixture.ctx.sessionQuery = { async readTitleSnapshots(ids) {
    folded.push(ids.map(String));
    return ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: { title: String(id) === "session-cold" ? "Cold task" : "" } } }));
  } };
  fixture.ctx.sessionProjectionCache = { cachedSnapshot(header) { return header.id === "session-cold" ? { values: { title: "Cold task" } } : undefined; } };
  const tool = toolsOf(fixture)("session_status");
  const all = await tool.execute({}, { agent: live });
  assert.deepEqual(all.sessions.map((entry) => [entry.sessionId, entry.state, entry.live, entry.archived, entry.workspace, entry.title]), [
    ["session-live", "idle", true, false, "Alpha", null],
    ["session-cold", "archived", false, true, "Beta", "Cold task"]
  ]);
  assert.deepEqual(folded, [["session-live", "session-cold"]], "titles fold in one batched read");
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, all, "value"), []);
  const one = await tool.execute({ session: "Cold task" }, { agent: live });
  assert.deepEqual(one.sessions.map((entry) => entry.sessionId), ["session-cold"]);
});

test("session_status falls back to the projection cache when the query engine cannot fold titles", async () => {
  const live = agent("session-live", "idle", { cwd: "/work/alpha" });
  const fixture = harness({ persisted: ["session-cold"] });
  fixture.ctx.workspaceRegistry = {
    archivedSessionIds: [],
    list: () => [workspace("ws-beta", "Beta", "/work/beta", ["session-cold"])]
  };
  fixture.ctx.sessionPersistence = { async list() { return [{ header: { id: "session-cold", cwd: "/work/beta" }, revision: "r1" }]; } };
  fixture.ctx.sessionQuery = { async readTitleSnapshots() { throw new Error("query engine unavailable"); } };
  fixture.ctx.sessionProjectionCache = { cachedSnapshot(header) { return header.id === "session-cold" ? { values: { title: "Cold work" } } : undefined; } };
  const tool = toolsOf(fixture)("session_status");
  const all = await tool.execute({}, { agent: live });
  assert.deepEqual(all.sessions.map((entry) => [entry.sessionId, entry.state, entry.workspace, entry.title]), [["session-cold", "offline", "Beta", "Cold work"]]);
});

test("workspace attribution falls back to a canonical cwd match when the account is silent", async () => {
  const live = agent("session-live", "idle", { cwd: "/work/alpha/" });
  const fixture = harness({ live });
  // The registry lists the workspace but its durable account does not name this
  // session yet; the header cwd still identifies the project.
  fixture.ctx.workspaceRegistry = {
    archivedSessionIds: [],
    list: () => [workspace("ws-alpha", "Alpha", "/work/alpha", [])]
  };
  fixture.ctx.sessionTitle = { get: () => undefined };
  const tool = toolsOf(fixture)("session_list");
  const verbose = await tool.execute({ verbose: true }, { agent: live });
  assert.equal(verbose.sessions[0].workspace, "Alpha");
  assert.equal(verbose.sessions[0].workspaceId, "ws-alpha");
});

