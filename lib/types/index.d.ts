/**
 * Same-process session-to-session messaging.
 *
 * The transport is deliberately process-local. A future relay can implement
 * the same interface without changing the model-facing tools.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session';
export declare const name = "dsh-bridge";
/** Deployment-varying bounds resolved from cordis.yml. */
export interface DshBridgeConfig { recentMessages?: number; dedupeCapacity?: number; maxMessagesPerRead?: number; }
export declare const Config: import("@standard-schema/spec").StandardSchemaV1<unknown, DshBridgeConfig>;
export declare const inject: string[];
export interface LocalMessage {
    readonly id: string;
    readonly from: string;
    readonly to: SessionIdValue;
    readonly text: string;
    readonly createdAt: number;
    readonly delivered: boolean;
    readonly transport: string;
}
export interface SendMessageResult {
    readonly messageId: string;
    readonly from: string;
    readonly to: string;
    readonly delivered: boolean;
}
export type SessionRuntimeState = 'idle' | 'running' | 'waking' | 'offline' | 'archived' | 'missing';
export interface SessionRuntimeStatus {
    readonly sessionId: string;
    readonly state: SessionRuntimeState;
    readonly live: boolean;
}
/**
 * One session as the discovery tools report it: identity, the workspace or
 * project it belongs to, and its runtime state. A field a session can
 * genuinely lack is null rather than an empty string.
 */
export interface SessionDescriptor {
    readonly sessionId: string;
    readonly title: string | null;
    readonly cwd: string | null;
    readonly workspace: string | null;
    readonly workspaceId: string | null;
    readonly state: SessionRuntimeState;
    readonly live: boolean;
    readonly archived: boolean;
}
/** One spawn request: the task text plus the optional identity of the new session. */
export interface SpawnRequest {
    readonly task: string;
    readonly title?: string;
    readonly cwd?: string;
    readonly signal?: AbortSignal;
}
/** The created session and the acknowledgement of its first message. */
export interface SpawnResult {
    readonly sessionId: string;
    readonly title: string | null;
    readonly cwd: string;
    readonly workspace: string | null;
    readonly workspaceId: string | null;
    readonly state: SessionRuntimeState;
    readonly messageId: string;
    readonly delivered: boolean;
}
export interface LocalSessionMessaging {
    list(): readonly SessionIdValue[];
    status(sessionId: SessionIdValue, signal?: AbortSignal): Promise<SessionRuntimeStatus>;
    /** Describe sessions by id: title, cwd, owning workspace, and runtime state. */
    describe(ids: readonly SessionIdValue[], signal?: AbortSignal): Promise<readonly SessionDescriptor[]>;
    /** Ids this host knows and a model may target, in roster order. */
    knownIds(signal?: AbortSignal): Promise<readonly string[]>;
    /** Create a top-level session and deliver `task` as its first user message. */
    spawn(caller: Agent, request: SpawnRequest): Promise<SpawnResult>;
    send(from: Agent, to: SessionIdValue, text: string): Promise<SendMessageResult>;
    deliverExternal(from: string, to: SessionIdValue, text: string, options?: {
        id?: string;
        transport?: string;
        signal?: AbortSignal;
    }): Promise<SendMessageResult>;
    subscribe(listener: (message: LocalMessage) => void): () => void;
    receive(sessionId: SessionIdValue, limit: number): readonly LocalMessage[];
}
export declare class LocalSessionMessagingImpl implements LocalSessionMessaging {
    constructor(ctx: Context);
    list(): readonly SessionIdValue[];
    status(sessionId: SessionIdValue, signal?: AbortSignal): Promise<SessionRuntimeStatus>;
    describe(ids: readonly SessionIdValue[], signal?: AbortSignal): Promise<readonly SessionDescriptor[]>;
    knownIds(signal?: AbortSignal): Promise<readonly string[]>;
    spawn(caller: Agent, request: SpawnRequest): Promise<SpawnResult>;
    send(from: Agent, to: SessionIdValue, text: string): Promise<SendMessageResult>;
    deliverExternal(from: string, to: SessionIdValue, text: string, options?: { id?: string; transport?: string; signal?: AbortSignal }): Promise<SendMessageResult>;
    subscribe(listener: (message: LocalMessage) => void): () => void;
    receive(sessionId: SessionIdValue, limit: number): readonly LocalMessage[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        dshBridge: LocalSessionMessaging;
        sessionMessaging: LocalSessionMessaging;
    }
}
export declare function apply(ctx: Context, config?: DshBridgeConfig): void;
