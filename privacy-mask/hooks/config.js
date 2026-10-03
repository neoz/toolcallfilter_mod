const RULE_NAME = /^[A-Z][A-Z0-9_]*$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Parses one config file's text into { terms, regex }; throws an Error naming `label` on any problem.
export function parseConfig(text, label) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${label}: invalid JSON: ${err.message}`)
  }
  if (!isPlainObject(raw)) throw new Error(`${label}: the config must be a JSON object`)

  const terms = raw.terms ?? {}
  if (!isPlainObject(terms)) throw new Error(`${label}: "terms" must be an object`)
  for (const [original, replacement] of Object.entries(terms)) {
    if (original === '' || typeof replacement !== 'string' || replacement === '') {
      throw new Error(`${label}: term "${original}" must map a non-empty string to a non-empty string`)
    }
  }

  const rules = raw.regex ?? []
  if (!Array.isArray(rules)) throw new Error(`${label}: "regex" must be an array`)
  const seen = new Set()
  const regex = rules.map((rule, index) => {
    if (!isPlainObject(rule) || typeof rule.name !== 'string' || !RULE_NAME.test(rule.name)) {
      throw new Error(`${label}: regex rule ${index} needs a "name" matching ${RULE_NAME}`)
    }
    if (seen.has(rule.name)) throw new Error(`${label}: regex rule "${rule.name}" is declared twice`)
    seen.add(rule.name)
    if (typeof rule.pattern !== 'string' || rule.pattern === '') {
      throw new Error(`${label}: regex rule "${rule.name}" needs a non-empty "pattern"`)
    }
    const flags = rule.flags ?? ''
    if (typeof flags !== 'string') throw new Error(`${label}: regex rule "${rule.name}" has non-string "flags"`)
    try {
      new RegExp(rule.pattern, flags.includes('g') ? flags : flags + 'g')
    } catch (err) {
      throw new Error(`${label}: regex rule "${rule.name}": ${err.message}`)
    }
    return { name: rule.name, pattern: rule.pattern, flags }
  })

  return { terms: { ...terms }, regex }
}

// Merges the global and project configs (either may be undefined); the project wins on the same
// term original or rule name. Global rules keep their order, project-only rules follow.
export function mergeConfigs(globalConfig, projectConfig) {
  const empty = { terms: {}, regex: [] }
  const base = globalConfig ?? empty
  const over = projectConfig ?? empty
  const overByName = new Map(over.regex.map((rule) => [rule.name, rule]))
  const baseNames = new Set(base.regex.map((rule) => rule.name))
  return {
    terms: { ...base.terms, ...over.terms },
    regex: [
      ...base.regex.map((rule) => overByName.get(rule.name) ?? rule),
      ...over.regex.filter((rule) => !baseNames.has(rule.name)),
    ],
  }
}

// Rejects merged terms that would make unmasking ambiguous or masking non-idempotent.
export function validateConfig(config) {
  const entries = Object.entries(config.terms)
  const byReplacement = new Map()
  for (const [original, replacement] of entries) {
    const other = byReplacement.get(replacement)
    if (other !== undefined) throw new Error(`terms "${other}" and "${original}" share the replacement "${replacement}"`)
    byReplacement.set(replacement, original)
  }
  for (const [, replacement] of entries) {
    const inside = entries.find(([original]) => replacement.includes(original))
    if (inside !== undefined) throw new Error(`replacement "${replacement}" contains the term "${inside[0]}"`)
  }
}
