import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveChannels, notify } from '../src/notify'
import { publishNotifySettings, _clearCache, NOTIFY_SETTINGS_SCHEMA } from '../src/control'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'))
  process.env.CONTROL_DIR = dir
  _clearCache()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveChannels', () => {
  it('defaults to telegram for any app/level', () => {
    expect(resolveChannels('finpulse', 'info')).toEqual(['telegram'])
  })

  it('honors per-app routing and minLevel', () => {
    publishNotifySettings(
      NOTIFY_SETTINGS_SCHEMA.parse({
        routes: [
          { app: 'finpulse', minLevel: 'warn', channels: ['telegram', 'signal'] },
          { minLevel: 'error', channels: ['email'] },
        ],
      }),
    )
    _clearCache()
    expect(resolveChannels('finpulse', 'info').sort()).toEqual([]) // below minLevel warn
    expect(resolveChannels('finpulse', 'warn').sort()).toEqual(['signal', 'telegram'])
    expect(resolveChannels('finpulse', 'error').sort()).toEqual(['email', 'signal', 'telegram'])
  })

  it('suppresses non-error notifications during quiet hours but lets errors through', () => {
    const hour = new Date().getHours()
    publishNotifySettings(
      NOTIFY_SETTINGS_SCHEMA.parse({
        routes: [{ minLevel: 'info', channels: ['telegram'] }],
        quietHours: { start: hour, end: (hour + 1) % 24 },
      }),
    )
    _clearCache()
    expect(resolveChannels('x', 'info')).toEqual([])
    expect(resolveChannels('x', 'error')).toEqual(['telegram'])
  })
})

describe('notify', () => {
  it('never throws and returns a result map even with no channel creds', async () => {
    const res = await notify({ app: 'x', level: 'info', title: 'hi' })
    expect(res.telegram).toBe(false)
  })
})
