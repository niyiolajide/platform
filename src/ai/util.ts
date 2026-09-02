import type { Schema, Type } from '@google/genai'

// Small shared helpers for the JSON-producing providers (Gemini, Ollama).

/** Extract the first JSON object from model text (tolerant of stray prose). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) {return null}
  const match = trimmed.match(/\{[\s\S]*\}/)
  try {
    return JSON.parse(match ? match[0] : trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Strip `<think>…</think>` reasoning blocks emitted by thinking models (qwen3). */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

// Best-effort JSON Schema → Gemini responseSchema converter. Handles the common
// subset the apps use (object/array/string/number/integer/boolean + enum/required/
// description). Returns null on anything unsupported (anyOf/oneOf/$ref/tuples) so
// the caller falls back to mime-type-json + prompt-appended schema.
export function toGeminiSchema(node: unknown): Schema | null {
  if (node == null || typeof node !== 'object') {return null}
  const n = node as Record<string, unknown>
  const t = n.type
  const desc = typeof n.description === 'string' ? { description: n.description } : {}
  if (t === 'object') {
    const props: Record<string, Schema> = {}
    const rawProps = n.properties
    if (rawProps != null && (typeof rawProps !== 'object' || Array.isArray(rawProps))) {return null}
    for (const [k, v] of Object.entries(rawProps ?? {})) {
      const c = toGeminiSchema(v)
      if (c == null) {return null}
      props[k] = c
    }
    const required = Array.isArray(n.required) && n.required.every((item) => typeof item === 'string')
      ? n.required
      : undefined
    return {
      type: 'OBJECT' as Type,
      properties: props,
      ...(required != null ? { required } : {}),
      ...desc,
    }
  }
  if (t === 'array') {
    const items = toGeminiSchema(n.items)
    if (items == null) {return null}
    return { type: 'ARRAY' as Type, items, ...desc }
  }
  if (t === 'string') {
    return Array.isArray(n.enum)
      ? { type: 'STRING' as Type, format: 'enum', enum: n.enum, ...desc }
      : { type: 'STRING' as Type, ...desc }
  }
  if (t === 'number') {
    return { type: 'NUMBER' as Type, ...desc }
  }
  if (t === 'integer') {
    return { type: 'INTEGER' as Type, ...desc }
  }
  if (t === 'boolean') {
    return { type: 'BOOLEAN' as Type, ...desc }
  }
  return null
}
