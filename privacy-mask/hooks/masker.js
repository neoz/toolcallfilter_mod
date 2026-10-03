import { fromHex, hmacSha256, toHex, utf8 } from './hmac.js'

// Any placeholder this mod can issue; text in this form is never masked again.
const ANY_PLACEHOLDER = /\b[A-Z][A-Z0-9_]*_[0-9a-f]{10}\b/g

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One regex matching any of the strings, longest first so a longer term wins over its prefix.
function alternation(strings) {
  if (strings.length === 0) return null
  const sorted = [...strings].sort((a, b) => b.length - a.length)
  return new RegExp(sorted.map(escapeRegex).join('|'), 'g')
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]))
  }
  return value
}

// Builds the mask/unmask functions for one merged config. `reverse` (placeholder -> original)
// is mutated as mask() issues placeholders; takeAdded() reports whether it grew since last asked.
export function createMasker(config, secretHex, reverse) {
  const terms = config.terms
  const termOriginals = alternation(Object.keys(terms))
  const originalOf = Object.fromEntries(Object.entries(terms).map(([original, replacement]) => [replacement, original]))
  const termReplacements = alternation(Object.keys(originalOf))
  const rules = config.regex.map((rule) => ({
    name: rule.name,
    pattern: new RegExp(rule.pattern, rule.flags.includes('g') ? rule.flags : rule.flags + 'g'),
    token: new RegExp(`\\b${rule.name}_[0-9a-f]{10}\\b`, 'g'),
  }))
  const key = fromHex(secretHex)
  const issued = new Map()
  let added = false

  function placeholder(name, value) {
    const cacheKey = name + '\0' + value
    let id = issued.get(cacheKey)
    if (id === undefined) {
      id = name + '_' + toHex(hmacSha256(key, utf8(cacheKey))).slice(0, 10)
      issued.set(cacheKey, id)
    }
    const known = reverse[id]
    if (known === undefined) {
      reverse[id] = value
      added = true
    } else if (known !== value) {
      throw new Error(`placeholder collision on ${id}`)
    }
    return id
  }

  function maskRule(text, rule) {
    const replace = (part) => part.replace(rule.pattern, (match) => (match === '' ? match : placeholder(rule.name, match)))
    let out = ''
    let last = 0
    for (const token of text.matchAll(ANY_PLACEHOLDER)) {
      out += replace(text.slice(last, token.index)) + token[0]
      last = token.index + token[0].length
    }
    return out + replace(text.slice(last))
  }

  function mask(text) {
    let out = termOriginals === null ? text : text.replace(termOriginals, (original) => terms[original])
    for (const rule of rules) out = maskRule(out, rule)
    return out
  }

  function unmask(text) {
    let out = text
    for (let i = rules.length - 1; i >= 0; i--) out = out.replace(rules[i].token, (token) => reverse[token] ?? token)
    return termReplacements === null ? out : out.replace(termReplacements, (replacement) => originalOf[replacement])
  }

  return {
    mask,
    unmask,
    deepMask: (value) => mapStrings(value, mask),
    deepUnmask: (value) => mapStrings(value, unmask),
    takeAdded() {
      const result = added
      added = false
      return result
    },
  }
}

// Applies fn to the text an API content block carries: a text block, or a tool_result's content.
export function mapBlockText(block, fn) {
  if (block.type === 'text') return { ...block, text: fn(block.text) }
  if (block.type !== 'tool_result') return block
  if (typeof block.content === 'string') return { ...block, content: fn(block.content) }
  if (!Array.isArray(block.content)) return block
  return { ...block, content: block.content.map((item) => (item.type === 'text' ? { ...item, text: fn(item.text) } : item)) }
}
