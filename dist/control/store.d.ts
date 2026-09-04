import { type AiSettings, type NotifySettings, type AppInfo } from './schema';
export declare function readAiSettings(): AiSettings;
/** Did the AI settings come from the published file or env/defaults? (drift signal) */
export declare function aiConfigSource(): 'file' | 'env-default';
/** The cross-app registry for the shell AppSwitcher (from control/apps.json). */
export declare function readApps(): AppInfo[];
export declare function readNotifySettings(): NotifySettings;
export declare function publishAiSettings(s: AiSettings): void;
export declare function publishNotifySettings(s: NotifySettings): void;
/** Test/maintenance helper — clears the read caches and the parsed-settings memo. */
export declare function _clearCache(): void;
