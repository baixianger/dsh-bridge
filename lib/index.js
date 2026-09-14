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
		description: "List the live DeepSeek Harness sessions in this process that hold a conversation and can receive a message. Sessions the Web UI pre-created but never used, and subagent children, are omitted; an omitted session can still be targeted by its exact id with session_send.",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: { type: "string" }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.join("\n") || "No live sessions."
			}]
		},
		async execute() {
			return messaging.list().map(String);
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
