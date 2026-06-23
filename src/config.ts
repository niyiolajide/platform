// Platform-wide injectable config: a logger and the keys read from process.env.
// Apps may call configurePlatform({ logger }) once at startup to route library
// logs through their own logger; otherwise a console-based logger is used.
// API keys are NEVER stored here in a mutable store — they are read live from
// process.env (sourced from the single shared.env file), so rotating a key is a
// restart, not a code change.

export interface PlatformLogger {
  warn: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

const consoleLogger: PlatformLogger = {
  warn: (o, m) => console.warn('[platform]', m ?? '', o ?? ''),
  info: (o, m) => console.info('[platform]', m ?? '', o ?? ''),
  error: (o, m) => console.error('[platform]', m ?? '', o ?? ''),
}

let logger: PlatformLogger = consoleLogger

export function configurePlatform(opts: { logger?: PlatformLogger }): void {
  if (opts.logger) logger = opts.logger
}

export function getLogger(): PlatformLogger {
  return logger
}

/** A pulse-token verification key: a key id + its PEM-encoded RSA public key. */
export interface PulsePublicKey {
  kid: string
  pem: string
}

/** API keys + the pulse-token signing/verification material — read live from env. */
export const keys = {
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || '',
  geminiApiKey: () => process.env.GEMINI_API_KEY || '',
  sharedJwtSecret: () => process.env.SHARED_JWT_SECRET || '',

  /**
   * ControlPlane RSA private signing key (PKCS8 PEM), base64-encoded in
   * PULSE_TOKEN_PRIVATE_KEY_B64. Present ONLY in the ControlPlane container — apps
   * never receive it, so they can verify but cannot mint. Empty string if unset.
   */
  pulsePrivateKey: (): string => {
    const b64 = process.env.PULSE_TOKEN_PRIVATE_KEY_B64
    return b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''
  },

  /**
   * ControlPlane RSA public verification keys from PULSE_TOKEN_PUBLIC_KEYS — a JSON array of
   * `{kid, pem}` where `pem` is a base64-encoded SPKI PEM. Non-secret; shipped to
   * every container. Multiple entries support zero-downtime key rotation (verifiers
   * accept any listed key; the hub signs with one `kid`). Returns [] if unset/invalid.
   */
  pulsePublicKeys: (): PulsePublicKey[] => {
    const raw = process.env.PULSE_TOKEN_PUBLIC_KEYS
    if (!raw) return []
    try {
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return []
      return arr
        .filter((e) => e && typeof e.kid === 'string' && typeof e.pem === 'string')
        .map((e) => ({ kid: e.kid as string, pem: Buffer.from(e.pem as string, 'base64').toString('utf8') }))
    } catch {
      return []
    }
  },
}
