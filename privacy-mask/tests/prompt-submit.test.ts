import { expect, test } from 'claude-code/testing'
import { CONFIG, GLOBAL_PATH, IP_PLACEHOLDER, PROJECT_PATH, REVERSE_KEY, setupWorld } from './helpers.ts'

function captureSubmit(on: any): { seen: any } {
  const box: { seen: any } = { seen: undefined }
  on('prompt.submit', async (_$: unknown, e: any) => {
    box.seen = e
    return { text: e.text, context: e.context }
  })
  return box
}

const submit = ($: any, text: string, context?: string[]) =>
  $.prompt.submit({ text, context, wait: false, origin: { kind: 'user' } } as any)

test('masks the prompt text and context and saves the reverse table', async ($, on) => {
  const store = setupWorld(on, { [GLOBAL_PATH]: CONFIG })
  const box = captureSubmit(on)
  await submit($, 'Acme Corp at 10.0.0.5', ['ping 10.0.0.5'])
  expect(box.seen.text).toBe(`Contoso at ${IP_PLACEHOLDER}`)
  expect(box.seen.context).toEqual([`ping ${IP_PLACEHOLDER}`])
  expect(store[REVERSE_KEY]).toEqual({ [IP_PLACEHOLDER]: '10.0.0.5' })
})

test('keeps reverse entries another session saved', async ($, on) => {
  const store = setupWorld(on, { [GLOBAL_PATH]: CONFIG }, {
    'privacy-mask:secret': 'ab'.repeat(32),
    [REVERSE_KEY]: { IP_0123456789: '192.168.0.1' },
  })
  captureSubmit(on)
  await submit($, '10.0.0.5')
  expect(store[REVERSE_KEY]).toEqual({ IP_0123456789: '192.168.0.1', [IP_PLACEHOLDER]: '10.0.0.5' })
})

test('lets the project config override the global one', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG, [PROJECT_PATH]: '{"terms":{"Acme Corp":"Fabrikam"}}' })
  const box = captureSubmit(on)
  await submit($, 'Acme Corp')
  expect(box.seen.text).toBe('Fabrikam')
})

test('finds the global config through USERPROFILE when HOME is unset', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, undefined, { USERPROFILE: '/home/u' })
  const box = captureSubmit(on)
  await submit($, 'Acme Corp')
  expect(box.seen.text).toBe('Contoso')
})

test('prefers USERPROFILE over HOME for the global config', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, undefined, { HOME: '/msys/home/u', USERPROFILE: '/home/u' })
  const box = captureSubmit(on)
  await submit($, 'Acme Corp')
  expect(box.seen.text).toBe('Contoso')
})

test('still sends the masked prompt when the reverse table cannot be saved', async ($, on) => {
  // Registered before setupWorld so it answers first for the reverse table key.
  on('store.set', { key: REVERSE_KEY }, async () => ({ deny: 'the store is over 4 MiB' }))
  setupWorld(on, { [GLOBAL_PATH]: CONFIG })
  const box = captureSubmit(on)
  const result: any = await submit($, 'Acme Corp at 10.0.0.5')
  expect(result.drop).toBeUndefined()
  expect(box.seen.text).toBe(`Contoso at ${IP_PLACEHOLDER}`)
})

test('passes prompts through when no config exists', async ($, on) => {
  setupWorld(on, {})
  const box = captureSubmit(on)
  await submit($, 'Acme Corp')
  expect(box.seen.text).toBe('Acme Corp')
})

test('drops prompts while the config is invalid', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: '{' })
  const box = captureSubmit(on)
  const result = await submit($, 'Acme Corp')
  expect(result).toEqual({ drop: expect.stringContaining(`${GLOBAL_PATH}: invalid JSON`) })
  expect(box.seen).toBeUndefined()
})

test('creates and saves a secret on first use', async ($, on) => {
  const store = setupWorld(on, { [GLOBAL_PATH]: CONFIG }, {})
  captureSubmit(on)
  await submit($, '10.0.0.5')
  expect(String(store['privacy-mask:secret'])).toMatch(/^[0-9a-f]{64}$/)
})

test('registers /privacy-mask at session start', async ($, on) => {
  let registered: any
  // Registered before setupWorld, which answers command.register too: hooks beneath the plugin run
  // in registration order, and a second registration of one event needs a matcher.
  on('command.register', { name: 'privacy-mask' }, async (_$: unknown, e: any) => {
    registered = e
    return { value: { command: e.name } }
  })
  setupWorld(on, { [GLOBAL_PATH]: CONFIG })
  on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(registered.name).toBe('privacy-mask')
})

test('/privacy-mask reports the active state', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, { 'privacy-mask:secret': 'ab'.repeat(32), [REVERSE_KEY]: { IP_0123456789: '1.1.1.1' } })
  const result = await $.command.run({ command: 'privacy-mask', args: '' })
  expect(result.text).toBe('mode: active\nconfig files: global\nterms: 1\nregex rules: 1\nreverse table entries: 1')
})

test('/privacy-mask reports a blocked config', async ($, on) => {
  setupWorld(on, { [PROJECT_PATH]: '{"terms":{"a":"X","b":"X"}}' })
  const result = await $.command.run({ command: 'privacy-mask', args: '' })
  expect(result.text).toBe('mode: blocked\nconfig files: project\nerror: terms "a" and "b" share the replacement "X"')
})
