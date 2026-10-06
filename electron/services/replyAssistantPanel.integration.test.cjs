const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')
const fs = require('node:fs')

test('聊天页实际回复处理：首次请求固定账号；停止准备阶段不发送；旧结果不能覆盖新联系人', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/pages/ChatPage.tsx'), 'utf8')
  const start = source.indexOf('  const handleGenerateReplyAssistant = useCallback(')
  const end = source.indexOf('  const copyReplyDraft = useCallback(', start)
  assert.ok(start > 0 && end > start)
  const compiled = await esbuild.transform(`${source.slice(start, end)}\nglobalThis.handlers = { generate: handleGenerateReplyAssistant, stop: stopReplyGeneration }`, { loader: 'ts', format: 'cjs' })
  const calls = [], hints = []
  let releaseInitial, initial = { accountScope: 'wxid:me' }, stateCalls = 0
  const sandbox = { console, window: { crypto: { randomUUID: () => 'task-real-handler' }, electronAPI: {
    relationshipProfile: { getState: async () => { stateCalls++; return initial instanceof Promise ? await initial : initial } },
    insight: { generateReplyAssistant: async (payload) => { calls.push(payload); return { success: true, data: { sessionId: payload.sessionId, accountScope: payload.accountScope, draft: '保留草稿', mode: payload.mode } } }, cancelReplyAssistant: async (id) => ({ success: true, message: id }) }
  } }, useCallback: (fn) => fn, currentSession: { username: 'alice', displayName: 'Alice' }, currentSessionId: 'alice', isCurrentSessionGroup: false,
    isGeneratingReplyAssistant: false, replyTaskId: { current: null }, replyRequestStarted: { current: false }, replyTaskSequence: { current: 0 }, currentSessionRef: { current: 'alice' }, replyAssistant: null,
    setIsGeneratingReplyAssistant: (value) => { sandbox.busy = value }, setSessionInsightHint: (value) => hints.push(value), showSessionInsightHint: (value) => hints.push(value),
    setReplyAssistant: (value) => { sandbox.result = value }, displayNameOrFallback: (id, label) => label || id }
  vm.runInNewContext(compiled.code, sandbox)
  await sandbox.handlers.generate()
  assert.equal(calls[0].accountScope, 'wxid:me')
  assert.equal(calls[0].taskId, 'task-real-handler')
  assert.equal(sandbox.result.draft, '保留草稿')
  assert.equal(stateCalls, 2)
  initial = new Promise((resolve) => { releaseInitial = resolve })
  const stoppedBeforeRequest = sandbox.handlers.generate()
  await sandbox.handlers.stop()
  releaseInitial({ accountScope: 'wxid:me' })
  await stoppedBeforeRequest
  assert.equal(calls.length, 1)
  assert.equal(sandbox.busy, false)
  assert.equal(sandbox.result.draft, '保留草稿')
  initial = { accountScope: 'wxid:me' }
  sandbox.window.electronAPI.insight.generateReplyAssistant = async (payload) => { calls.push(payload); sandbox.currentSessionRef.current = 'bob'; return { success: true, data: { sessionId: 'alice', accountScope: 'wxid:me', draft: '错误覆盖' } } }
  await sandbox.handlers.generate()
  assert.equal(sandbox.result.draft, '保留草稿')
  sandbox.currentSessionRef.current = 'alice'
  sandbox.replyAssistant = { accountScope: 'wxid:old' }
  const beforeMismatch = calls.length
  await sandbox.handlers.generate()
  assert.equal(calls.length, beforeMismatch)
  assert.equal(sandbox.result, null)
  assert.match(hints.at(-1).message, /账号已切换/)
})

test('实际回复面板：澄清不能复制、建议模式须点击确认、偏好修改后审核保存', async () => {
  const slots = [], effects = [], intervals = new Map()
  let nextTimer = 1, validation = { success: true, message: '仍有效' }, validationCalls = 0, validateHook
  let cursor = 0, dirty = true, tree, approved = false, stopped = false
  const hooks = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, (next) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; dirty = true }] },
    useEffect(callback, deps) { const i = cursor++; if (!slots[i] || deps.some((item, j) => slots[i].deps[j] !== item)) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = callback() }) } }
  }
  const generations = [], preferences = []
  const result = await esbuild.build({ entryPoints: [path.join(__dirname, '../../src/components/ReplyAssistantPanel.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'panel-host', setup(build) {
    build.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({ path: args.path, namespace: 'host' }))
    build.onLoad({ filter: /.*/, namespace: 'host' }, (args) => ({ contents: args.path === 'react' ? 'export const { useState, useEffect } = globalThis.hooks'
      : 'export const Fragment = "fragment"; export const jsx = (type, props) => ({type, props}); export const jsxs = jsx' }))
  } }] })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, hooks, console, window: { confirm: () => approved,
    setInterval: (fn) => { const id = nextTimer++; intervals.set(id, fn); return id }, clearInterval: (id) => intervals.delete(id),
    electronAPI: { insight: { validateReplyAssistant: async () => { validationCalls++; if (validateHook) await validateHook(); return validation } },
      relationshipProfile: { confirmReplyPreference: async (input) => { preferences.push(input); return { success: true, message: '已保存' } } } } } })
  const props = { result: { suggestionId: 'one', sessionId: 'alice', accountScope: 'wxid:me', mode: 'natural', status: 'clarification', clarificationQuestion: '你愿意见面吗？', reason: '意图未知', risk: '不能替你决定', draft: '' }, busy: false,
    onChange: () => {}, onGenerate: async (options) => generations.push(options), onCopy: async () => { throw new Error('澄清不能复制') }, onOutcome: async () => {}, onClose: () => {}, onStop: async () => { stopped = true } }
  async function settle() { for (let i = 0; i < 8; i++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.default(props); while (effects.length) effects.shift()() } await new Promise((resolve) => setImmediate(resolve)); if (!dirty && !effects.length) return } throw Error('未稳定') }
  const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : []
  const content = (node) => Array.isArray(node) ? node.map(content).join('') : node && typeof node === 'object' ? content(node.props?.children) : String(node ?? '')
  const button = (label) => nodes(tree).find((node) => node.type === 'button' && content(node) === label)
  await settle()
  assert.equal(button('复制'), undefined)
  assert.equal(button('补充后生成回复').props.disabled, true)
  nodes(tree).find((node) => node.type === 'textarea').props.onChange({ target: { value: '愿意，改下周' } })
  await settle()
  button('补充后生成回复').props.onClick()
  await settle()
  assert.equal(generations[0].clarification.answer, '愿意，改下周')
  props.result = { ...props.result, suggestionId: 'two', status: 'draft', draft: '下周见', previousDraft: '宝贝下周见', suggestedMode: 'boundary', suggestedModeReason: '维护边界', revisionFeedback: '别叫宝贝', proposedPreference: '不使用亲昵称呼', clarification: { question: '愿意见面吗', answer: '愿意' }, historyEvidence: [{ id: 'm-history', localId: 1, createTime: 100, sender: '我', quote: '之前约定不使用亲昵称呼' }] }
  dirty = true
  await settle()
  assert.equal(preferences.length, 0)
  assert.match(content(tree), /历史取证 · 1 条摘录/)
  assert.match(content(tree), /之前约定不使用亲昵称呼/)
  button('确认采用建议并重新生成').props.onClick()
  await settle()
  assert.equal(generations.at(-1).mode, 'boundary')
  assert.equal(generations.at(-1).clarification.answer, '愿意')
  button('确认保存到这段关系').props.onClick()
  await settle()
  assert.equal(preferences.length, 0)
  nodes(tree).find((node) => node.props?.['aria-label'] === '审核沟通偏好').props.onChange({ target: { value: '对 Alice 不使用亲昵称呼' } })
  await settle()
  approved = true
  button('确认保存到这段关系').props.onClick()
  await settle()
  assert.equal(preferences.length, 1)
  assert.equal(preferences[0].sessionId, 'alice')
  assert.equal(preferences[0].accountScope, 'wxid:me')
  assert.equal(preferences[0].value, '对 Alice 不使用亲昵称呼')
  assert.equal(preferences[0].feedback, '别叫宝贝')
  assert.equal(preferences[0].replyMode, undefined)
  assert.equal(preferences[0].expressionExample, undefined)
  const exampleToggle = nodes(tree).find((node) => node.props?.['aria-label'] === '同时记住表达范例')
  assert.equal(exampleToggle.props.checked, false)
  exampleToggle.props.onChange({ target: { checked: true } })
  nodes(tree).find((node) => node.props?.['aria-label'] === '沟通偏好适用场景').props.onChange({ target: { value: 'boundary' } })
  await settle()
  button('确认保存到这段关系').props.onClick()
  await settle()
  assert.equal(preferences.at(-1).expressionExample.previous, '宝贝下周见')
  assert.equal(preferences.at(-1).expressionExample.approved, '下周见')
  assert.equal(preferences.at(-1).replyMode, 'boundary')
  assert.equal(button('复制').props.disabled, false)
  const checksBeforeEdit = validationCalls
  props.result = { ...props.result, draft: '我自己改过的回复' }; dirty = true
  await settle()
  assert.equal(validationCalls, checksBeforeEdit, 'typing must not restart the validity effect')
  let releaseCheck
  validateHook = () => new Promise((resolve) => { releaseCheck = resolve })
  const poll = [...intervals.values()][0]
  poll(); poll()
  assert.equal(validationCalls, checksBeforeEdit + 1, 'slow validation requests cannot overlap')
  validation = { success: false, message: '读取失败，请稍后重试' }
  releaseCheck(); validateHook = undefined
  await settle()
  assert.equal(button('复制').props.disabled, true)
  validation = { success: true, message: '仍有效' }
  poll(); await settle()
  assert.equal(button('复制').props.disabled, false, 'transient read failure can recover without losing text')
  validation = { success: false, stale: true, message: '有新消息，请重新生成；原草稿已保留' }
  poll(); await settle()
  assert.equal(button('复制').props.disabled, true)
  assert.match(content(tree), /有新消息/)
  assert.equal(nodes(tree).find((node) => node.props?.['aria-label'] === '编辑回复草稿').props.value, '我自己改过的回复')
  const checksAfterStale = validationCalls
  poll(); await settle()
  assert.equal(validationCalls, checksAfterStale, 'permanently stale suggestions stop polling')
  props.busy = true
  dirty = true
  await settle()
  assert.equal(button('停止生成').props.disabled, undefined)
  button('停止生成').props.onClick()
  await settle()
  assert.equal(stopped, true)
  assert.equal(intervals.size, 0)
})

test('复制前必须通过本地校验，过时、旧桌面接口和切换联系人均不能写入剪贴板', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/pages/ChatPage.tsx'), 'utf8')
  const start = source.indexOf('  const copyReplyDraft = useCallback(')
  const end = source.indexOf('  const recordReplyOutcome = useCallback(', start)
  const compiled = await esbuild.transform(`${source.slice(start, end)}\nglobalThis.copy = copyReplyDraft`, { loader: 'ts', format: 'cjs' })
  const writes = []
  let response = { success: true, message: '仍有效' }, release
  const sandbox = { useCallback: (fn) => fn, replyAssistant: { accountScope: 'wxid:me', sessionId: 'alice', suggestionId: 'one', draft: '我修改后的草稿' },
    currentSessionRef: { current: 'alice' }, replyTaskSequence: { current: 1 }, showSessionInsightHint: () => {},
    navigator: { clipboard: { writeText: async (text) => writes.push(text) } }, window: { electronAPI: { insight: { validateReplyAssistant: async () => response } } } }
  vm.runInNewContext(compiled.code, sandbox)
  await sandbox.copy()
  assert.deepEqual(writes, ['我修改后的草稿'])
  response = { success: false, stale: true, message: '有新消息，请重新生成' }
  await assert.rejects(sandbox.copy(), /有新消息/)
  response = { success: false, message: '读取失败' }
  await assert.rejects(sandbox.copy(), /读取失败/)
  sandbox.window.electronAPI.insight.validateReplyAssistant = async () => { throw Error("No handler registered for 'insight:validateReplyAssistant'") }
  await assert.rejects(sandbox.copy(), /请重启 TalkGate/)
  sandbox.window.electronAPI.insight.validateReplyAssistant = undefined
  await assert.rejects(sandbox.copy(), /请重启 TalkGate/)
  sandbox.window.electronAPI.insight.validateReplyAssistant = () => new Promise((resolve) => { release = resolve })
  const pending = sandbox.copy()
  sandbox.currentSessionRef.current = 'bob'
  release({ success: true })
  await pending
  assert.equal(writes.length, 1)
  sandbox.currentSessionRef.current = 'alice'
  const replaced = sandbox.copy()
  sandbox.replyTaskSequence.current++
  release({ success: true })
  await replaced
  assert.equal(writes.length, 1, 'a new generation/close while validating cannot copy the previous reply')
})

