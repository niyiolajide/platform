"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyDataPolicy = applyDataPolicy;
const registry_1 = require("./registry");
function normalized(value) {
    return (value ?? '').trim().toLowerCase();
}
function routeForApp(settings, app) {
    const appKey = normalized(app);
    if (appKey === '') {
        return null;
    }
    return settings.dataPolicy.domainRouting.find((route) => route.apps.some((candidate) => normalized(candidate) === appKey)) ?? null;
}
function applyDataPolicy(settings, steps, app) {
    const route = routeForApp(settings, app);
    if (route?.mode === 'local-only') {
        return steps.filter((step) => (0, registry_1.getAdapter)(step.provider).local === true);
    }
    const allowedExternal = new Set(settings.dataPolicy.externalProviders);
    return steps.filter((step) => (0, registry_1.getAdapter)(step.provider).local === true || allowedExternal.has(step.provider));
}
