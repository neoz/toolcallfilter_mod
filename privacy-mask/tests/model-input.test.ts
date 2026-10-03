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
