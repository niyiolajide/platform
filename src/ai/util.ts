// Small shared helpers for the JSON-producing providers (Gemini, Ollama).

/** Extract the first JSON object from model text (tolerant of stray prose). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return null
  const match = trimmed.match(/\{[\s\S]*\}/)
  try {
    return JSON.parse(match ? match[0] : trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Strip `<think>…</think>` reasoning blocks emitted by thinking models (qwen3). */
export function stripThink(text: string): string {
  return (text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

// Best-effort JSON Schema → Gemini responseSchema converter. Handles the common
// subset the apps use (object/array/string/number/integer/boolean + enum/required/
// description). Returns null on anything unsupported (anyOf/oneOf/$ref/tuples) so
// the caller falls back to mime-type-json + prompt-appended schema.
export function toGeminiSchema(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null
  const n = node as Record<string, any>
  const t = n.type
  const desc = n.description ? { description: n.description } : {}
  if (t === 'object') {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(n.properties ?? {})) {
      const c = toGeminiSchema(v)
      if (c == null) return null
      props[k] = c
    }
    return {
      type: 'object',
      properties: props,
      ...(Array.isArray(n.required) ? { required: n.required } : {}),
      ...desc,
    }
  }
  if (t === 'array') {
    const items = toGeminiSchema(n.items)
    if (items == null) return null
    return { type: 'array', items, ...desc }
  }
  if (t === 'string') {
    return Array.isArray(n.enum)
      ? { type: 'string', format: 'enum', enum: n.enum, ...desc }
      : { type: 'string', ...desc }
  }
  if (t === 'number' || t === 'integer' || t === 'boolean') {
    return { type: t, ...desc }
  }
  return null
}
