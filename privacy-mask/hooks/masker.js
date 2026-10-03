import { fromHex, hmacSha256, toHex, utf8 } from './hmac.js'

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One regex matching any of the strings, longest first so a longer term wins over its prefix.
function alternation(strings) {
  if (strings.length === 0) return null
  const sorted = [...strings].sort((a, b) => b.length - a.length)
  return new RegExp(sorted.map(escapeRegex).join('|'), 'g')
}

// Base64 payloads of images and documents: a Read result's `base64`, and the `data` of an API or
// MCP image/base64 block. Rewriting them would corrupt the media.
function isBinaryField(object, key) {
  return key === 'base64' || (key === 'data' && (object.type === 'base64' || object.type === 'image'))
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, isBinaryField(value, key) ? item : mapStrings(item, fn)]),
    )
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
    // No word boundaries: a rule may match inside an identifier, so its placeholder can touch
    // word characters (user_EMP_0123456789). Only tokens in the reverse table are restored.
    token: new RegExp(`${rule.name}_[0-9a-f]{10}`, 'g'),
  }))
  // Placeholders of the configured rules; text in this form is never masked again.
  const anyPlaceholder = alternation(rules.map((rule) => rule.name + '_'))
  const placeholderToken = anyPlaceholder === null ? null : new RegExp(`(?:${anyPlaceholder.source})[0-9a-f]{10}`, 'g')
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

  // Applies fn to the parts of text between issued placeholders, leaving the placeholders as they are.
  function outsidePlaceholders(text, fn) {
    if (placeholderToken === null) return fn(text)
    let out = ''
    let last = 0
    for (const token of text.matchAll(placeholderToken)) {
      out += fn(text.slice(last, token.index)) + token[0]
      last = token.index + token[0].length
    }
    return out + fn(text.slice(last))
  }

  function mask(text) {
    let out = termOriginals === null ? text : outsidePlaceholders(text, (part) => part.replace(termOriginals, (original) => terms[original]))
    for (const rule of rules) {
      out = outsidePlaceholders(out, (part) => part.replace(rule.pattern, (match) => (match === '' ? match : placeholder(rule.name, match))))
    }
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
