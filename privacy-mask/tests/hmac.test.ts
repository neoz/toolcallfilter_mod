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
