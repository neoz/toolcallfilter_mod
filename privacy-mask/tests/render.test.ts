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
