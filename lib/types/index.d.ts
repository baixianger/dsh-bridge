/**
 * Same-process session-to-session messaging.
 *
 * The transport is deliberately process-local. A future relay can implement
 * the same interface without changing the model-facing tools.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session';
export declare const name = "session-messaging";
export declare const inject: string[];
export interface LocalMessage {
    readonly id: string;
    readonly from: SessionIdValue;
    readonly to: SessionIdValue;
    readonly text: string;
    readonly createdAt: number;
    readonly delivered: boolean;
}
export interface SendMessageResult {
    readonly messageId: string;
    readonly from: string;
    readonly to: string;
    readonly delivered: boolean;
}
export interface LocalSessionMessaging {
    list(): readonly SessionIdValue[];
    send(from: Agent, to: SessionIdValue, text: string): SendMessageResult;
    receive(sessionId: SessionIdValue, limit: number): readonly LocalMessage[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        sessionMessaging: LocalSessionMessaging;
    }
}
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map