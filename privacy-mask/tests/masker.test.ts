import { describe, expect, test } from 'claude-code/testing'
import { createMasker, mapBlockText } from '../hooks/masker.js'

const SECRET = 'ab'.repeat(32)
const CONFIG = {
  terms: { 'Acme Corp': 'Contoso', Acme: 'Fabrikam', khiemnnm: 'user1' },
  regex: [
    { name: 'EMAIL', pattern: '[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+', flags: '' },
    { name: 'IP', pattern: '\\b\\d{1,3}(\\.\\d{1,3}){3}\\b', flags: '' },
    { name: 'ORG', pattern: 'Contoso', flags: '' },
  ],
}
const ORIGINAL = 'Acme Corp and Acme at 10.0.0.5, mail khiemnnm@acme.io, again 10.0.0.5 by khiemnnm'
// Pinned output: a change here changes every masked request and breaks the prompt cache.
const MASKED = 'ORG_5748448089 and Fabrikam at IP_d6da262530, mail EMAIL_f57558cb9d, again IP_d6da262530 by user1'

describe('mask and unmask', () => {
  test('masks terms first, then regex rules in order, with pinned HMAC placeholders', async () => {
    expect(createMasker(CONFIG, SECRET, {}).mask(ORIGINAL)).toBe(MASKED)
  })

  test('round-trips, including a regex that matched a term replacement', async () => {
    const masker = createMasker(CONFIG, SECRET, {})
    expect(masker.unmask(masker.mask(ORIGINAL))).toBe(ORIGINAL)
  })

  test('is idempotent', async () => {
    const masker = createMasker(CONFIG, SECRET, {})
    expect(masker.mask(MASKED)).toBe(MASKED)
  })

  test('does not re-mask issued placeholders even when a rule matches their shape', async () => {
    const broad = { terms: {}, regex: [{ name: 'IP', pattern: '\\b\\d{1,3}(\\.\\d{1,3}){3}\\b', flags: '' }, { name: 'WORD', pattern: '[A-Z]+_\\w+', flags: '' }] }
    const masker = createMasker(broad, SECRET, {})
    const once = masker.mask('host 10.0.0.5')
    expect(once).toBe('host IP_d6da262530')
    expect(masker.mask(once)).toBe(once)
  })

  test('keeps issued placeholders intact when a term occurs inside them', async () => {
    const config = { terms: { '2625': 'ACCT' }, regex: [CONFIG.regex[1]] }
    const masker = createMasker(config, SECRET, {})
    const once = masker.mask('host 10.0.0.5')
    expect(once).toBe('host IP_d6da262530')
    expect(masker.mask(once)).toBe(once)
    expect(masker.unmask(masker.mask(once))).toBe('host 10.0.0.5')
  })

  test('restores placeholders that touch word characters', async () => {
    const masker = createMasker({ terms: {}, regex: [{ name: 'EMP', pattern: 'E\\d{5}', flags: '' }] }, SECRET, {})
    const original = 'user_E12345 and E12345abc and E12345_old'
    const masked = masker.mask(original)
    expect(masked).not.toContain('E12345')
    expect(masker.mask(masked)).toBe(masked)
    expect(masker.unmask(masked)).toBe(original)
  })

  test('is deterministic across maskers without a shared reverse table', async () => {
    expect(createMasker(CONFIG, SECRET, {}).mask(ORIGINAL)).toBe(createMasker(CONFIG, SECRET, {}).mask(ORIGINAL))
  })

  test('lets the longest term win', async () => {
    const masker = createMasker({ terms: { 'Acme Corp': 'Contoso', Acme: 'Fabrikam' }, regex: [] }, SECRET, {})
    expect(masker.mask('Acme Corp, Acme')).toBe('Contoso, Fabrikam')
  })

  test('honours rule flags', async () => {
    const masker = createMasker({ terms: {}, regex: [{ name: 'HOST', pattern: 'acme\\.io', flags: 'i' }] }, SECRET, {})
    const masked = masker.mask('ACME.IO')
    expect(masked).toMatch(/^HOST_[0-9a-f]{10}$/)
    expect(masker.unmask(masked)).toBe('ACME.IO')
  })

  test('ignores empty matches', async () => {
    const masker = createMasker({ terms: {}, regex: [{ name: 'Z', pattern: 'x*', flags: '' }] }, SECRET, {})
    expect(masker.mask('abxc')).toBe('abZ_eb65600698c')
  })

  test('leaves unknown placeholders alone', async () => {
    expect(createMasker(CONFIG, SECRET, {}).unmask('IP_0000000000')).toBe('IP_0000000000')
  })

  test('throws on a placeholder collision', async () => {
    const masker = createMasker(CONFIG, SECRET, { IP_d6da262530: '1.1.1.1' })
    expect(() => masker.mask('10.0.0.5')).toThrow('placeholder collision on IP_d6da262530')
  })

  test('records issued placeholders and reports growth once', async () => {
    const reverse: Record<string, string> = {}
    const masker = createMasker(CONFIG, SECRET, reverse)
    masker.mask('10.0.0.5')
    expect(reverse).toEqual({ IP_d6da262530: '10.0.0.5' })
    expect(masker.takeAdded()).toBe(true)
    expect(masker.takeAdded()).toBe(false)
    masker.mask('10.0.0.5')
    expect(masker.takeAdded()).toBe(false)
  })

  test('masks a 1 MB text with 20,000 unique IPs quickly', async () => {
    const masker = createMasker({ terms: { 'Acme Corp': 'Contoso' }, regex: [CONFIG.regex[1]] }, SECRET, {})
    const lines: string[] = []
    for (let i = 0; i < 20000; i++) lines.push(`host ${i} Acme Corp at 10.${(i >> 8) & 255}.${i & 255}.${i % 7} padding text`)
    const text = lines.join('\n')
    const started = Date.now()
    const masked = masker.mask(text)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(masker.unmask(masked)).toBe(text)
  })
})

describe('deepMask and deepUnmask', () => {
  test('map every string in nested objects and arrays and keep other leaves', async () => {
    const masker = createMasker(CONFIG, SECRET, {})
    const value = { a: ['10.0.0.5', 3, null, true], b: { c: 'Acme' } }
    const masked = masker.deepMask(value)
    expect(masked).toEqual({ a: ['IP_d6da262530', 3, null, true], b: { c: 'Fabrikam' } })
    expect(masker.deepUnmask(masked)).toEqual(value)
  })

  test('leave base64 payloads of images and documents untouched', async () => {
    const masker = createMasker(CONFIG, SECRET, {})
    const readImage = { type: 'image', file: { base64: 'xxAcmexx', type: 'image/png', originalSize: 8 } }
    expect(masker.deepMask(readImage)).toEqual(readImage)
    const readPdf = { type: 'pdf', file: { filePath: '/docs/Acme.pdf', base64: 'Acme', originalSize: 4 } }
    expect(masker.deepMask(readPdf)).toEqual({ type: 'pdf', file: { filePath: '/docs/Fabrikam.pdf', base64: 'Acme', originalSize: 4 } })
    const apiBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Acme' } }
    expect(masker.deepMask(apiBlock)).toEqual(apiBlock)
    const mcpBlock = { type: 'image', data: 'Acme', mimeType: 'image/png' }
    expect(masker.deepMask(mcpBlock)).toEqual(mcpBlock)
    expect(masker.deepMask({ type: 'text', data: 'Acme' })).toEqual({ type: 'text', data: 'Fabrikam' })
  })
})

describe('mapBlockText', () => {
  const upper = (text: string) => text.toUpperCase()

  test('maps text blocks and tool_result content', async () => {
    expect(mapBlockText({ type: 'text', text: 'a' }, upper)).toEqual({ type: 'text', text: 'A' })
    expect(mapBlockText({ type: 'tool_result', tool_use_id: 't', content: 'b' }, upper)).toEqual({
      type: 'tool_result',
      tool_use_id: 't',
      content: 'B',
    })
    expect(
      mapBlockText({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'c' }, { type: 'image' }] }, upper),
    ).toEqual({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'C' }, { type: 'image' }] })
  })

  test('leaves other blocks unchanged', async () => {
    const toolUse = { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'x' } }
    expect(mapBlockText(toolUse, upper)).toBe(toolUse)
    const thinking = { type: 'thinking', thinking: 'x', signature: 's' }
    expect(mapBlockText(thinking, upper)).toBe(thinking)
  })
})
