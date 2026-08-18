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
export interface LocalSessionMessaging {
    list(): readonly SessionIdValue[];
    status(sessionId: SessionIdValue): Promise<SessionRuntimeStatus>;
    send(from: Agent, to: SessionIdValue, text: string): Promise<SendMessageResult>;
    deliverExternal(from: string, to: SessionIdValue, text: string, options?: {
        id?: string;
        transport?: string;
    }): Promise<SendMessageResult>;
    subscribe(listener: (message: LocalMessage) => void): () => void;
    receive(sessionId: SessionIdValue, limit: number): readonly LocalMessage[];
}
export declare class LocalSessionMessagingImpl implements LocalSessionMessaging {
    constructor(ctx: Context);
    list(): readonly SessionIdValue[];
    status(sessionId: SessionIdValue): Promise<SessionRuntimeStatus>;
    send(from: Agent, to: SessionIdValue, text: string): Promise<SendMessageResult>;
    deliverExternal(from: string, to: SessionIdValue, text: string, options?: { id?: string; transport?: string }): Promise<SendMessageResult>;
    subscribe(listener: (message: LocalMessage) => void): () => void;
    receive(sessionId: SessionIdValue, limit: number): readonly LocalMessage[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        dshBridge: LocalSessionMessaging;
        sessionMessaging: LocalSessionMessaging;
    }
}
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map
