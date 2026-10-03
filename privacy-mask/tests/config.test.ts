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
