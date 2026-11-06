// Edits one privacy-mask config file entry by entry, and writes it only when the file and the merged
// config pass the same checks the mod runs at load time.
// Usage: node edit-config.mjs <global|project> <op> [args] [--root <project dir>]
//   check | add-term <original> <replacement> | remove-term <original or replacement>
//   add-regex <NAME> <pattern> [flags] | remove-regex <NAME>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeConfigs, parseConfig, validateConfig } from '../../../hooks/config.js'

const CONFIG_FILE = join('.claude', 'privacy-mask.json')

function fail(message) {
  console.error('error: ' + message)
  process.exit(1)
}

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
const root = rootFlag === -1 ? process.cwd() : argv[rootFlag + 1]
if (rootFlag !== -1) argv.splice(rootFlag, 2)
const [scope, op, ...args] = argv

// USERPROFILE first, as the mod does: on Windows it is the home Claude Code uses.
const home = process.env.USERPROFILE ?? process.env.HOME
const paths = { global: join(home, CONFIG_FILE), project: join(root, CONFIG_FILE) }
if (!(scope in paths)) fail('the first argument must be "global" or "project"')

function load(label) {
  const path = paths[label]
  return existsSync(path) ? parseConfig(readFileSync(path, 'utf8'), path) : undefined
}

let target
let other
try {
  target = load(scope) ?? { terms: {}, regex: [] }
  other = load(scope === 'global' ? 'project' : 'global')
} catch (err) {
  fail(err.message)
}

function edit(config) {
  const terms = { ...config.terms }
  const regex = [...config.regex]
  switch (op) {
    case 'check':
      return null
    case 'add-term': {
      const [original, replacement] = args
      if (!original || !replacement) fail('add-term needs <original> <replacement>')
      terms[original] = replacement
      return { terms, regex }
    }
    case 'remove-term': {
      const [value] = args
      const key = Object.hasOwn(terms, value) ? value : Object.keys(terms).find((original) => terms[original] === value)
      if (key === undefined) fail('no term has that original or replacement')
      delete terms[key]
      return { terms, regex }
    }
    case 'add-regex': {
      const [name, pattern, flags] = args
      if (!name || !pattern) fail('add-regex needs <NAME> <pattern> [flags]')
      const rule = flags ? { name, pattern, flags } : { name, pattern }
      const index = regex.findIndex((existing) => existing.name === name)
      if (index === -1) regex.push(rule)
      else regex[index] = rule
      return { terms, regex }
    }
    case 'remove-regex': {
      const [name] = args
      const index = regex.findIndex((existing) => existing.name === name)
      if (index === -1) fail('no regex rule is named ' + name)
      regex.splice(index, 1)
      return { terms, regex }
    }
    default:
      fail('unknown operation ' + op)
  }
}

const next = edit(target)
const candidate = next ?? target
const text =
  JSON.stringify(
    { terms: candidate.terms, regex: candidate.regex.map(({ name, pattern, flags }) => (flags ? { name, pattern, flags } : { name, pattern })) },
    null,
    2,
  ) + '\n'

try {
  // Reparse the text to be written, so it is checked exactly as the mod will read it.
  const reparsed = parseConfig(text, paths[scope])
  validateConfig(scope === 'global' ? mergeConfigs(reparsed, other) : mergeConfigs(other, reparsed))
} catch (err) {
  fail(err.message + (next === null ? '' : ' (nothing was written)'))
}

if (next !== null) {
  mkdirSync(dirname(paths[scope]), { recursive: true })
  writeFileSync(paths[scope], text)
}
console.log(`ok: ${paths[scope]}: ${Object.keys(candidate.terms).length} terms, ${candidate.regex.length} regex rules`)
for (const rule of candidate.regex) console.log(`  ${rule.name}: ${rule.pattern}${rule.flags ? ' /' + rule.flags : ''}`)
if (next !== null) console.log('Run /reload-plugins to apply the change.')
