import { mergeConfigs, parseConfig, validateConfig } from './config.js'
import { toHex } from './hmac.js'
import { createMasker } from './masker.js'

const SECRET_KEY = 'privacy-mask:secret'
const REVERSE_PREFIX = 'privacy-mask:reverse:'
const CONFIG_FILE = '/.claude/privacy-mask.json'

// Loaded once per module load; /reload-plugins re-runs the module and loads again.
let statePromise

function randomSecretHex() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

async function loadState($) {
  const loaded = []
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const root = await $.session.root()
    const sources = [
      { label: 'global', path: home === undefined ? undefined : home + CONFIG_FILE },
      { label: 'project', path: root + CONFIG_FILE },
    ]
    const parsed = {}
    for (const source of sources) {
      if (source.path === undefined || !(await $.fs.exists(source.path))) continue
      parsed[source.label] = parseConfig(await $.fs.read(source.path), source.path)
      loaded.push(source.label)
    }
    if (loaded.length === 0) return { mode: 'pass-through', loaded }
    const config = mergeConfigs(parsed.global, parsed.project)
    validateConfig(config)

    let secret = await $.store.get(SECRET_KEY)
    if (typeof secret !== 'string') {
      secret = randomSecretHex()
      await $.store.set(SECRET_KEY, secret)
    }
    const reverseKey = REVERSE_PREFIX + root
    const reverse = { ...((await $.store.get(reverseKey)) ?? {}) }
    return { mode: 'active', loaded, config, reverseKey, reverse, masker: createMasker(config, secret, reverse) }
  } catch (err) {
    return { mode: 'blocked', loaded, error: err.message }
  }
}

function state($) {
  statePromise ??= loadState($)
  return statePromise
}

// The active state, or null in pass-through mode; throws in blocked mode so the hook fails closed.
async function activeState($) {
  const s = await state($)
  if (s.mode === 'blocked') throw new Error(s.error)
  return s.mode === 'active' ? s : null
}

// Saves reverse-table entries issued since the last save, merged with what other sessions stored.
async function persist($, s) {
  if (!s.masker.takeAdded()) return
  const stored = (await $.store.get(s.reverseKey)) ?? {}
  Object.assign(s.reverse, { ...stored, ...s.reverse })
  await $.store.set(s.reverseKey, s.reverse)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'privacy-mask', description: 'Show privacy-mask status', immediate: true })
    const s = await state($)
    if (s.mode === 'pass-through') $.ui.toast('privacy-mask: no config file found, masking is off')
    if (s.mode === 'blocked') $.ui.toast('privacy-mask: prompts are blocked: ' + s.error)
    return next(e)
  })

  on('command.run', { command: 'privacy-mask' }, async ($) => {
    const s = await state($)
    const lines = ['mode: ' + s.mode, 'config files: ' + (s.loaded.length > 0 ? s.loaded.join(', ') : 'none')]
    if (s.mode === 'active') {
      lines.push(
        'terms: ' + Object.keys(s.config.terms).length,
        'regex rules: ' + s.config.regex.length,
        'reverse table entries: ' + Object.keys(s.reverse).length,
      )
    }
    if (s.mode === 'blocked') lines.push('error: ' + s.error)
    return { text: lines.join('\n') }
  })

  on('prompt.submit', async ($, e, next) => {
    const s = await activeState($)
    if (s === null) return next(e)
    const masked = { ...e, text: s.masker.mask(e.text) }
    if (e.context !== undefined) masked.context = e.context.map((text) => s.masker.mask(text))
    await persist($, s)
    return next(masked)
  }).catch(async ($, e, next) => ({ drop: 'privacy-mask: prompt not sent: ' + next.error.message }))
}
