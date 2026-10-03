const RULE_NAME = /^[A-Z][A-Z0-9_]*$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Parses one config file's text into { terms, regex }; throws an Error naming `label` on any problem.
// Messages reach toasts, /privacy-mask and drop notices, so they never quote a term original or
// the file text an engine error message would echo; terms are named by position or replacement.
export function parseConfig(text, label) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`${label}: invalid JSON`)
  }
  if (!isPlainObject(raw)) throw new Error(`${label}: the config must be a JSON object`)

  const terms = raw.terms ?? {}
  if (!isPlainObject(terms)) throw new Error(`${label}: "terms" must be an object`)
  Object.entries(terms).forEach(([original, replacement], index) => {
    if (original === '' || typeof replacement !== 'string' || replacement === '') {
      throw new Error(`${label}: term #${index + 1} must map a non-empty string to a non-empty string`)
    }
  })

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
    } catch {
      throw new Error(`${label}: regex rule "${rule.name}" has an invalid pattern or flags`)
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

// Rejects merged terms that would make unmasking ambiguous or let an original escape masking: the
// term pass leaves replacements untouched, so an original overlapping a replacement would stay raw.
export function validateConfig(config) {
  const entries = Object.entries(config.terms)
  const replacements = new Set()
  for (const [, replacement] of entries) {
    if (replacements.has(replacement)) throw new Error(`two terms share the replacement "${replacement}"`)
    replacements.add(replacement)
  }
  for (const [, replacement] of entries) {
    const inside = entries.find(([original]) => replacement.includes(original))
    if (inside !== undefined) {
      throw new Error(`replacement "${replacement}" contains the original of the term replaced by "${inside[1]}"`)
    }
  }
  for (const [original, replacement] of entries) {
    const inside = entries.find(([, other]) => original.includes(other))
    if (inside !== undefined) {
      throw new Error(`the original of the term replaced by "${replacement}" contains the replacement "${inside[1]}"`)
    }
  }
}
