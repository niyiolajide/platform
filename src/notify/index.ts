import { getLogger } from '../config'
import { readNotifySettings } from '../control/store'
import type { NotifyChannel } from '../control/schema'

// ── Unified notifier ──────────────────────────────────────────────────────────
// One entry point over Telegram, email, and the standalone Signal daemon. Routing,
// recipients, and quiet hours come from the control bus (hub-managed). Channel
// credentials/endpoints come from env (shared.env). Contract: never throws — a
// notification failure must never break the caller (mirrors the existing helpers).

export type NotifyLevel = 'info' | 'warn' | 'error'

export interface NotifyInput {
  app: string
  level?: NotifyLevel
  title: string
  body?: string
  /** Restrict to specific channels, overriding the routing config. */
  channels?: NotifyChannel[]
}

const LEVEL_RANK: Record<NotifyLevel, number> = { info: 0, warn: 1, error: 2 }

function inQuietHours(start: number, end: number, hour: number): boolean {
  // Window may wrap past midnight (e.g. 22→7).
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}

/** Resolve which channels should fire for this app+level from the routing config. */
export function resolveChannels(app: string, level: NotifyLevel): NotifyChannel[] {
  const cfg = readNotifySettings()
  if (cfg.quietHours && level !== 'error') {
    const hour = new Date().getHours()
    if (inQuietHours(cfg.quietHours.start, cfg.quietHours.end, hour)) return []
  }
  const matching = cfg.routes.filter(
    (r) => (!r.app || r.app === app) && LEVEL_RANK[level] >= LEVEL_RANK[r.minLevel],
  )
  const set = new Set<NotifyChannel>()
  for (const r of matching) for (const c of r.channels) set.add(c)
  return [...set]
}

// ── Channel senders (never throw) ─────────────────────────────────────────────

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_OPS_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_OPS_CHAT_ID || process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
    return res.ok
  } catch (err) {
    getLogger().warn({ err }, '[notify/telegram] send failed')
    return false
  }
}

async function sendSignal(text: string): Promise<boolean> {
  const apiUrl = (process.env.SIGNAL_API_URL || '').replace(/\/$/, '')
  const number = process.env.SIGNAL_NUMBER
  const recipients = (process.env.SIGNAL_DEFAULT_RECIPIENT || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  if (!apiUrl || !number || recipients.length === 0) return false
  try {
    const res = await fetch(`${apiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, number, recipients }),
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok
  } catch (err) {
    getLogger().warn({ err }, '[notify/signal] send failed')
    return false
  }
}

async function sendEmail(subject: string, text: string): Promise<boolean> {
  // Email goes through an SMTP relay if configured. Kept dependency-free (uses the
  // app's own mailer when present); here we no-op gracefully if unconfigured.
  const to = process.env.NOTIFY_EMAIL_TO
  const apiUrl = process.env.NOTIFY_EMAIL_WEBHOOK // optional simple webhook relay
  if (!to || !apiUrl) return false
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, subject, text }),
    })
    return res.ok
  } catch (err) {
    getLogger().warn({ err }, '[notify/email] send failed')
    return false
  }
}

/**
 * Send a notification across the resolved channels. Returns a per-channel result
 * map. Never throws.
 */
export async function notify(input: NotifyInput): Promise<Record<NotifyChannel, boolean>> {
  const level = input.level ?? 'info'
  const channels = input.channels ?? resolveChannels(input.app, level)
  const text = input.body ? `<b>${input.title}</b>\n${input.body}` : input.title
  const plain = input.body ? `${input.title}\n${input.body}` : input.title
  const result: Record<string, boolean> = {}
  await Promise.all(
    channels.map(async (c) => {
      if (c === 'telegram') result.telegram = await sendTelegram(text)
      else if (c === 'signal') result.signal = await sendSignal(plain)
      else if (c === 'email') result.email = await sendEmail(`[${input.app}] ${input.title}`, plain)
    }),
  )
  return result as Record<NotifyChannel, boolean>
}

export function isNotifyConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_OPS_BOT_TOKEN ||
      process.env.TELEGRAM_BOT_TOKEN ||
      process.env.SIGNAL_API_URL ||
      process.env.NOTIFY_EMAIL_WEBHOOK,
  )
}
