import { mergeConfigs, parseConfig, validateConfig } from './config.js'
import { toHex } from './hmac.js'
import { createMasker, mapMessageText } from './masker.js'

const SECRET_KEY = 'privacy-mask:secret'
const REVERSE_PREFIX = 'privacy-mask:reverse:'
const CONFIG_FILE = '/.claude/privacy-mask.json'
const RESERVED_TOOL_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])
const WITHHELD = '[privacy-mask: content withheld]'

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
    // USERPROFILE first: on Windows it is the home Claude Code uses, while a shell may set HOME elsewhere.
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
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
// A failed save (the store is capped at 4 MiB) never blocks masking: the masked text does not
// depend on the table, only later sessions lose the ability to show those originals.
async function persist($, s) {
  if (!s.masker.takeAdded()) return
  try {
    const stored = (await $.store.get(s.reverseKey)) ?? {}
    Object.assign(s.reverse, { ...stored, ...s.reverse })
    await $.store.set(s.reverseKey, s.reverse)
  } catch (err) {
    if (s.saveFailed) return
    s.saveFailed = true
    $.ui.toast('privacy-mask: could not save the reverse table: ' + err.message)
  }
}

// The masker for drawing, or null when nothing is masked; drawing never fails closed.
async function displayMasker($) {
  const s = await state($)
  return s.mode === 'active' ? s.masker : null
}

// The tool's own arguments of a tool.call event, without the engine's reserved keys, unmasked for
// the tool to run on. Arguments the engine forwards to a model call stay masked: WebSearch's query
// runs on the Anthropic API and WebFetch's prompt goes to a model; only WebFetch's url must be real.
function unmaskedArguments(e, masker) {
  const args = Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED_TOOL_KEYS.has(key)))
  if (e.tool === 'WebSearch') return args
  if (e.tool === 'WebFetch') return { ...args, url: masker.unmask(args.url) }
  return masker.deepUnmask(args)
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

  on('tool.call', async ($, e, next) => {
    const s = await activeState($)
    if (s === null) return next(e)
    const result = await next({ ...e, ...unmaskedArguments(e, s.masker) })
    let masked
    if (result.deny !== undefined) {
      masked = { deny: s.masker.mask(result.deny) }
    } else if (result.isError) {
      masked = { deny: s.masker.mask(result.text ?? 'The tool failed.') }
    } else {
      // A fresh object without core's ref and text: returning core's own object would make core
      // send its unmasked messages verbatim.
      // Context entries from below must be kept as they are; they reach the model as attachments,
      // which the prompt.attachment and session.append hooks mask.
      masked = { result: s.masker.deepMask(result.result) }
      if (result.context !== undefined) masked.context = result.context
    }
    await persist($, s)
    return masked
  }).catch(async () => ({ deny: 'privacy-mask: the tool result was withheld because masking failed.' }))

  on('prompt.section', async ($, e, next) => {
    const s = await activeState($)
    const result = await next(e)
    if (s === null || result.text === null) return result
    const masked = { text: s.masker.mask(result.text) }
    await persist($, s)
    return masked
  }).catch(async () => ({ text: null }))

  on('prompt.context', async ($, e, next) => {
    const s = await activeState($)
    const result = await next(e)
    if (s === null) return result
    // Without instructionFiles, so the engine cannot re-render claudeMd from the unmasked files.
    const masked = { blocks: result.blocks.map((block) => ({ ...block, text: s.masker.mask(block.text) })) }
    await persist($, s)
    return masked
  }).catch(async () => ({ blocks: [] }))

  on('prompt.attachment', async ($, e, next) => {
    const s = await activeState($)
    const result = await next(e)
    if (s === null || result.text === null) return result
    const masked = { text: s.masker.mask(result.text) }
    await persist($, s)
    return masked
  }).catch(async () => ({ text: null }))

  on('skill.prompt', async ($, e, next) => {
    const s = await activeState($)
    const result = await next(e)
    if (s === null) return result
    const masked = { text: s.masker.mask(result.text) }
    await persist($, s)
    return masked
  }).catch(async () => ({ text: '' }))

  on('tool.describe', async ($, e, next) => {
    const s = await activeState($)
    const result = await next(e)
    if (s === null) return result
    const masked = { ...result, description: s.masker.mask(result.description) }
    await persist($, s)
    return masked
  }).catch(async () => ({ description: '' }))

  on('session.append', async ($, e, next) => {
    const s = await activeState($)
    if (s === null || e.message.role === undefined) return next(e)
    const message = mapMessageText(e.message, (text) => s.masker.mask(text))
    await persist($, s)
    return next({ ...e, message })
  }).catch(async ($, e, next) => {
    // A hook may not refuse an engine row, so the row is kept with its text withheld.
    if (e.message.role === undefined) return next(e)
    return next({ ...e, message: mapMessageText(e.message, () => WITHHELD) })
  })

  on('ui.render', { component: ['AssistantMessage', 'UserMessage'] }, async ($, e, next) => {
    const masker = await displayMasker($)
    if (masker === null) return next(e)
    return next({ ...e, props: { ...e.props, text: masker.unmask(e.props.text) } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const masker = await displayMasker($)
    if (masker === null) return next(e)
    const props = { ...e.props, input: masker.deepUnmask(e.props.input) }
    if (e.props.output !== undefined) props.output = masker.deepUnmask(e.props.output)
    return next({ ...e, props })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const masker = await displayMasker($)
    if (masker === null) return next(e)
    return next({ ...e, props: { ...e.props, output: masker.deepUnmask(e.props.output) } })
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const masker = await displayMasker($)
    if (masker === null) return next(e)
    return next({ ...e, props: { ...e.props, questions: masker.deepUnmask(e.props.questions) } })
  })
}
