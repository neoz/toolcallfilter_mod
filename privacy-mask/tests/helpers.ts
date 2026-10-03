import { mock } from 'claude-code/testing'

export const SECRET = 'ab'.repeat(32)
export const GLOBAL_PATH = '/home/u/.claude/privacy-mask.json'
export const PROJECT_PATH = '/proj/.claude/privacy-mask.json'
export const REVERSE_KEY = 'privacy-mask:reverse:/proj'
export const CONFIG = JSON.stringify({
  terms: { 'Acme Corp': 'Contoso' },
  regex: [{ name: 'IP', pattern: '\\b\\d{1,3}(\\.\\d{1,3}){3}\\b' }],
})
// HMAC placeholder of 10.0.0.5 under SECRET; pinned so a change in masking output fails loudly.
export const IP_PLACEHOLDER = 'IP_d6da262530'

// Paths reach the mocks normalized to the platform (C:\home\u\... on Windows).
function posix(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
}

// Answers the mods API calls beneath the plugin: files, store, env, session root, command and toast.
// Returns the store's live data so a test can read what the plugin saved.
export function setupWorld(
  on: any,
  files: Record<string, string>,
  store: Record<string, unknown> = { 'privacy-mask:secret': SECRET },
  env: Record<string, string> = { HOME: '/home/u' },
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...store }
  mock.env(on, env)
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: data[e.key] }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => {
    data[e.key] = e.value
    return { value: undefined }
  })
  on('session.root', async () => ({ value: '/proj' }))
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: posix(e.path) in files }))
  on('fs.read', async (_$: unknown, e: { path: string }) =>
    posix(e.path) in files ? { value: files[posix(e.path)] } : { deny: 'ENOENT' },
  )
  on('command.register', async () => ({ value: { command: 'privacy-mask' } }))
  on('ui.toast', async () => ({ value: undefined }))
  return data
}
