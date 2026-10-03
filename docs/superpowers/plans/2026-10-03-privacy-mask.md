# privacy-mask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `privacy-mask` Claude Code mod: it masks configured terms and regex matches in everything the model reads, and restores the originals in what the user sees and in what local tools execute.

**Architecture:** A plugin with one hooks module (`hooks/register.js`) that wires mods API hooks, plus three pure modules: `hmac.js` (SHA-256/HMAC in plain JS), `config.js` (parse/merge/validate), and `masker.js` (deterministic mask/unmask). Outbound text is masked at `prompt.submit`, `tool.call` results, system prompt events, and `session.append`; inbound text is unmasked at `tool.call` arguments and `ui.render`.

**Tech Stack:** Claude Code v2.1.288 mods API (ES module hooks, `claude plugin test` with `claude-code/testing`, `claude plugin validate`). No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-03-privacy-mask-design.md`

## Global Constraints

- Claude Code v2.1.288 or later; the plugin directory is `privacy-mask/` at the repository root and its `name` is `privacy-mask`.
- Hooks modules are ES modules; they import only files inside the plugin by relative path (and types from `claude-code`). No `node:*` imports, no `require`, no dynamic `import()`.
- `$` is only passed to functions declared at the top level of `register.js`; never assign `$` or a namespace of it to a variable. Every `on(...)` event name is a string literal. `$.env.get` takes literal names.
- `crypto.subtle` is unusable in the mods runtime; HMAC uses `hooks/hmac.js`. `crypto.getRandomValues` and `TextEncoder` are available.
- Masking must be deterministic and idempotent (`mask(mask(x)) === mask(x)`) so request prefixes stay byte-identical for the prompt cache. The mod never adds dynamic text to anything the model reads.
- Every masking hook fails closed (see spec "Error handling"). Render hooks never touch the model side.
- Everything in the repository is written in English; no emojis in code or strings.
- `claude plugin test` resets module state between tests; `fs` paths reach mocks normalized to the platform (for example `C:\home\u\...`), so mocks compare paths in POSIX form without the drive letter.
- The test harness cannot host a `session.append` chain (nothing beneath the plugins answers it); its logic is unit-tested through `mapBlockText` and verified in the smoke test.
- On this Windows machine, Git Bash heredocs strip backslashes: create files with the editor's Write tool, not with `cat <<EOF`.

## Review Focus

- A `prompt.context` rewrite that keeps `instructionFiles` could let the engine re-render `CLAUDE.md` from unmasked files: the hook must return `{ blocks }` only (test in Task 6) and the smoke test checks that a CLAUDE.md term reaches the model masked (Task 8).
- A huge tool result (a 1 MB file with thousands of unique IPs) must mask well under the 10-second hook limit: performance test in Task 3.
- A regex rule broad enough to match issued placeholders (for example `[A-Z]+_\w+`) must not re-mask them: idempotency test in Task 3.
- On Windows the process may have `USERPROFILE` but no `HOME`: the global config must still load (test in Task 4).
- When masking fails after a tool already ran, the model must get a denial, not the raw output: test in Task 5.

---

### Task 1: Plugin scaffold and HMAC module

**Files:**
- Create: `privacy-mask/.claude-plugin/plugin.json`
- Create: `privacy-mask/hooks/hooks.json`
- Create: `privacy-mask/hooks/register.js`
- Create: `privacy-mask/hooks/hmac.js`
- Create: `privacy-mask/tests/hmac.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces (`hooks/hmac.js`): `sha256(bytes: Uint8Array): Uint8Array`, `hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array`, `toHex(bytes: Uint8Array): string`, `fromHex(hex: string): Uint8Array`, `utf8(text: string): Uint8Array`

- [ ] **Step 1: Create the manifest, hooks.json, an empty hooks module, and .gitignore**

`privacy-mask/.claude-plugin/plugin.json`:

```json
{
  "name": "privacy-mask",
  "version": "0.1.0",
  "description": "Masks configured terms and regex matches in everything the model reads and restores them in what you see and what tools run"
}
```

`privacy-mask/hooks/hooks.json`:

```json
{
  "description": "The privacy-mask hooks module",
  "modules": ["./register.js"]
}
```

`privacy-mask/hooks/register.js` (filled in from Task 4):

```javascript
export function register(on) {}
```

`.gitignore` (Claude Code writes these into a mod loaded with `--plugin-dir`):

```
privacy-mask/.claude-plugin/types/
privacy-mask/tsconfig.json
```

- [ ] **Step 2: Write the failing HMAC tests**

`privacy-mask/tests/hmac.test.ts`:

```typescript
import { describe, expect, test } from 'claude-code/testing'
import { fromHex, hmacSha256, sha256, toHex, utf8 } from '../hooks/hmac.js'

describe('sha256', () => {
  test('matches the FIPS 180-4 test vectors', async () => {
    expect(toHex(sha256(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(toHex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(toHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })
})

describe('hmacSha256', () => {
  test('matches the RFC 4231 and common test vectors', async () => {
    expect(toHex(hmacSha256(utf8('key'), utf8('The quick brown fox jumps over the lazy dog')))).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
    expect(toHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
    const longKey = new Uint8Array(131).fill(0xaa)
    expect(toHex(hmacSha256(longKey, utf8('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    )
  })
})

test('fromHex reverses toHex', async () => {
  expect(toHex(fromHex('00ff10ab'))).toBe('00ff10ab')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `privacy-mask/`): `claude plugin test`
Expected: FAIL, the module `../hooks/hmac.js` cannot be found.

- [ ] **Step 4: Implement `hooks/hmac.js`**

`privacy-mask/hooks/hmac.js`:

```javascript
// SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104) in plain JS: the mods runtime cannot
// import node:crypto, and its crypto.subtle is unusable.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n))
}

export function sha256(bytes) {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const data = new Uint8Array(paddedLength)
  data.set(bytes)
  data[bytes.length] = 0x80
  const view = new DataView(data.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  h.forEach((value, i) => outView.setUint32(i * 4, value))
  return out
}

export function hmacSha256(key, message) {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? sha256(key) : key)
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36
    outer[i] = block[i] ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export function utf8(text) {
  return new TextEncoder().encode(text)
}
```

- [ ] **Step 5: Run the tests and the validator**

Run (from `privacy-mask/`): `claude plugin test`
Expected: PASS, 3 tests.

Run (from the repository root): `claude plugin validate ./privacy-mask`
Expected: `Validation passed`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore privacy-mask
git commit -m "feat: scaffold privacy-mask plugin with plain-JS HMAC-SHA256"
```

---

### Task 2: Config parsing, merging and validation

**Files:**
- Create: `privacy-mask/hooks/config.js`
- Test: `privacy-mask/tests/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (`hooks/config.js`):
  - `parseConfig(text: string, label: string): Config` where `Config = { terms: Record<string, string>, regex: Array<{ name: string, pattern: string, flags: string }> }`; throws `Error` whose message starts with `label`
  - `mergeConfigs(globalConfig: Config | undefined, projectConfig: Config | undefined): Config`
  - `validateConfig(config: Config): void`; throws `Error` on ambiguous or non-idempotent terms

- [ ] **Step 1: Write the failing tests**

`privacy-mask/tests/config.test.ts`:

```typescript
import { describe, expect, test } from 'claude-code/testing'
import { mergeConfigs, parseConfig, validateConfig } from '../hooks/config.js'

function errorOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  return 'no error'
}

describe('parseConfig', () => {
  test('reads terms and regex rules, defaulting flags to empty', async () => {
    const config = parseConfig('{"terms":{"Acme":"Contoso"},"regex":[{"name":"IP","pattern":"x"}]}', 'g.json')
    expect(config).toEqual({ terms: { Acme: 'Contoso' }, regex: [{ name: 'IP', pattern: 'x', flags: '' }] })
  })

  test('treats missing sections as empty', async () => {
    expect(parseConfig('{}', 'g.json')).toEqual({ terms: {}, regex: [] })
  })

  test('rejects invalid input with the file label in the message', async () => {
    expect(errorOf(() => parseConfig('{', 'g.json'))).toStartWith('g.json: invalid JSON')
    expect(errorOf(() => parseConfig('[]', 'g.json'))).toBe('g.json: the config must be a JSON object')
    expect(errorOf(() => parseConfig('{"terms":[]}', 'g.json'))).toBe('g.json: "terms" must be an object')
    expect(errorOf(() => parseConfig('{"terms":{"a":""}}', 'g.json'))).toBe(
      'g.json: term "a" must map a non-empty string to a non-empty string',
    )
    expect(errorOf(() => parseConfig('{"regex":{}}', 'g.json'))).toBe('g.json: "regex" must be an array')
    expect(errorOf(() => parseConfig('{"regex":[{"name":"ip","pattern":"x"}]}', 'g.json'))).toStartWith(
      'g.json: regex rule 0 needs a "name" matching',
    )
    expect(errorOf(() => parseConfig('{"regex":[{"name":"IP","pattern":""}]}', 'g.json'))).toBe(
      'g.json: regex rule "IP" needs a non-empty "pattern"',
    )
    expect(errorOf(() => parseConfig('{"regex":[{"name":"IP","pattern":"("}]}', 'g.json'))).toStartWith(
      'g.json: regex rule "IP": ',
    )
    expect(errorOf(() => parseConfig('{"regex":[{"name":"IP","pattern":"x","flags":"q"}]}', 'g.json'))).toStartWith(
      'g.json: regex rule "IP": ',
    )
    expect(errorOf(() => parseConfig('{"regex":[{"name":"IP","pattern":"x"},{"name":"IP","pattern":"y"}]}', 'g.json'))).toBe(
      'g.json: regex rule "IP" is declared twice',
    )
  })
})

describe('mergeConfigs', () => {
  test('lets the project win and appends project-only rules after global ones', async () => {
    const globalConfig = parseConfig(
      '{"terms":{"Acme":"Contoso","me":"user1"},"regex":[{"name":"A","pattern":"a"},{"name":"B","pattern":"b"}]}',
      'g',
    )
    const projectConfig = parseConfig(
      '{"terms":{"Acme":"Fabrikam"},"regex":[{"name":"C","pattern":"c"},{"name":"A","pattern":"aa","flags":"i"}]}',
      'p',
    )
    expect(mergeConfigs(globalConfig, projectConfig)).toEqual({
      terms: { Acme: 'Fabrikam', me: 'user1' },
      regex: [
        { name: 'A', pattern: 'aa', flags: 'i' },
        { name: 'B', pattern: 'b', flags: '' },
        { name: 'C', pattern: 'c', flags: '' },
      ],
    })
  })

  test('accepts a missing side', async () => {
    const only = parseConfig('{"terms":{"Acme":"Contoso"}}', 'p')
    expect(mergeConfigs(undefined, only)).toEqual(only)
    expect(mergeConfigs(only, undefined)).toEqual(only)
  })
})

describe('validateConfig', () => {
  test('rejects two terms with the same replacement', async () => {
    expect(errorOf(() => validateConfig({ terms: { a: 'X', b: 'X' }, regex: [] }))).toBe(
      'terms "a" and "b" share the replacement "X"',
    )
  })

  test('rejects a replacement that contains a term original', async () => {
    expect(errorOf(() => validateConfig({ terms: { Acme: 'Acme Inc' }, regex: [] }))).toBe(
      'replacement "Acme Inc" contains the term "Acme"',
    )
    expect(errorOf(() => validateConfig({ terms: { Acme: 'Contoso', Bob: 'xBobx' }, regex: [] }))).toBe(
      'replacement "xBobx" contains the term "Bob"',
    )
  })

  test('accepts a sound config', async () => {
    expect(errorOf(() => validateConfig({ terms: { Acme: 'Contoso', me: 'user1' }, regex: [] }))).toBe('no error')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `privacy-mask/`): `claude plugin test`
Expected: FAIL, `../hooks/config.js` cannot be found.

- [ ] **Step 3: Implement `hooks/config.js`**

`privacy-mask/hooks/config.js`:

```javascript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `privacy-mask/`): `claude plugin test`
Expected: PASS (all hmac and config tests).

- [ ] **Step 5: Commit**

```bash
git add privacy-mask/hooks/config.js privacy-mask/tests/config.test.ts
git commit -m "feat: parse, merge and validate privacy-mask configs"
```

---

### Task 3: Deterministic masker

**Files:**
- Create: `privacy-mask/hooks/masker.js`
- Test: `privacy-mask/tests/masker.test.ts`

**Interfaces:**
- Consumes: `hmacSha256`, `toHex`, `fromHex`, `utf8` from `hooks/hmac.js`; `Config` shape from Task 2
- Produces (`hooks/masker.js`):
  - `createMasker(config: Config, secretHex: string, reverse: Record<string, string>): Masker` where `Masker = { mask(text: string): string, unmask(text: string): string, deepMask<T>(value: T): T, deepUnmask<T>(value: T): T, takeAdded(): boolean }`. `reverse` is mutated as placeholders are issued. `mask` throws `Error('placeholder collision on <id>')` on an HMAC collision.
  - `mapBlockText(block: { type: string, ... }, fn: (text: string) => string): block` for API content blocks (`text`, `tool_result`)

- [ ] **Step 1: Write the failing tests**

`privacy-mask/tests/masker.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `privacy-mask/`): `claude plugin test`
Expected: FAIL, `../hooks/masker.js` cannot be found.

- [ ] **Step 3: Implement `hooks/masker.js`**

`privacy-mask/hooks/masker.js`:

```javascript
import { fromHex, hmacSha256, toHex, utf8 } from './hmac.js'

// Any placeholder this mod can issue; text in this form is never masked again.
const ANY_PLACEHOLDER = /\b[A-Z][A-Z0-9_]*_[0-9a-f]{10}\b/g

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One regex matching any of the strings, longest first so a longer term wins over its prefix.
function alternation(strings) {
  if (strings.length === 0) return null
  const sorted = [...strings].sort((a, b) => b.length - a.length)
  return new RegExp(sorted.map(escapeRegex).join('|'), 'g')
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]))
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
    token: new RegExp(`\\b${rule.name}_[0-9a-f]{10}\\b`, 'g'),
  }))
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

  function maskRule(text, rule) {
    const replace = (part) => part.replace(rule.pattern, (match) => (match === '' ? match : placeholder(rule.name, match)))
    let out = ''
    let last = 0
    for (const token of text.matchAll(ANY_PLACEHOLDER)) {
      out += replace(text.slice(last, token.index)) + token[0]
      last = token.index + token[0].length
    }
    return out + replace(text.slice(last))
  }

  function mask(text) {
    let out = termOriginals === null ? text : text.replace(termOriginals, (original) => terms[original])
    for (const rule of rules) out = maskRule(out, rule)
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `privacy-mask/`): `claude plugin test`
Expected: PASS (all hmac, config and masker tests).

- [ ] **Step 5: Commit**

```bash
git add privacy-mask/hooks/masker.js privacy-mask/tests/masker.test.ts
git commit -m "feat: deterministic HMAC masker with idempotent mask and unmask"
```

---

### Task 4: Session state, status command and prompt masking

**Files:**
- Modify: `privacy-mask/hooks/register.js` (replace the stub)
- Create: `privacy-mask/tests/helpers.ts`
- Test: `privacy-mask/tests/prompt-submit.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `mergeConfigs`, `validateConfig` (Task 2); `createMasker` (Task 3); `toHex` (Task 1)
- Produces (top-level helpers in `register.js`, used by Tasks 5-7):
  - `state($): Promise<State>` where `State` is `{ mode: 'pass-through', loaded: string[] }`, `{ mode: 'blocked', loaded: string[], error: string }`, or `{ mode: 'active', loaded: string[], config: Config, reverseKey: string, reverse: Record<string, string>, masker: Masker }`
  - `activeState($): Promise<ActiveState | null>`: `null` in pass-through, throws `Error(error)` in blocked mode
  - `persist($, s: ActiveState): Promise<void>`
- Produces (`tests/helpers.ts`, used by Tasks 5-7): `SECRET`, `CONFIG`, `GLOBAL_PATH`, `PROJECT_PATH`, `REVERSE_KEY`, `IP_PLACEHOLDER`, `setupWorld(on, files, store?) => Record<string, unknown>` (returns the live store data)

- [ ] **Step 1: Write the test helpers**

`privacy-mask/tests/helpers.ts`:

```typescript
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
```

- [ ] **Step 2: Write the failing tests**

`privacy-mask/tests/prompt-submit.test.ts`:

```typescript
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
  // Registered before setupWorld: hooks beneath the plugin run in registration order, and the
  // first one to answer without next ends the chain.
  on('command.register', async (_$: unknown, e: any) => {
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `privacy-mask/`): `claude plugin test`
Expected: FAIL in `prompt-submit.test.ts` (prompts pass through unmasked; `/privacy-mask` has no implementation).

- [ ] **Step 4: Implement state, the command, and `prompt.submit` in `register.js`**

Replace `privacy-mask/hooks/register.js` with:

```javascript
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
```

- [ ] **Step 5: Run the tests and the validator**

Run (from `privacy-mask/`): `claude plugin test`
Expected: PASS (all tests so far).

Run (from the repository root): `claude plugin validate ./privacy-mask`
Expected: `Validation passed`; the `hooks:` line lists `session.start, command.run{command=privacy-mask}, prompt.submit`.

- [ ] **Step 6: Commit**

```bash
git add privacy-mask/hooks/register.js privacy-mask/tests/helpers.ts privacy-mask/tests/prompt-submit.test.ts
git commit -m "feat: load privacy-mask state, add /privacy-mask, mask submitted prompts"
```

---

### Task 5: Tool calls: unmask arguments, mask results

**Files:**
- Modify: `privacy-mask/hooks/register.js` (add a constant, a helper, and one hook inside `register`)
- Test: `privacy-mask/tests/tool-call.test.ts`

**Interfaces:**
- Consumes: `activeState($)`, `persist($, s)` (Task 4); `Masker` (Task 3); test helpers (Task 4)
- Produces: the `tool.call` hook; no new exports

- [ ] **Step 1: Write the failing tests**

`privacy-mask/tests/tool-call.test.ts`:

```typescript
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

test('masks the context a tool result carries', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  on('tool.call', async () => ({ ...bash({}), context: ['note about Acme Corp'] }))
  const result: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result.context).toEqual(['note about Contoso'])
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

test('passes tool calls through when no config exists', async ($, on) => {
  setupWorld(on, {})
  on('tool.call', async () => bash({ stdout: 'Acme Corp' }))
  const result: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result.result.stdout).toBe('Acme Corp')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `privacy-mask/`): `claude plugin test`
Expected: FAIL in `tool-call.test.ts` (arguments reach the tool masked; results come back unmasked with `ref`).

- [ ] **Step 3: Add the hook to `register.js`**

Add below the `CONFIG_FILE` constant:

```javascript
const RESERVED_TOOL_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])
```

Add below `persist`:

```javascript
// The tool's own arguments of a tool.call event, without the engine's reserved keys.
function toolArguments(e) {
  return Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED_TOOL_KEYS.has(key)))
}
```

Add inside `register`, after the `prompt.submit` hook:

```javascript
  on('tool.call', async ($, e, next) => {
    const s = await activeState($)
    if (s === null) return next(e)
    const result = await next({ ...e, ...s.masker.deepUnmask(toolArguments(e)) })
    let masked
    if (result.deny !== undefined) {
      masked = { deny: s.masker.mask(result.deny) }
    } else if (result.isError) {
      masked = { deny: s.masker.mask(result.text ?? 'The tool failed.') }
    } else {
      // A fresh object without core's ref and text: returning core's own object would make core
      // send its unmasked messages verbatim.
      masked = { result: s.masker.deepMask(result.result) }
      if (result.context !== undefined) masked.context = result.context.map((text) => s.masker.mask(text))
    }
    await persist($, s)
    return masked
  }).catch(async () => ({ deny: 'privacy-mask: the tool result was withheld because masking failed.' }))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `privacy-mask/`): `claude plugin test`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add privacy-mask/hooks/register.js privacy-mask/tests/tool-call.test.ts
git commit -m "feat: unmask tool arguments and mask tool results"
```

---

### Task 6: System prompt, context, attachments, skills, tool descriptions and stored rows

**Files:**
- Modify: `privacy-mask/hooks/register.js` (add an import, a constant, and six hooks inside `register`)
- Test: `privacy-mask/tests/model-input.test.ts`

**Interfaces:**
- Consumes: `activeState($)`, `persist($, s)` (Task 4); `mapBlockText` (Task 3); test helpers (Task 4)
- Produces: hooks on `prompt.section`, `prompt.context`, `prompt.attachment`, `skill.prompt`, `tool.describe`, `session.append`

The test harness cannot host a `session.append` chain (nothing beneath the plugins answers it, and a bottom hook that answers without `next` is skipped), so `session.append` is covered by the `mapBlockText` unit tests from Task 3 and by the smoke test in Task 8.

- [ ] **Step 1: Write the failing tests**

`privacy-mask/tests/model-input.test.ts`:

```typescript
import { describe, expect, test } from 'claude-code/testing'
import { CONFIG, GLOBAL_PATH, IP_PLACEHOLDER, setupWorld } from './helpers.ts'

function answerBeneath(on: any) {
  on('prompt.section', async (_$: unknown, e: any) => ({ text: e.text }))
  on('prompt.context', async (_$: unknown, e: any) => ({
    blocks: e.blocks,
    instructionFiles: [{ path: '/proj/CLAUDE.md', kind: 'project', content: 'Acme Corp rules' }],
  }))
  on('prompt.attachment', async (_$: unknown, e: any) => ({ text: e.text }))
  on('skill.prompt', async (_$: unknown, e: any) => ({ text: e.text }))
  on('tool.describe', async (_$: unknown, e: any) => ({ description: e.description }))
}

const ENGINE = { plugin: 'engine', tier: 'core' }

describe('with a valid config', () => {
  test('masks each system prompt section and keeps omitted ones omitted', async ($, on) => {
    setupWorld(on, { [GLOBAL_PATH]: CONFIG })
    answerBeneath(on)
    expect(await $.prompt.section({ name: 'env_info_simple', text: 'host 10.0.0.5' })).toEqual({ text: `host ${IP_PLACEHOLDER}` })
    expect(await $.prompt.section({ name: 'memory', text: null })).toEqual({ text: null })
  })

  test('masks context blocks and drops instructionFiles', async ($, on) => {
    setupWorld(on, { [GLOBAL_PATH]: CONFIG })
    answerBeneath(on)
    const result = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'Acme Corp rules' }] })
    expect(result).toEqual({ blocks: [{ name: 'claudeMd', text: 'Contoso rules' }] })
  })

  test('masks attachments, skill prompts and tool descriptions', async ($, on) => {
    setupWorld(on, { [GLOBAL_PATH]: CONFIG })
    answerBeneath(on)
    expect(await $.prompt.attachment({ type: 'file', text: 'Acme Corp', origin: { kind: 'engine' } } as any)).toEqual({
      text: 'Contoso',
    })
    expect(await $.skill.prompt({ skill: 'deploy', text: 'ssh 10.0.0.5' })).toEqual({ text: `ssh ${IP_PLACEHOLDER}` })
    expect(
      await $.tool.describe({ tool: 'mcp__acme__ping', description: 'Pings Acme Corp hosts', provider: ENGINE } as any),
    ).toEqual({ description: 'Pings Contoso hosts' })
  })
})

describe('with an invalid config', () => {
  test('omits or empties everything the model would read', async ($, on) => {
    setupWorld(on, { [GLOBAL_PATH]: '{' })
    answerBeneath(on)
    expect(await $.prompt.section({ name: 'env_info_simple', text: 'host 10.0.0.5' })).toEqual({ text: null })
    expect(await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'Acme Corp' }] })).toEqual({ blocks: [] })
    expect(await $.prompt.attachment({ type: 'file', text: 'Acme Corp', origin: { kind: 'engine' } } as any)).toEqual({
      text: null,
    })
    expect(await $.skill.prompt({ skill: 'deploy', text: 'Acme Corp' })).toEqual({ text: '' })
    expect(
      await $.tool.describe({ tool: 'mcp__acme__ping', description: 'Acme Corp', provider: ENGINE } as any),
    ).toEqual({ description: '' })
  })
})

describe('without a config', () => {
  test('passes everything through', async ($, on) => {
    setupWorld(on, {})
    answerBeneath(on)
    expect(await $.prompt.section({ name: 'env_info_simple', text: '10.0.0.5' })).toEqual({ text: '10.0.0.5' })
    expect(await $.skill.prompt({ skill: 'deploy', text: 'Acme Corp' })).toEqual({ text: 'Acme Corp' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `privacy-mask/`): `claude plugin test`
Expected: FAIL in `model-input.test.ts` (text reaches the bottom unmasked).

- [ ] **Step 3: Add the hooks to `register.js`**

Change the masker import to:

```javascript
import { createMasker, mapBlockText } from './masker.js'
```

Add below `RESERVED_TOOL_KEYS`:

```javascript
const WITHHELD = '[privacy-mask: content withheld]'
```

Add inside `register`, after the `tool.call` hook:

```javascript
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
    const content = e.message.content.map((block) => mapBlockText(block, (text) => s.masker.mask(text)))
    await persist($, s)
    return next({ ...e, message: { ...e.message, content } })
  }).catch(async ($, e, next) => {
    // A hook may not refuse an engine row, so the row is kept with its text withheld.
    if (e.message.role === undefined) return next(e)
    const content = e.message.content.map((block) => mapBlockText(block, () => WITHHELD))
    return next({ ...e, message: { ...e.message, content } })
  })
```

- [ ] **Step 4: Run the tests and the validator**

Run (from `privacy-mask/`): `claude plugin test`
Expected: PASS (all tests so far).

Run (from the repository root): `claude plugin validate ./privacy-mask`
Expected: `Validation passed`; the `hooks:` line now also lists `prompt.section, prompt.context, prompt.attachment, skill.prompt, tool.describe, session.append`.

- [ ] **Step 5: Commit**

```bash
git add privacy-mask/hooks/register.js privacy-mask/tests/model-input.test.ts
git commit -m "feat: mask system prompt, context, attachments, skills, tool descriptions and stored rows"
```

---

### Task 7: Unmask what the transcript draws

**Files:**
- Modify: `privacy-mask/hooks/register.js` (add one helper and four hooks inside `register`)
- Test: `privacy-mask/tests/render.test.ts`

**Interfaces:**
- Consumes: `state($)` (Task 4); test helpers (Task 4)
- Produces: `ui.render` hooks for `AssistantMessage`, `UserMessage`, `ToolUse`, `ToolResult`, `AskUserQuestion`

- [ ] **Step 1: Write the failing tests**

`privacy-mask/tests/render.test.ts`:

```typescript
import { expect, test } from 'claude-code/testing'
import { CONFIG, GLOBAL_PATH, IP_PLACEHOLDER, SECRET, setupWorld } from './helpers.ts'

const KNOWN = { 'privacy-mask:secret': SECRET, 'privacy-mask:reverse:/proj': { [IP_PLACEHOLDER]: '10.0.0.5' } }

function captureDrawing(on: any): { props: any } {
  const box: { props: any } = { props: undefined }
  on('ui.render', async (_$: unknown, e: any) => {
    box.props = e.props
    return { type: 'Text', props: {}, children: ['drawn'] }
  })
  return box
}

const render = ($: any, component: string, props: Record<string, unknown>) =>
  $.ui.render({ surface: 'terminal', component, requestId: 'r1', props } as any)

test('unmasks assistant and user message text', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  const box = captureDrawing(on)
  await render($, 'AssistantMessage', { text: `Contoso is at ${IP_PLACEHOLDER}`, isFirstOfReply: true })
  expect(box.props).toEqual({ text: 'Acme Corp is at 10.0.0.5', isFirstOfReply: true })
  await render($, 'UserMessage', { text: 'ask Contoso', origin: { kind: 'user' }, isExpanded: true })
  expect(box.props.text).toBe('ask Acme Corp')
})

test('unmasks a tool row input and output, adding no output while it runs', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  const box = captureDrawing(on)
  const base = { tool_use_id: 't1', tool: 'Bash', isRunning: true, isErrored: false, isInterrupted: false }
  await render($, 'ToolUse', { ...base, input: { command: `ping ${IP_PLACEHOLDER}` } })
  expect(box.props.input).toEqual({ command: 'ping 10.0.0.5' })
  expect('output' in box.props).toBe(false)
  await render($, 'ToolUse', { ...base, isRunning: false, input: { command: 'ls' }, output: { stdout: 'Contoso', stderr: '' } })
  expect(box.props.output).toEqual({ stdout: 'Acme Corp', stderr: '' })
})

test('unmasks a tool result and the questions dialog', async ($, on) => {
  setupWorld(on, { [GLOBAL_PATH]: CONFIG }, KNOWN)
  const box = captureDrawing(on)
  await render($, 'ToolResult', { tool_use_id: 't1', tool: 'Bash', output: { stdout: IP_PLACEHOLDER }, isErrored: false })
  expect(box.props.output).toEqual({ stdout: '10.0.0.5' })
  const question = {
    question: 'Deploy to Contoso?',
    header: 'Deploy',
    multiSelect: false,
    options: [{ label: IP_PLACEHOLDER, description: 'Contoso primary' }],
  }
  await render($, 'AskUserQuestion', { tool: 'AskUserQuestion', questions: [question] })
  expect(box.props.questions).toEqual([
    { ...question, question: 'Deploy to Acme Corp?', options: [{ label: '10.0.0.5', description: 'Acme Corp primary' }] },
  ])
})

test('draws unchanged without a config', async ($, on) => {
  setupWorld(on, {})
  const box = captureDrawing(on)
  await render($, 'AssistantMessage', { text: 'Contoso', isFirstOfReply: false })
  expect(box.props.text).toBe('Contoso')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `privacy-mask/`): `claude plugin test`
Expected: FAIL in `render.test.ts` (props arrive masked).

- [ ] **Step 3: Add the hooks to `register.js`**

Add below `persist`:

```javascript
// The masker for drawing, or null when nothing is masked; drawing never fails closed.
async function displayMasker($) {
  const s = await state($)
  return s.mode === 'active' ? s.masker : null
}
```

Add inside `register`, after the `session.append` hook:

```javascript
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
```

- [ ] **Step 4: Run the tests and the validator**

Run (from `privacy-mask/`): `claude plugin test`
Expected: PASS (every test file).

Run (from the repository root): `claude plugin validate ./privacy-mask --strict`
Expected: `Validation passed` with no warnings.

- [ ] **Step 5: Commit**

```bash
git add privacy-mask/hooks/register.js privacy-mask/tests/render.test.ts
git commit -m "feat: unmask transcript drawings"
```

---

### Task 8: Smoke test in a real session

**Files:**
- Create (outside the repository, in a scratch directory): `smoke/.claude/privacy-mask.json`, `smoke/CLAUDE.md`, `smoke/hosts.txt`

**Interfaces:**
- Consumes: the finished plugin
- Produces: a pass/fail report; no repository changes

This task checks what the test harness cannot: the real `session.append` path, the `tool.call` result reaching the model masked, `CLAUDE.md` masking, and prompt caching. If any check fails, stop and report the failing check with the evidence; do not patch around it.

- [ ] **Step 1: Prepare the smoke project**

In a scratch directory (not the repository), create:

`smoke/.claude/privacy-mask.json`:

```json
{
  "terms": { "Acme Corp": "Contoso" },
  "regex": [
    { "name": "EMAIL", "pattern": "[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+" },
    { "name": "IP", "pattern": "\\b\\d{1,3}(\\.\\d{1,3}){3}\\b" }
  ]
}
```

`smoke/CLAUDE.md`:

```
The client for this project is Acme Corp.
```

`smoke/hosts.txt`:

```
Acme Corp primary 10.0.0.5 admin ops@acme.io
```

- [ ] **Step 2: Start a session with the plugin and check its status**

Run (in `smoke/`): `claude --plugin-dir <absolute path to repository>/privacy-mask`
Type `/privacy-mask`.
Expected: `mode: active`, `config files: project`, `terms: 1`, `regex rules: 2`.

- [ ] **Step 3: Exercise reading, editing and CLAUDE.md**

Send, one at a time:
1. `Read hosts.txt and quote its line verbatim.`
2. `Use the Edit tool to change the IP in hosts.txt to 10.0.0.6.`
3. `Quote the first line of CLAUDE.md verbatim.`
4. `Say OK.`

Expected on screen: originals everywhere (`Acme Corp`, `10.0.0.5`, `ops@acme.io`).
Expected on disk: `hosts.txt` reads `Acme Corp primary 10.0.0.6 admin ops@acme.io`.

- [ ] **Step 4: Check the stored transcript holds no originals**

Find the session file: the newest `.jsonl` under `~/.claude/projects/` whose directory name ends with `smoke`.
Run: `grep -c -e "Acme Corp" -e "10.0.0.5" -e "10.0.0.6" -e "ops@acme.io" <that file>`
Expected: `0`. The model's quote of CLAUDE.md in that file reads `Contoso`.

- [ ] **Step 5: Check the prompt cache is hit**

Run: `grep -o '"cache_read_input_tokens":[0-9]*' <that file>`
Expected: the values for the requests of prompts 2-4 are greater than 0.

- [ ] **Step 6: Report**

Report each check (Steps 2-5) as pass or fail with the evidence. No commit.
