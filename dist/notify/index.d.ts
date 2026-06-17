import type { NotifyChannel } from '../control/schema';
export type NotifyLevel = 'info' | 'warn' | 'error';
export interface NotifyInput {
    app: string;
    level?: NotifyLevel;
    title: string;
    body?: string;
    /** Restrict to specific channels, overriding the routing config. */
    channels?: NotifyChannel[];
}
/** Resolve which channels should fire for this app+level from the routing config. */
export declare function resolveChannels(app: string, level: NotifyLevel): NotifyChannel[];
/**
 * Send a notification across the resolved channels. Returns a per-channel result
 * map. Never throws.
 */
export declare function notify(input: NotifyInput): Promise<Record<NotifyChannel, boolean>>;
export declare function isNotifyConfigured(): boolean;
