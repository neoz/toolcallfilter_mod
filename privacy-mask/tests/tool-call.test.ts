import { expect, test } from 'claude-code/testing'
import { CONFIG, GLOBAL_PATH, IP_PLACEHOLDER, SECRET, setupWorld } from './helpers.ts'

const KNOWN = { 'privacy-mask:secret': SECRET, 'privacy-mask:reverse:/proj': { [IP_PLACEHOLDER]: '10.0.0.5' } }
const WITHHELD = { deny: 'privacy-mask: the tool result was withheld because masking failed.' }

function bash(output: Record<string, unknown>) {
  return { ref: 7, text: 'raw text core built', result: { stdout: '', stderr: '', interrupted: false, ...output } }
}

test('runs the tool with original values and returns a fresh masked result', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  let ran: any
  on('tool.call', async (_$: unknown, e: any) => {
    ran = e
    return bash({ stdout: 'Acme Corp answered from 10.0.0.5' })
  })
  const result = await $.tool.call({ tool: 'Bash', command: `ping ${IP_PLACEHOLDER} # Contoso`, tool_use_id: 'tu1' } as any)
  expect(ran.command).toBe('ping 10.0.0.5 # Acme Corp')
  expect(ran.tool_use_id).toBe('tu1')
  expect(result).toEqual({ result: { stdout: `Contoso answered from ${IP_PLACEHOLDER}`, stderr: '', interrupted: false } })
})

// The engine refuses a hook that rewrites context entries a hook below attached; those entries
// reach the model as attachments, which the prompt.attachment and session.append hooks mask.
test('keeps the context a tool result carries and still masks the result', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  on('tool.call', async () => ({ ...bash({ stdout: 'Acme Corp' }), context: ['note about Acme Corp'] }))
  const result: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result.context).toEqual(['note about Acme Corp'])
  expect(result.result.stdout).toBe('Contoso')
})

test('turns an errored result into a masked denial', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  on('tool.call', async () => ({ isError: true, result: 'x', text: 'cannot reach 10.0.0.5', ref: 3 }))
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result).toEqual({ deny: `cannot reach ${IP_PLACEHOLDER}` })
})

test('masks a denial from further down the chain', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  on('tool.call', async () => ({ deny: 'Acme Corp policy refuses this' }))
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result).toEqual({ deny: 'Contoso policy refuses this' })
})

test('withholds the result when masking fails after the tool ran', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, {
    'privacy-mask:secret': SECRET,
    'privacy-mask:reverse:/proj': { [IP_PLACEHOLDER]: '1.1.1.1' },
  })
  on('tool.call', async () => bash({ stdout: '10.0.0.5' }))
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result).toEqual(WITHHELD)
})

test('refuses tool calls while the config is invalid', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: '{' })
  let ran = false
  on('tool.call', async () => {
    ran = true
    return bash({})
  })
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result).toEqual(WITHHELD)
  expect(ran).toBe(false)
})

test('keeps arguments masked when the engine forwards them to a model', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  const ran: any[] = []
  on('tool.call', async (_$: unknown, e: any) => {
    ran.push(e)
    return { result: { ok: true } }
  })
  await $.tool.call({ tool: 'WebSearch', query: `Contoso ${IP_PLACEHOLDER}` } as any)
  await $.tool.call({ tool: 'WebFetch', url: `http://${IP_PLACEHOLDER}/Contoso`, prompt: `summarize Contoso ${IP_PLACEHOLDER}` } as any)
  expect(ran[0].query).toBe(`Contoso ${IP_PLACEHOLDER}`)
  expect(ran[1].url).toBe('http://10.0.0.5/Acme Corp')
  expect(ran[1].prompt).toBe(`summarize Contoso ${IP_PLACEHOLDER}`)
})

test('passes tool calls through when no config exists', async ($, on) => {
  setupWorld(on, {})
  on('tool.call', async () => bash({ stdout: 'Acme Corp' }))
  const result: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result.result.stdout).toBe('Acme Corp')
})
