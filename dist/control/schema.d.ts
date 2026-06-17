import { z } from 'zod';
export declare const AI_SETTINGS_SCHEMA: z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodNumber>;
    provider: z.ZodDefault<z.ZodEnum<["anthropic", "gemini"]>>;
    fallbackEnabled: z.ZodDefault<z.ZodBoolean>;
    anonymizeRequests: z.ZodDefault<z.ZodBoolean>;
    anthropicModel: z.ZodDefault<z.ZodString>;
    anthropicModelFast: z.ZodDefault<z.ZodString>;
    geminiModel: z.ZodDefault<z.ZodString>;
    geminiModelFast: z.ZodDefault<z.ZodString>;
    geminiModelFallback: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: number;
    provider: "anthropic" | "gemini";
    fallbackEnabled: boolean;
    anonymizeRequests: boolean;
    anthropicModel: string;
    anthropicModelFast: string;
    geminiModel: string;
    geminiModelFast: string;
    geminiModelFallback: string;
}, {
    schemaVersion?: number | undefined;
    provider?: "anthropic" | "gemini" | undefined;
    fallbackEnabled?: boolean | undefined;
    anonymizeRequests?: boolean | undefined;
    anthropicModel?: string | undefined;
    anthropicModelFast?: string | undefined;
    geminiModel?: string | undefined;
    geminiModelFast?: string | undefined;
    geminiModelFallback?: string | undefined;
}>;
export type AiSettings = z.infer<typeof AI_SETTINGS_SCHEMA>;
export declare const NOTIFY_CHANNEL: z.ZodEnum<["telegram", "email", "signal"]>;
export type NotifyChannel = z.infer<typeof NOTIFY_CHANNEL>;
export declare const NOTIFY_SETTINGS_SCHEMA: z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodNumber>;
    routes: z.ZodDefault<z.ZodArray<z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
        minLevel: z.ZodDefault<z.ZodEnum<["info", "warn", "error"]>>;
        channels: z.ZodDefault<z.ZodArray<z.ZodEnum<["telegram", "email", "signal"]>, "many">>;
    }, "strip", z.ZodTypeAny, {
        minLevel: "info" | "warn" | "error";
        channels: ("telegram" | "email" | "signal")[];
        app?: string | undefined;
    }, {
        app?: string | undefined;
        minLevel?: "info" | "warn" | "error" | undefined;
        channels?: ("telegram" | "email" | "signal")[] | undefined;
    }>, "many">>;
    quietHours: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        start: number;
        end: number;
    }, {
        start: number;
        end: number;
    }>>>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: number;
    routes: {
        minLevel: "info" | "warn" | "error";
        channels: ("telegram" | "email" | "signal")[];
        app?: string | undefined;
    }[];
    quietHours: {
        start: number;
        end: number;
    } | null;
}, {
    schemaVersion?: number | undefined;
    routes?: {
        app?: string | undefined;
        minLevel?: "info" | "warn" | "error" | undefined;
        channels?: ("telegram" | "email" | "signal")[] | undefined;
    }[] | undefined;
    quietHours?: {
        start: number;
        end: number;
    } | null | undefined;
}>;
export type NotifySettings = z.infer<typeof NOTIFY_SETTINGS_SCHEMA>;
export declare const REVOCATIONS_SCHEMA: z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodNumber>;
    revoked: z.ZodDefault<z.ZodArray<z.ZodObject<{
        jti: z.ZodString;
        exp: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        jti: string;
        exp: number;
    }, {
        jti: string;
        exp: number;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: number;
    revoked: {
        jti: string;
        exp: number;
    }[];
}, {
    schemaVersion?: number | undefined;
    revoked?: {
        jti: string;
        exp: number;
    }[] | undefined;
}>;
export type Revocations = z.infer<typeof REVOCATIONS_SCHEMA>;
export declare const APP_INFO_SCHEMA: z.ZodObject<{
    key: z.ZodString;
    name: z.ZodString;
    url: z.ZodString;
    icon: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    key: string;
    name: string;
    url: string;
    icon?: string | undefined;
}, {
    key: string;
    name: string;
    url: string;
    icon?: string | undefined;
}>;
export type AppInfo = z.infer<typeof APP_INFO_SCHEMA>;
export declare const APPS_SCHEMA: z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodNumber>;
    apps: z.ZodDefault<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        name: z.ZodString;
        url: z.ZodString;
        icon: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
    }, {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: number;
    apps: {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
    }[];
}, {
    schemaVersion?: number | undefined;
    apps?: {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
    }[] | undefined;
}>;
export type AppsRegistry = z.infer<typeof APPS_SCHEMA>;
