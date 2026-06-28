"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveChannels = resolveChannels;
exports.notify = notify;
exports.isNotifyConfigured = isNotifyConfigured;
const config_1 = require("../config");
const store_1 = require("../control/store");
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };
function inQuietHours(start, end, hour) {
    // Window may wrap past midnight (e.g. 22→7).
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}
/** Resolve which channels should fire for this app+level from the routing config. */
function resolveChannels(app, level) {
    const cfg = (0, store_1.readNotifySettings)();
    if (cfg.quietHours && level !== 'error') {
        const hour = new Date().getHours();
        if (inQuietHours(cfg.quietHours.start, cfg.quietHours.end, hour)) {
            return [];
        }
    }
    const matching = cfg.routes.filter((r) => (!r.app || r.app === app) && LEVEL_RANK[level] >= LEVEL_RANK[r.minLevel]);
    const set = new Set();
    for (const r of matching) {
        for (const c of r.channels) {
            set.add(c);
        }
    }
    return [...set];
}
// ── Channel senders (never throw) ─────────────────────────────────────────────
async function sendTelegram(text) {
    const token = process.env.TELEGRAM_OPS_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_OPS_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
    if (token == null || token === '' || chat == null || chat === '') {
        return false;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
            signal: AbortSignal.timeout(15000),
        });
        return res.ok;
    }
    catch (err) {
        (0, config_1.getLogger)().warn({ err }, '[notify/telegram] send failed');
        return false;
    }
}
async function sendSignal(text) {
    const apiUrl = (process.env.SIGNAL_API_URL ?? '').replace(/\/$/, '');
    const number = process.env.SIGNAL_NUMBER;
    const recipients = (process.env.SIGNAL_DEFAULT_RECIPIENT ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    if (apiUrl === '' || number == null || number === '' || recipients.length === 0) {
        return false;
    }
    try {
        const res = await fetch(`${apiUrl}/v2/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: text, number, recipients }),
            signal: AbortSignal.timeout(15000),
        });
        return res.ok;
    }
    catch (err) {
        (0, config_1.getLogger)().warn({ err }, '[notify/signal] send failed');
        return false;
    }
}
async function sendEmail(subject, text) {
    // Email goes through an SMTP relay if configured. Kept dependency-free (uses the
    // app's own mailer when present); here we no-op gracefully if unconfigured.
    const to = process.env.NOTIFY_EMAIL_TO;
    const apiUrl = process.env.NOTIFY_EMAIL_WEBHOOK; // optional simple webhook relay
    if (to == null || to === '' || apiUrl == null || apiUrl === '') {
        return false;
    }
    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to, subject, text }),
            signal: AbortSignal.timeout(15000),
        });
        return res.ok;
    }
    catch (err) {
        (0, config_1.getLogger)().warn({ err }, '[notify/email] send failed');
        return false;
    }
}
/**
 * Send a notification across the resolved channels. Returns a per-channel result
 * map. Never throws.
 */
async function notify(input) {
    const level = input.level ?? 'info';
    const channels = input.channels ?? resolveChannels(input.app, level);
    const text = input.body ? `<b>${input.title}</b>\n${input.body}` : input.title;
    const plain = input.body ? `${input.title}\n${input.body}` : input.title;
    const result = {};
    await Promise.all(channels.map(async (c) => {
        switch (c) {
            case 'telegram':
                result.telegram = await sendTelegram(text);
                break;
            case 'signal':
                result.signal = await sendSignal(plain);
                break;
            case 'email':
                result.email = await sendEmail(`[${input.app}] ${input.title}`, plain);
                break;
        }
    }));
    // Delivery is best-effort (never throws), but a notification that fails on EVERY
    // resolved channel is indistinguishable from success to the caller (which discards
    // the result map). Warn so a misconfigured/hung channel doesn't drop alerts silently.
    if (channels.length > 0 && Object.values(result).every((ok) => !ok)) {
        (0, config_1.getLogger)().warn({ app: input.app, level, channels, title: input.title }, '[notify] all resolved channels failed — notification NOT delivered');
    }
    return result;
}
function isNotifyConfigured() {
    return [
        process.env.TELEGRAM_OPS_BOT_TOKEN,
        process.env.TELEGRAM_BOT_TOKEN,
        process.env.SIGNAL_API_URL,
        process.env.NOTIFY_EMAIL_WEBHOOK,
    ].some((value) => value != null && value !== '');
}
