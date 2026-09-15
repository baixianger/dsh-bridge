// Stop waiting promptly while still observing a late upstream rejection.
function withSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
//#region lib/types/index.js
const name = "dsh-bridge";
const inject = ["agents", "tools", "sessionPersistence", "workspaceRegistry", "typert"];
const DEFAULT_RECENT_MESSAGES = 1000;
const DEFAULT_DEDUPE_CAPACITY = 10_000;
const DEFAULT_MAX_MESSAGES_PER_READ = 100;
/** Deployment-varying bounds; every default is overridable from cordis.yml. */
export const Config = Schema.object({
	recentMessages: Schema.number().default(DEFAULT_RECENT_MESSAGES).description("Recent messages retained per host for session_messages."),
	dedupeCapacity: Schema.number().default(DEFAULT_DEDUPE_CAPACITY).description("Delivered-message ids remembered for idempotent delivery."),
	maxMessagesPerRead: Schema.number().default(DEFAULT_MAX_MESSAGES_PER_READ).description("Upper bound on one session_messages read.")
});
/**
 * Whether one live session belongs in `session_list`.
 *
 * An unfiltered `ctx.agents.list()` also reports the two kinds the harness's own
 * session list hides: subagent children and the blank rows the Workspace UI
 * pre-creates before a first turn. Both read to a model as duplicate
 * conversations, so neither counts as a message target. Fork lineage is
 * deliberately not a filter: `parentSession` marks a fork, whose child is an
 * ordinary visible conversation (`dsh-client-ui-workspace` hides only
 * `origin === "subagent"`), while `delegationDepth` is the structural subagent
 * marker that survives a missing `origin`. A session whose shape is unknown is
 * kept — hiding a real target is worse than listing one.
 * The blank scan below is bounded by one live session's own log, so this runs only
 * over the live agent set; a persisted-session sweep would need a cheaper signal.
 * @param session - live Session exposed by one Agent.
 * @returns whether the model should see it in the listing.
 */
function isListedTarget(session) {
	if (session?.header?.origin === "subagent") return false;
	if (typeof session?.header?.delegationDepth === "number" && session.header.delegationDepth > 0) return false;
	if (typeof session?.eventAt !== "function" || typeof session?.seq !== "number") return true;
	// A blank row stops being blank at its first turn/start (dsh-api-session-controller).
	for (let seq = 0; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event === undefined) break;
		if (event.type === "turn/start") return true;
	}
	return false;
}
/**
 * Normalize one directory spelling for index lookup. The workspace registry
 * already stores `fs.realpath`-canonical paths, so this only removes a trailing
 * separator and folds case where the platform's filesystem does.
 * @param path - a directory path, possibly undefined.
 * @returns a comparable key, or the empty string when there is no path.
 */
function normalizePath(path) {
	if (typeof path !== "string" || path === "") return "";
	const bare = path.length > 1 && (path.endsWith("/") || path.endsWith("\\")) ? path.slice(0, -1) : path;
	return process.platform === "win32" ? bare.toLowerCase() : bare;
}
/**
 * The preset a live session was composed from. The live projection is
 * authoritative because a session can switch preset mid-life; the durable
 * header only records the preset stamped at creation.
 * @param ctx - plugin context.
 * @param session - the session whose preset is requested.
 * @returns the preset id, or undefined when this deployment composes none.
 */
function presetOf(ctx, session) {
	const projected = ctx.get?.("sessionProjections")?.stateOf?.(session, "agentPreset");
	if (typeof projected === "string" && projected !== "") return projected;
	const stored = session?.header?.agentPreset;
	return typeof stored === "string" && stored !== "" ? stored : undefined;
}
/**
 * Model route for a spawned session. The caller's own live route is one
 * provider/model pair, so it is either taken whole or not at all — mixing its
 * provider with the deployment default's model could name a route the
 * provider does not own.
 * @param ctx - plugin context.
 * @param caller - the Agent asking for a new session.
 * @returns agent options for the new session, or undefined to accept the default.
 */
function spawnOptions(ctx, caller) {
	const own = caller?.options;
	if (typeof own?.provider === "string" && typeof own?.model === "string") {
		const options = {
			provider: own.provider,
			model: own.model
		};
		if (own.reasoningEffort !== undefined) options.reasoningEffort = own.reasoningEffort;
		if (own.maxTokens !== undefined) options.maxTokens = own.maxTokens;
		return options;
	}
	const fallback = ctx.get?.("agentDefaultModel")?.currentSelection?.();
	if (typeof fallback?.provider !== "string" || typeof fallback?.model !== "string") return undefined;
	return {
		provider: fallback.provider,
		model: fallback.model
	};
}
/**
 * A field that is genuinely absent for some sessions, rather than an empty
 * string. Built fresh per call: one schema node object must never be reached
 * twice in one tree, because the tool runtime rejects a repeated node as
 * circular.
 * @param description - model-facing meaning of the field.
 * @returns an optional-string schema node.
 */
function nullableString(description) {
	return {
		oneOf: [{
			type: "string"
		}, {
			type: "null"
		}],
		description
	};
}
/**
 * One session as the discovery tools report it: identity, the project it
 * belongs to, and its runtime state. Shared by `session_list --verbose`,
 * `session_status`, and `session_spawn` so the three never drift apart.
 * @param state - model-facing meaning of the runtime state field.
 * @returns a fresh session-descriptor schema node.
 */
function sessionDescriptor(state) {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			sessionId: {
				type: "string",
				required: true,
				description: "Stable session id accepted by session_send."
			},
			title: {
				...nullableString("Latest session title, when the host has one."),
				required: true
			},
			cwd: {
				...nullableString("Absolute working directory the session was created in."),
				required: true
			},
			workspace: {
				...nullableString("Display title of the workspace that owns this session."),
				required: true
			},
			workspaceId: {
				...nullableString("Registry id of that workspace."),
				required: true
			},
			state: {
				type: "string",
				required: true,
				description: state
			},
			live: {
				type: "boolean",
				required: true,
				description: "Whether an Agent currently drives this session."
			},
			archived: {
				type: "boolean",
				required: true,
				description: "Whether the session is hidden from workspace groupings."
			}
		}
	};
}
/** Render one descriptor row for the model-facing text form. */
function renderDescriptor(entry) {
	return [entry.sessionId, entry.state, entry.live ? "live" : "cold", entry.workspace ?? "-", entry.cwd ?? "-", entry.title ?? "(untitled)"].join(" · ");
}
class LocalSessionMessagingImpl {
	ctx;
	messages = [];
	listeners = /* @__PURE__ */ new Set();
	resuming = /* @__PURE__ */ new Map();
	deliveries = /* @__PURE__ */ new Map();
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.recentMessages = options.recentMessages ?? DEFAULT_RECENT_MESSAGES;
		this.dedupeCapacity = options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
	}
	list() {
		return [...this.ctx.agents.list()].map((agent) => agent.session).filter(isListedTarget).map((session) => String(session.id));
	}
	async status(sessionId, signal) {
		const id = String(sessionId);
		if (this.resuming.has(id)) return { sessionId: id, state: "waking", live: false };
		// Archive is a durable hide flag: it masks live presence so an archived
		// session never advertises as running/idle, even while its agent keeps
		// working in the background.
		if (new Set(this.ctx.workspaceRegistry?.archivedSessionIds ?? []).has(id)) return { sessionId: id, state: "archived", live: false };
		const live = this.ctx.agents.get(sessionId);
		if (live) return { sessionId: id, state: live.status, live: true };
		signal?.throwIfAborted?.();
		const snapshots = await this.ctx.sessionPersistence.list(signal === undefined ? undefined : { signal });
		return { sessionId: id, state: snapshots.some((snapshot) => String((snapshot.header ?? snapshot).id) === id) ? "offline" : "missing", live: false };
	}
	/**
	 * Which workspace owns which session. The registry's durable account is
	 * authoritative — a workspace's `sessionIds` is already filtered to headers
	 * whose canonical cwd equals its path — and a canonical-path match is the
	 * fallback for a session the account does not list yet.
	 * @returns session-id and normalized-path lookups into the same records.
	 */
	workspaceIndex() {
		const bySession = new Map();
		const byPath = new Map();
		for (const workspace of this.ctx.workspaceRegistry?.list?.() ?? []) {
			const record = {
				workspaceId: String(workspace.id),
				workspace: typeof workspace.title === "string" ? workspace.title : String(workspace.path ?? "")
			};
			const path = normalizePath(workspace.path);
			if (path !== "") byPath.set(path, record);
			for (const sessionId of workspace.sessionIds ?? []) bySession.set(String(sessionId), record);
		}
		return {
			bySession,
			byPath
		};
	}
	/**
	 * Every session this host knows: live agents first, then sessions that exist
	 * only in persistence. One persistence listing covers them all, so a roster
	 * read never costs one listing per session.
	 * @param signal - optional cancellation for the persistence listing.
	 * @returns one entry per session, in stable order.
	 */
	async roster(signal) {
		const entries = new Map();
		const order = [];
		const record = (id, value) => {
			let entry = entries.get(id);
			if (entry === undefined) {
				entry = { id };
				entries.set(id, entry);
				order.push(id);
			}
			if (value.agent !== undefined) entry.agent = value.agent;
			// A live session's own header wins at read time; the stored one stays only as a fallback.
			if (value.header !== undefined && entry.header === undefined) entry.header = value.header;
		};
		for (const agent of this.ctx.agents.list()) record(String(agent.session.id), { agent });
		for (const snapshot of await this.ctx.sessionPersistence.list(signal === undefined ? undefined : { signal })) {
			const header = snapshot.header ?? snapshot;
			record(String(header.id), { header });
		}
		return order.map((id) => entries.get(id));
	}
	/**
	 * Classify one roster entry. The roster already establishes liveness and
	 * persistence presence, so this mirrors {@link status} ordering — waking,
	 * then archive, then live — without a second persistence listing.
	 * @param entry - one roster entry.
	 * @param archived - whether the registry hides this session.
	 * @returns the runtime state.
	 */
	stateOf(entry, archived) {
		if (this.resuming.has(entry.id)) return "waking";
		if (archived) return "archived";
		if (entry.agent !== undefined) return entry.agent.status;
		return entry.header === undefined ? "missing" : "offline";
	}
	/**
	 * Fold the latest title for each entry. Live sessions answer from the title
	 * service; persisted ones fold once through the query engine, falling back to
	 * the projection cache. A missing title is never an error — the roster is
	 * still useful without one.
	 * @param entries - roster entries whose titles are wanted.
	 * @param signal - optional cancellation shared by the title reads.
	 * @returns session id to title, containing only the titles found.
	 */
	async titlesOf(entries, signal) {
		const titles = new Map();
		const pending = [];
		const liveTitles = this.ctx.get?.("sessionTitle");
		for (const entry of entries) {
			const session = entry.agent?.session;
			const title = session === undefined ? undefined : liveTitles?.get?.(session)?.title;
			if (typeof title === "string" && title !== "") titles.set(entry.id, title);
			else pending.push(entry);
		}
		if (pending.length === 0) return titles;
		const query = this.ctx.get?.("sessionQuery");
		if (typeof query?.readTitleSnapshots === "function") {
			try {
				const results = await query.readTitleSnapshots(pending.map((entry) => SessionId(entry.id)), signal);
				for (const result of results ?? []) {
					const title = result?.value?.title?.title;
					if (result?.status === "fulfilled" && typeof title === "string" && title !== "") titles.set(String(result.sessionId), title);
				}
				return titles;
			} catch {
				// A batch fold is an optimization; the projection cache below is the fallback.
			}
		}
		const cache = this.ctx.get?.("sessionProjectionCache");
		for (const entry of pending) {
			const header = entry.agent?.session?.header ?? entry.header;
			if (header === undefined) continue;
			const title = cache?.cachedSnapshot?.(header, 0, ["title"])?.values?.title;
			if (typeof title === "string" && title !== "") titles.set(entry.id, title);
		}
		return titles;
	}
	/**
	 * Describe sessions for the discovery tools: id, title, working directory,
	 * owning workspace, and runtime state.
	 * @param ids - session ids to describe, in the order to report them.
	 * @param signal - optional cancellation.
	 * @returns one descriptor per id found in this host's roster.
	 */
	async describe(ids, signal) {
		const wanted = new Set(ids.map((id) => String(id)));
		const entries = (await this.roster(signal)).filter((entry) => wanted.has(entry.id));
		const index = this.workspaceIndex();
		const archived = new Set((this.ctx.workspaceRegistry?.archivedSessionIds ?? []).map((id) => String(id)));
		const titles = await this.titlesOf(entries, signal);
		return entries.map((entry) => {
			const header = entry.agent?.session?.header ?? entry.header ?? {};
			const record = index.bySession.get(entry.id) ?? index.byPath.get(normalizePath(header.cwd));
			const state = this.stateOf(entry, archived.has(entry.id));
			return {
				sessionId: entry.id,
				title: titles.get(entry.id) ?? null,
				cwd: typeof header.cwd === "string" && header.cwd !== "" ? header.cwd : null,
				workspace: record?.workspace ?? null,
				workspaceId: record?.workspaceId ?? null,
				state,
				live: entry.agent !== undefined && !archived.has(entry.id) && state !== "waking",
				archived: archived.has(entry.id)
			};
		});
	}
	/** Ids this host knows and the model may target, in roster order. */
	async knownIds(signal) {
		return (await this.roster(signal)).filter((entry) => {
			const session = entry.agent?.session;
			if (session !== undefined) return isListedTarget(session);
			const header = entry.header ?? {};
			if (header.origin === "subagent") return false;
			return !(typeof header.delegationDepth === "number" && header.delegationDepth > 0);
		}).map((entry) => entry.id);
	}
	/**
	 * Create a top-level session in the caller's directory and hand it `task` as
	 * its first user message. Returns as soon as the message is posted, never
	 * after the task settles.
	 *
	 * Delivery is deliberately outside the caller's cancellation: once the
	 * session exists, an aborted tool call must not leave a conversation whose
	 * whole purpose — its first message — is missing. Creation itself does honour
	 * the signal, so an abort before publication creates nothing.
	 * @param caller - the Agent asking for the session.
	 * @param request - task text, optional title, and optional working directory.
	 * @returns the new session's descriptor plus the delivery acknowledgement.
	 */
	async spawn(caller, { task, title, cwd, signal }) {
		signal?.throwIfAborted?.();
		const directory = typeof cwd === "string" && cwd !== "" ? cwd : caller.session.header?.cwd ?? process.cwd();
		const sessionId = `session-${crypto.randomUUID()}`;
		const presets = this.ctx.get?.("agentPresets");
		const resolved = typeof presets?.resolve === "function" ? await presets.resolve(presetOf(this.ctx, caller.session)) : undefined;
		const presetId = typeof resolved?.id === "string" && resolved.id !== "" ? resolved.id : undefined;
		const { agent } = await this.ctx.agents.create({
			sessionId: SessionId(sessionId),
			meta: {
				cwd: directory,
				...presetId === undefined ? {} : { agentPreset: presetId }
			},
			agentOptions: spawnOptions(this.ctx, caller),
			signal,
			setup: async (agentCtx) => {
				if (presetId !== undefined && typeof presets?.mount === "function") await presets.mount(agentCtx, presetId);
			}
		});
		const workspace = await this.attachWorkspace(directory, sessionId);
		let named;
		if (typeof title === "string" && title.trim() !== "") {
			try {
				named = this.ctx.get?.("sessionTitle")?.rename?.(agent.session, title);
			} catch {
				// A rejected title is not a spawn failure: the session and its task are already in place.
			}
		}
		const delivery = await this.deliver({
			from: caller.session.id,
			to: SessionId(sessionId),
			text: task,
			transport: "spawn"
		});
		return {
			sessionId,
			title: named?.title ?? null,
			cwd: directory,
			workspace: workspace?.workspace ?? null,
			workspaceId: workspace?.workspaceId ?? null,
			state: agent.status,
			messageId: delivery.messageId,
			delivered: delivery.delivered
		};
	}
	/**
	 * Attach a new session to the workspace that owns `cwd`, so the sidebar
	 * groups it under the same project as its creator. Attachment is
	 * presentation only: a session whose directory owns no workspace record is
	 * still created, still holds its task, and still appears in discovery.
	 * @param cwd - the new session's working directory.
	 * @param sessionId - the new session's id.
	 * @returns the owning workspace's descriptor, or undefined when unattached.
	 */
	async attachWorkspace(cwd, sessionId) {
		const registry = this.ctx.workspaceRegistry;
		if (typeof registry?.resolveByPath !== "function") return undefined;
		try {
			const workspace = await registry.resolveByPath(cwd);
			if (workspace === undefined || typeof workspace.attachSession !== "function") return undefined;
			await workspace.attachSession(SessionId(sessionId));
			return {
				workspaceId: String(workspace.id),
				workspace: typeof workspace.title === "string" ? workspace.title : String(workspace.path ?? "")
			};
		} catch {
			return undefined;
		}
	}
	/** Resolve a session reference — a stable id or a session title — to its id.
	 * `mode` controls interpretation: `auto` tries the id first then the title,
	 * `id` accepts an exact known id only, `name` matches titles only. Titles
	 * match case-insensitively; ambiguous titles reject with the candidates. */
	async resolveTarget(reference, mode = "auto", signal) {
		const id = String(reference);
		signal?.throwIfAborted?.();
		const snapshots = await this.ctx.sessionPersistence.list(signal === undefined ? undefined : { signal });
		const headers = snapshots.map((snapshot) => snapshot.header ?? snapshot);
		const knownIds = new Set([
			...this.ctx.agents.list().map((agent) => String(agent.session.id)),
			...headers.map((header) => String(header.id))
		]);
		if (mode !== "name" && knownIds.has(id)) return id;
		if (mode === "id") throw new Error(`no session with id "${reference}"`);
		const sessionTitle = this.ctx.get?.("sessionTitle");
		const projCache = this.ctx.get?.("sessionProjectionCache");
		const matches = [];
		for (const agent of this.ctx.agents.list()) {
			const title = sessionTitle?.get?.(agent.session)?.title;
			if (typeof title === "string" && title.localeCompare(id, undefined, { sensitivity: "accent" }) === 0) matches.push(String(agent.session.id));
		}
		for (const header of headers) {
			// The projection-cache identity needs the inherited cut next to the header.
			// 0 is the only value valid for an unseeded session; a seeded session's exact
			// cut is Session state, so its lookup is a deliberate miss and the live
			// sessionTitle service above stays authoritative for it.
			const title = projCache?.cachedSnapshot?.(header, 0, ["title"])?.values?.title;
			if (typeof title === "string" && title.localeCompare(id, undefined, { sensitivity: "accent" }) === 0) matches.push(String(header.id));
		}
		// A session can be both live and persisted; dedupe before judging ambiguity.
		const unique = [...new Set(matches)];
		if (unique.length === 0) throw new Error(`no session named "${reference}"`);
		if (unique.length > 1) throw new Error(`session name "${reference}" is ambiguous; choose a session id: ${unique.join(", ")}`);
		return unique[0];
	}
	async target(to) {
		const id = String(to);
		// Archive is a durable hide flag: an archived session never receives
		// delivery, whether its agent is still live or only persisted on disk.
		if (new Set(this.ctx.workspaceRegistry?.archivedSessionIds ?? []).has(id)) {
			throw new Error(`session "${id}" is archived and cannot receive messages`);
		}
		const live = this.ctx.agents.get(to);
		if (live) return live;
		let pending = this.resuming.get(id);
		if (!pending) {
			pending = (async () => {
				const provider = this.ctx.typert.lookups.get("agent");
				if (!provider) throw new Error("DSH host agent resolver is unavailable");
				const resolved = await provider.resolve(to);
				if (!resolved) throw new Error(`session "${id}" could not be resumed`);
				return resolved;
			})().then((agent) => {
				return agent;
			}).catch((error) => {
				const raced = this.ctx.agents.get(to);
				if (raced) return raced;
				throw error;
			}).finally(() => this.resuming.delete(id));
			this.resuming.set(id, pending);
		}
		return pending;
	}
	async deliver({ id = crypto.randomUUID(), from, to, text, transport = "local", signal }) {
		signal?.throwIfAborted();
		const key = `${transport}:${String(from)}:${String(to)}:${id}`;
		const existing = this.deliveries.get(key);
		if (existing) return withSignal(existing, signal);
		const delivery = this._deliver({ id, from, to, text, transport, signal }).catch((error) => {
			this.deliveries.delete(key);
			throw error;
		});
		this.deliveries.set(key, delivery);
		while (this.deliveries.size > this.dedupeCapacity) this.deliveries.delete(this.deliveries.keys().next().value);
		return delivery;
	}
	async _deliver({ id, from, to, text, transport, signal }) {
		const target = await withSignal(this.target(to), signal);
		signal?.throwIfAborted();
		const message = {
			id,
			from: String(from),
			to,
			text,
			createdAt: Date.now(),
			delivered: true,
			transport
		};
		target.followup(createUserMessage({
			content: [{
				type: "text",
				text: `[dsh-bridge ${transport} message ${id} from ${message.from}]\n${text}`
			}],
			source: {
				kind: "plugin",
				plugin: name,
				// `relay` is the harness's ContextForm for a message carried from
				// elsewhere; the transport distinction travels in the text and record.
				form: "relay"
			}
		}));
		this.messages.push(message);
		if (this.messages.length > this.recentMessages) {
			this.messages.splice(0, this.messages.length - this.recentMessages);
		}
		for (const listener of this.listeners) listener(message);
		return {
			messageId: id,
			from: message.from,
			to: String(to),
			delivered: true
		};
	}
	async send(from, to, text) {
		return this.deliver({ from: from.session.id, to, text });
	}
	async deliverExternal(from, to, text, options = {}) {
		return this.deliver({
			id: options.id,
			from,
			to,
			text,
			transport: options.transport ?? "external",
		signal: options.signal
		});
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	receive(sessionId, limit) {
		return this.messages.filter((message) => message.to === sessionId).slice(-limit);
	}
};
function apply(ctx, config = {}) {
	const messaging = new LocalSessionMessagingImpl(ctx, {
		recentMessages: config.recentMessages ?? DEFAULT_RECENT_MESSAGES,
		dedupeCapacity: config.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY
	});
	const maxMessagesPerRead = config.maxMessagesPerRead ?? DEFAULT_MAX_MESSAGES_PER_READ;
	// `dshBridge` is the public service name. Keep the old accessor for one
	// release so an early local installation does not break on upgrade.
	ctx.provide("dshBridge", messaging);
	ctx.accessor("sessionMessaging", { get: () => messaging });
	ctx.tools.register(defineTool({
		name: "session_list",
		description: "List the live DeepSeek Harness sessions in this process that hold a conversation and can receive a message. Sessions the Web UI pre-created but never used, and subagent children, are omitted; an omitted session can still be targeted by its exact id with session_send. By default this returns bare session ids, unchanged from earlier releases. Pass verbose: true to get each session's title, working directory, owning workspace, and runtime state, so a target is identifiable without reading the session directory on disk.",
		parameters: { verbose: {
			type: "boolean",
			description: "Return one object per session — id, title, cwd, owning workspace, runtime state — instead of bare id strings. Omitted or false keeps the original id-only result."
		} },
		output: {
			// Two shapes, disambiguated by JSON type rather than by item type: an
			// empty array would satisfy any array branch, and a tool output must
			// match exactly one branch.
			schema: { oneOf: [{
				type: "array",
				items: { type: "string" },
				description: "Bare session ids, returned when verbose is not set."
			}, {
				type: "object",
				additionalProperties: false,
				properties: { sessions: {
					type: "array",
					required: true,
					items: sessionDescriptor("waking, running, idle, offline, archived, or missing."),
					description: "One descriptor per live session."
				} },
				description: "Session descriptors, returned when verbose is true."
			}] },
			render: (_args, value) => [{
				type: "text",
				text: Array.isArray(value) ? value.join("\n") || "No live sessions." : value.sessions.map(renderDescriptor).join("\n") || "No live sessions."
			}]
		},
		async execute(args, exec) {
			const ids = messaging.list().map(String);
			if (args.verbose !== true) return ids;
			return { sessions: await messaging.describe(ids, exec.signal) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "session_status",
		description: "Report which workspace or project each DeepSeek Harness session belongs to, plus its runtime state. Omit session to describe every session this host knows, including persisted sessions with no live Agent; pass a session id or title to describe just that one. Use this to pick a session_send target without inspecting session directories by hand.",
		parameters: { session: {
			type: "string",
			description: "Optional session id or title. Omitted: describe every session this host knows."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { sessions: {
					type: "array",
					required: true,
					items: sessionDescriptor("waking, running, idle, offline, archived, or missing."),
					description: "One descriptor per described session."
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.sessions.map(renderDescriptor).join("\n") || "No sessions."
			}]
		},
		async execute(args, exec) {
			const ids = args.session === undefined ? await messaging.knownIds(exec.signal) : [await messaging.resolveTarget(args.session, "auto", exec.signal)];
			return { sessions: await messaging.describe(ids, exec.signal) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "session_spawn",
		description: "Create a new top-level DeepSeek Harness session — the same kind of conversation the sidebar shows: durable, reusable, and not a subagent child — in the caller's working directory, and immediately deliver the task as its first user message. Returns as soon as the task is handed over; it never waits for the task to finish, so the caller can keep working. The new session runs with the caller's preset and model route. Use the returned sessionId afterwards for session_send, session_status, and session_messages.",
		parameters: {
			task: {
				type: "string",
				required: true,
				description: "The task to hand to the new session. Write it so it can be worked on and verified on its own."
			},
			title: {
				type: "string",
				description: "Optional session title. Without one the host titles the session from its first message."
			},
			cwd: {
				type: "string",
				description: "Optional absolute working directory for the new session. Defaults to the caller's own working directory."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: {
						type: "string",
						required: true,
						description: "Id of the created session."
					},
					title: {
						...nullableString("Accepted title, or null when the host titles the session itself."),
						required: true
					},
					cwd: {
						type: "string",
						required: true,
						description: "Working directory the session was created in."
					},
					workspace: {
						...nullableString("Display title of the workspace that owns it, when one does."),
						required: true
					},
					workspaceId: {
						...nullableString("Registry id of that workspace, when one owns it."),
						required: true
					},
					state: {
						type: "string",
						required: true,
						description: "Runtime state of the new session at return time."
					},
					messageId: {
						type: "string",
						required: true,
						description: "Id of the delivered first message."
					},
					delivered: {
						type: "boolean",
						required: true,
						description: "Whether the task was posted to the new session."
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Spawned ${value.sessionId} in ${value.cwd}${value.workspace === null ? "" : ` (workspace ${value.workspace})`}, task delivered as ${value.messageId}. The session runs ${value.state}; this call did not wait for it.`
			}]
		},
		async execute(args, exec) {
			if (!exec.agent) throw new Error("session_spawn requires an owning agent");
			if (args.task.trim() === "") throw new Error("task must not be empty");
			return await messaging.spawn(exec.agent, {
				task: args.task,
				title: args.title,
				cwd: args.cwd,
				signal: exec.signal
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "session_send",
		description: "Send a message to another DeepSeek Harness session in this host. A persisted offline session is resumed before delivery. The target may be a session id or its human-readable title; mode controls how the target is interpreted.",
		parameters: {
			to: {
				type: "string",
				required: true,
				description: "Target session id or session title."
			},
			mode: {
				type: "string",
				enum: ["auto", "id", "name"],
				description: "How to interpret the target: auto (id first, then title), id (exact session id only), name (session title only). Defaults to auto."
			},
			text: {
				type: "string",
				required: true,
				description: "Message text."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					messageId: {
						type: "string",
						required: true
					},
					from: {
						type: "string",
						required: true
					},
					to: {
						type: "string",
						required: true
					},
					delivered: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Delivered ${value.messageId} to ${value.to}.`
			}]
		},
		async execute(args, exec) {
			if (!exec.agent) throw new Error("session_send requires an owning agent");
			if (args.text.trim() === "") throw new Error("text must not be empty");
			const to = await messaging.resolveTarget(args.to, args.mode, exec.signal);
			return await messaging.send(exec.agent, SessionId(to), args.text);
		}
	}));
	ctx.tools.register(defineTool({
		name: "session_messages",
		description: "Read messages delivered to the current session in this process.",
		parameters: { limit: {
			type: "number",
			description: "Maximum number of messages, default 20."
		} },
		output: {
			schema: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							required: true
						},
						from: {
							type: "string",
							required: true
						},
						to: {
							type: "string",
							required: true
						},
						text: {
							type: "string",
							required: true
						},
						createdAt: {
							type: "number",
							required: true
						},
						delivered: {
							type: "boolean",
							required: true
						},
						transport: {
							type: "string",
							required: true
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.map((message) => `[${message.from}] ${message.text}`).join("\n") || "No messages."
			}]
		},
		async execute(args, exec) {
			if (!exec.agent) throw new Error("session_messages requires an owning agent");
			const limit = args.limit === void 0 ? 20 : Math.max(1, Math.min(maxMessagesPerRead, Math.floor(args.limit)));
			return [...messaging.receive(exec.agent.session.id, limit)];
		}
	}));
}
//#endregion
export { LocalSessionMessagingImpl, apply, inject, name };
