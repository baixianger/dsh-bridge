import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/index.js
const name = "dsh-bridge";
const inject = ["agents", "tools"];
const MAX_RECENT_MESSAGES = 1000;
var LocalSessionMessagingImpl = class {
	ctx;
	messages = [];
	constructor(ctx) {
		this.ctx = ctx;
	}
	list() {
		return [...this.ctx.agents.list()].map((agent) => agent.session.id);
	}
	send(from, to, text) {
		const target = this.ctx.agents.get(to);
		if (!target) throw new Error(`session "${to}" is not live in this process`);
		const id = crypto.randomUUID();
		const message = {
			id,
			from: from.session.id,
			to,
			text,
			createdAt: Date.now(),
			delivered: true
		};
		target.followup(createUserMessage({
			content: [{
				type: "text",
				text: `[session-message ${id} from ${from.session.id}]\n${text}`
			}],
			source: {
				kind: "plugin",
				plugin: name,
				form: "relay"
			}
		}));
		this.messages.push(message);
		if (this.messages.length > MAX_RECENT_MESSAGES) {
			this.messages.splice(0, this.messages.length - MAX_RECENT_MESSAGES);
		}
		return {
			messageId: id,
			from: String(from.session.id),
			to: String(to),
			delivered: true
		};
	}
	receive(sessionId, limit) {
		return this.messages.filter((message) => message.to === sessionId).slice(-limit);
	}
};
function apply(ctx) {
	const messaging = new LocalSessionMessagingImpl(ctx);
	// `dshBridge` is the public service name. Keep the old accessor for one
	// release so an early local installation does not break on upgrade.
	ctx.accessor("dshBridge", { get: () => messaging });
	ctx.accessor("sessionMessaging", { get: () => messaging });
	ctx.tools.register(defineTool({
		name: "session_list",
		description: "List live DeepSeek Harness sessions in this process.",
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
		description: "Send a message to another live DeepSeek Harness session in this process.",
		parameters: {
			to: {
				type: "string",
				required: true,
				description: "Target session id from session_list."
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
			return messaging.send(exec.agent, SessionId(args.to), args.text);
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
			const limit = args.limit === void 0 ? 20 : Math.max(1, Math.min(100, Math.floor(args.limit)));
			return [...messaging.receive(exec.agent.session.id, limit)];
		}
	}));
}
//#endregion
export { apply, inject, name };
