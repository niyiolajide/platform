import { z } from 'zod';
export declare const PROVIDER_KIND: z.ZodEnum<["gemini", "anthropic", "ollama"]>;
export type ProviderKind = z.infer<typeof PROVIDER_KIND>;
export declare const CASCADE_STEP_SCHEMA: z.ZodObject<{
    provider: z.ZodEnum<["gemini", "anthropic", "ollama"]>;
    model: z.ZodString;
}, "strip", z.ZodTypeAny, {
    provider: "gemini" | "anthropic" | "ollama";
    model: string;
}, {
    provider: "gemini" | "anthropic" | "ollama";
    model: string;
}>;
export type CascadeStep = z.infer<typeof CASCADE_STEP_SCHEMA>;
export declare const DEFAULT_CASCADES: {
    main: CascadeStep[];
    fast: CascadeStep[];
};
export declare const CASCADES_SCHEMA: z.ZodDefault<z.ZodObject<{
    main: z.ZodDefault<z.ZodArray<z.ZodObject<{
        provider: z.ZodEnum<["gemini", "anthropic", "ollama"]>;
        model: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }, {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }>, "many">>;
    fast: z.ZodDefault<z.ZodArray<z.ZodObject<{
        provider: z.ZodEnum<["gemini", "anthropic", "ollama"]>;
        model: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }, {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    main: {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }[];
    fast: {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }[];
}, {
    main?: {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }[] | undefined;
    fast?: {
        provider: "gemini" | "anthropic" | "ollama";
        model: string;
    }[] | undefined;
}>>;
export declare const OLLAMA_SCHEMA: z.ZodDefault<z.ZodObject<{
    baseUrl: z.ZodDefault<z.ZodString>;
    keepAlive: z.ZodDefault<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
}, "strip", z.ZodTypeAny, {
    baseUrl: string;
    keepAlive: string | number;
}, {
    baseUrl?: string | undefined;
    keepAlive?: string | number | undefined;
}>>;
export declare const AI_SETTINGS_SCHEMA: z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodNumber>;
    cascades: z.ZodDefault<z.ZodObject<{
        main: z.ZodDefault<z.ZodArray<z.ZodObject<{
            provider: z.ZodEnum<["gemini", "anthropic", "ollama"]>;
            model: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }, {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }>, "many">>;
        fast: z.ZodDefault<z.ZodArray<z.ZodObject<{
            provider: z.ZodEnum<["gemini", "anthropic", "ollama"]>;
            model: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }, {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        main: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[];
        fast: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[];
    }, {
        main?: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[] | undefined;
        fast?: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[] | undefined;
    }>>;
    ollama: z.ZodDefault<z.ZodObject<{
        baseUrl: z.ZodDefault<z.ZodString>;
        keepAlive: z.ZodDefault<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
    }, "strip", z.ZodTypeAny, {
        baseUrl: string;
        keepAlive: string | number;
    }, {
        baseUrl?: string | undefined;
        keepAlive?: string | number | undefined;
    }>>;
    anonymizeRequests: z.ZodDefault<z.ZodBoolean>;
    maskNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    notPersonNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    logAiCalls: z.ZodDefault<z.ZodBoolean>;
    logPayloads: z.ZodDefault<z.ZodBoolean>;
    aiLogRetentionDays: z.ZodDefault<z.ZodNumber>;
    aiLogPayloadRetentionDays: z.ZodDefault<z.ZodNumber>;
    provider: z.ZodDefault<z.ZodEnum<["anthropic", "gemini"]>>;
    fallbackEnabled: z.ZodDefault<z.ZodBoolean>;
    anthropicModel: z.ZodDefault<z.ZodString>;
    anthropicModelFast: z.ZodDefault<z.ZodString>;
    geminiModel: z.ZodDefault<z.ZodString>;
    geminiModelFast: z.ZodDefault<z.ZodString>;
    geminiModelFallback: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    ollama: {
        baseUrl: string;
        keepAlive: string | number;
    };
    provider: "gemini" | "anthropic";
    schemaVersion: number;
    cascades: {
        main: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[];
        fast: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[];
    };
    anonymizeRequests: boolean;
    maskNames: string[];
    notPersonNames: string[];
    logAiCalls: boolean;
    logPayloads: boolean;
    aiLogRetentionDays: number;
    aiLogPayloadRetentionDays: number;
    fallbackEnabled: boolean;
    anthropicModel: string;
    anthropicModelFast: string;
    geminiModel: string;
    geminiModelFast: string;
    geminiModelFallback: string;
}, {
    ollama?: {
        baseUrl?: string | undefined;
        keepAlive?: string | number | undefined;
    } | undefined;
    provider?: "gemini" | "anthropic" | undefined;
    schemaVersion?: number | undefined;
    cascades?: {
        main?: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[] | undefined;
        fast?: {
            provider: "gemini" | "anthropic" | "ollama";
            model: string;
        }[] | undefined;
    } | undefined;
    anonymizeRequests?: boolean | undefined;
    maskNames?: string[] | undefined;
    notPersonNames?: string[] | undefined;
    logAiCalls?: boolean | undefined;
    logPayloads?: boolean | undefined;
    aiLogRetentionDays?: number | undefined;
    aiLogPayloadRetentionDays?: number | undefined;
    fallbackEnabled?: boolean | undefined;
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
export declare const NAV_ITEM_SCHEMA: z.ZodObject<{
    key: z.ZodString;
    label: z.ZodString;
    href: z.ZodString;
    icon: z.ZodOptional<z.ZodString>;
    emoji: z.ZodOptional<z.ZodString>;
    group: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    frequencyRank: z.ZodOptional<z.ZodNumber>;
    surfaces: z.ZodOptional<z.ZodArray<z.ZodEnum<["web", "phone", "ipad"]>, "many">>;
    tab: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    key: string;
    label: string;
    href: string;
    icon?: string | undefined;
    emoji?: string | undefined;
    group?: string | null | undefined;
    frequencyRank?: number | undefined;
    surfaces?: ("web" | "phone" | "ipad")[] | undefined;
    tab?: boolean | undefined;
}, {
    key: string;
    label: string;
    href: string;
    icon?: string | undefined;
    emoji?: string | undefined;
    group?: string | null | undefined;
    frequencyRank?: number | undefined;
    surfaces?: ("web" | "phone" | "ipad")[] | undefined;
    tab?: boolean | undefined;
}>;
export type NavItemInfo = z.infer<typeof NAV_ITEM_SCHEMA>;
export declare const APP_INFO_SCHEMA: z.ZodObject<{
    key: z.ZodString;
    name: z.ZodString;
    url: z.ZodString;
    icon: z.ZodOptional<z.ZodString>;
    nav: z.ZodOptional<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        label: z.ZodString;
        href: z.ZodString;
        icon: z.ZodOptional<z.ZodString>;
        emoji: z.ZodOptional<z.ZodString>;
        group: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        frequencyRank: z.ZodOptional<z.ZodNumber>;
        surfaces: z.ZodOptional<z.ZodArray<z.ZodEnum<["web", "phone", "ipad"]>, "many">>;
        tab: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        key: string;
        label: string;
        href: string;
        icon?: string | undefined;
        emoji?: string | undefined;
        group?: string | null | undefined;
        frequencyRank?: number | undefined;
        surfaces?: ("web" | "phone" | "ipad")[] | undefined;
        tab?: boolean | undefined;
    }, {
        key: string;
        label: string;
        href: string;
        icon?: string | undefined;
        emoji?: string | undefined;
        group?: string | null | undefined;
        frequencyRank?: number | undefined;
        surfaces?: ("web" | "phone" | "ipad")[] | undefined;
        tab?: boolean | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    key: string;
    name: string;
    url: string;
    icon?: string | undefined;
    nav?: {
        key: string;
        label: string;
        href: string;
        icon?: string | undefined;
        emoji?: string | undefined;
        group?: string | null | undefined;
        frequencyRank?: number | undefined;
        surfaces?: ("web" | "phone" | "ipad")[] | undefined;
        tab?: boolean | undefined;
    }[] | undefined;
}, {
    key: string;
    name: string;
    url: string;
    icon?: string | undefined;
    nav?: {
        key: string;
        label: string;
        href: string;
        icon?: string | undefined;
        emoji?: string | undefined;
        group?: string | null | undefined;
        frequencyRank?: number | undefined;
        surfaces?: ("web" | "phone" | "ipad")[] | undefined;
        tab?: boolean | undefined;
    }[] | undefined;
}>;
export type AppInfo = z.infer<typeof APP_INFO_SCHEMA>;
export declare const APPS_SCHEMA: z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodNumber>;
    apps: z.ZodDefault<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        name: z.ZodString;
        url: z.ZodString;
        icon: z.ZodOptional<z.ZodString>;
        nav: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            label: z.ZodString;
            href: z.ZodString;
            icon: z.ZodOptional<z.ZodString>;
            emoji: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            frequencyRank: z.ZodOptional<z.ZodNumber>;
            surfaces: z.ZodOptional<z.ZodArray<z.ZodEnum<["web", "phone", "ipad"]>, "many">>;
            tab: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            key: string;
            label: string;
            href: string;
            icon?: string | undefined;
            emoji?: string | undefined;
            group?: string | null | undefined;
            frequencyRank?: number | undefined;
            surfaces?: ("web" | "phone" | "ipad")[] | undefined;
            tab?: boolean | undefined;
        }, {
            key: string;
            label: string;
            href: string;
            icon?: string | undefined;
            emoji?: string | undefined;
            group?: string | null | undefined;
            frequencyRank?: number | undefined;
            surfaces?: ("web" | "phone" | "ipad")[] | undefined;
            tab?: boolean | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
        nav?: {
            key: string;
            label: string;
            href: string;
            icon?: string | undefined;
            emoji?: string | undefined;
            group?: string | null | undefined;
            frequencyRank?: number | undefined;
            surfaces?: ("web" | "phone" | "ipad")[] | undefined;
            tab?: boolean | undefined;
        }[] | undefined;
    }, {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
        nav?: {
            key: string;
            label: string;
            href: string;
            icon?: string | undefined;
            emoji?: string | undefined;
            group?: string | null | undefined;
            frequencyRank?: number | undefined;
            surfaces?: ("web" | "phone" | "ipad")[] | undefined;
            tab?: boolean | undefined;
        }[] | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: number;
    apps: {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
        nav?: {
            key: string;
            label: string;
            href: string;
            icon?: string | undefined;
            emoji?: string | undefined;
            group?: string | null | undefined;
            frequencyRank?: number | undefined;
            surfaces?: ("web" | "phone" | "ipad")[] | undefined;
            tab?: boolean | undefined;
        }[] | undefined;
    }[];
}, {
    schemaVersion?: number | undefined;
    apps?: {
        key: string;
        name: string;
        url: string;
        icon?: string | undefined;
        nav?: {
            key: string;
            label: string;
            href: string;
            icon?: string | undefined;
            emoji?: string | undefined;
            group?: string | null | undefined;
            frequencyRank?: number | undefined;
            surfaces?: ("web" | "phone" | "ipad")[] | undefined;
            tab?: boolean | undefined;
        }[] | undefined;
    }[] | undefined;
}>;
export type AppsRegistry = z.infer<typeof APPS_SCHEMA>;
