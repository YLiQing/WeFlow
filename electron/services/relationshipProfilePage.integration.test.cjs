const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')

test('真实关系页面：重新分析先保存编辑；失败恢复；删除中止任务且清理忙碌状态', async () => {
  // Run the actual component and its effects with a tiny hook host; no browser or new dependency.
  const slots = [], effects = [], timers = new Map()
  let cursor = 0, nextTimer = 0, dirty = true, tree
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((item, i) => item !== b[i])
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, (value) => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; dirty = true }]
    },
    useRef(initial) { const index = cursor++; return slots[index] || (slots[index] = { current: initial }) },
    useMemo(factory, deps) {
      const index = cursor++
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() }
      return slots[index].value
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!slots[index] || changed(slots[index].deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback() })
      }
    }
  }
  const state = { version: 1, memoryEnabled: true, memoryPaused: false, user: {}, objects: { alice: { sessionId: 'alice', automaticDraftUpdates: true, automaticDraftStatus: { state: 'waiting_review', pendingReviewTaskId: 'old', queuedNewMessages: 0, updatedAt: 1 }, confirmedFacts: [], hypotheses: [{ value: '旧推测', confidence: 'low', status: 'active', expiresAt: Date.now() - 1 }], keyEvents: [], updatedAt: 1 } }, relationships: {}, updatedAt: 1 }
  const field = { value: '原草稿', confidence: 'medium', evidenceIds: [], quotes: [] }
  const draft = { sessionId: 'alice', accountScope: 'wxid:me', taskId: 'old', generatedAt: 1, coverage: { analyzedMessages: 2, totalMessages: 2, truncated: false }, statistics: { totalMessages: 2, myMessages: 1, objectMessages: 1, conversationSegments: 1, myInitiations: 1, objectInitiations: 0 }, report: { facts: [], hypotheses: [], unknowns: [] }, evidence: [], user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] }, object: { confirmedFacts: [field], hypotheses: [], keyEvents: [] }, relationship: {} }
  let review = { draft, selection: {} }, generation, mode = 'failure', sequence = 0, failSave = false, consent = true
  const calls = []
  let stateDelay
  const api = {
    relationshipProfile: {
      getMemoryHistory: async (id, scope) => { assert.equal(id, 'alice'); assert.equal(scope, 'wxid:me'); return { success: true, revision: 'current-revision', versions: [{ id: 'version1', createdAt: 1, reason: '审核 AI 草稿', object: state.objects.alice, relationship: { goal: '旧目标' } }], archives: [{ id: 'archive1', value: '旧事实', field: 'confirmedFacts', archivedAt: 1 }] } },
      restoreMemory: async (input) => { calls.push(['restore', input]); return { success: true, state, message: '已恢复' } },
      getAnalysisHistory: async () => ({ success: true, entries: [{ draft, status: 'discarded' }] }),
      getState: async () => { calls.push(['state-read']); if (stateDelay) await stateDelay; return { success: true, accountScope: 'wxid:me', state } },
      getPendingReview: async () => { calls.push(['review-read']); return { success: true, review } },
      savePendingReview: async (input) => { calls.push(['save', input]); if (failSave === 'declined') return { success: false }; if (failSave) throw new Error('模拟草稿保存失败'); review = input; return { success: true } },
      applyDraft: async (input) => { calls.push(['apply', input]); review = { ...review, decisions: { 'confirmedFacts:0': 'rejected' } }; return { success: true, state, message: '审核已提交' } },
      forgetObject: async (id, scope) => { assert.equal(id, 'alice'); assert.equal(scope, 'wxid:me'); calls.push(['forget']); review = undefined; return { success: true, state: { ...state, objects: {} }, message: '已删除' } }
    },
    chat: {
      getSessions: async () => ({ success: true, sessions: [{ username: 'alice', displayName: 'Alice' }, { username: 'bob', displayName: 'Bob' }] }),
      getContacts: async () => ({ success: true, contacts: [{ username: 'bob', remark: 'Bob 备注' }] })
    },
    insight: {
      onRelationshipProfileProgress: () => () => {},
      cancelRelationshipProfileDraft: async (id) => { calls.push(['cancel', id]); generation?.({ success: false, message: '已停止' }); return { success: true } },
      generateRelationshipProfileDraft: async () => {
        calls.push(['generate'])
        if (mode === 'failure') return { success: false, message: '模拟模型故障' }
        return new Promise((resolve) => { generation = resolve })
      }
    }
  }
  const result = await esbuild.build({ entryPoints: [path.join(__dirname, '../../src/pages/RelationshipProfilePage.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'page-host', setup(build) {
    build.onResolve({ filter: /^(react|react\/jsx-runtime|lucide-react)$|\.scss$/ }, (args) => ({ path: args.path, namespace: 'host' }))
    build.onLoad({ filter: /.*/, namespace: 'host' }, (args) => ({ contents: args.path === 'react'
      ? 'export const { useState, useEffect, useMemo, useRef } = globalThis.hooks'
      : args.path === 'react/jsx-runtime' ? 'export const Fragment = "fragment"; export const jsx = (type, props) => ({type, props}); export const jsxs = jsx'
      : args.path === 'lucide-react' ? 'export const HeartHandshake = "icon", Lock = "icon", Search = "icon", Save = "icon", UserRound = "icon"' : '' }))
  } }] })
  const module = { exports: {} }
  const timer = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, hooks, crypto: { randomUUID: () => `task-${++sequence}` }, Date, console,
    window: { electronAPI: api, confirm: () => consent, setTimeout: timer, clearTimeout: (id) => timers.delete(id), setInterval: timer, clearInterval: (id) => timers.delete(id) } })
  const Component = module.exports.default
  async function settle() {
    for (let i = 0; i < 20; i++) {
      if (dirty) { dirty = false; cursor = 0; tree = Component(); while (effects.length) effects.shift()() }
      await new Promise((resolve) => setImmediate(resolve))
      if (!dirty && !effects.length) return
    }
    throw new Error('Component did not settle')
  }
  const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : []
  const content = (node) => Array.isArray(node) ? node.map(content).join('') : node && typeof node === 'object' ? content(node.props?.children) : String(node ?? '')
  const button = (label) => {
    const found = nodes(tree).find((node) => node.type === 'button' && content(node) === label)
    assert.ok(found, `Missing button: ${label}`)
    return found
  }
  await settle()
  assert.match(content(tree), /Bob 备注/)
  assert.match(content(tree), /已过期：旧推测/)
  assert.match(content(tree), /已丢弃.*覆盖 2 条/)
  const editor = nodes(tree).find((node) => node.type === 'input' && node.props['aria-label'] === '编辑建议')
  assert.ok(editor)
  editor.props.onChange({ target: { value: '最新编辑但尚未到400ms' } })
  await settle()
  const poll = () => { const entry = Array.from(timers.values()).find((entry) => entry.delay === 5000); assert.ok(entry, 'status poll remains active while editing a pending draft'); return entry.callback }
  state.objects.alice.automaticDraftStatus = { state: 'waiting_review', pendingReviewTaskId: 'old', queuedNewMessages: 20, queuedCheckedAt: 123, updatedAt: 123 }
  const reviewsBeforePoll = calls.filter(([name]) => name === 'review-read').length
  poll()()
  await settle()
  assert.match(content(tree), /当前草稿之后至少新增 20 条消息/)
  assert.equal(calls.filter(([name]) => name === 'review-read').length, reviewsBeforePoll, 'poll only fetches operational status when a draft is open')
  assert.ok(nodes(tree).some((node) => node.type === 'input' && node.props.value === '最新编辑但尚未到400ms'), 'poll cannot overwrite unsaved edits')
  let releasePoll
  stateDelay = new Promise((resolve) => { releasePoll = resolve })
  const slowPoll = poll()
  const stateReadsBefore = calls.filter(([name]) => name === 'state-read').length
  slowPoll(); slowPoll()
  assert.equal(calls.filter(([name]) => name === 'state-read').length, stateReadsBefore + 1, 'slow IPC calls cannot overlap')
  releasePoll(); stateDelay = undefined
  await settle()
  state.objects.alice.automaticDraftStatus.pendingReviewTaskId = 'other-draft'
  poll()()
  await settle()
  assert.doesNotMatch(content(tree), /当前草稿之后至少新增/)
  state.objects.alice.automaticDraftStatus.pendingReviewTaskId = 'old'
  poll()()
  await settle()
  const decisionEditor = () => nodes(tree).find((node) => node.type === 'select' && node.props['aria-label'] === '审核决定 confirmedFacts:0')
  assert.equal(decisionEditor().props.value, 'pending')
  decisionEditor().props.onChange({ target: { value: 'reject' } })
  await settle()
  button('分析 Alice 的全部记录').props.onClick()
  await settle()
  const saved = calls.findIndex(([name]) => name === 'save')
  const generated = calls.findIndex(([name]) => name === 'generate')
  assert.ok(saved >= 0 && generated > saved)
  assert.equal(calls[saved][1].draft.object.confirmedFacts[0].value, '最新编辑但尚未到400ms')
  assert.equal(calls[saved][1].decisions['confirmedFacts:0'], 'reject')
  assert.equal(decisionEditor().props.value, 'reject')
  assert.ok(nodes(tree).some((node) => node.type === 'input' && node.props.value === '最新编辑但尚未到400ms'))
  assert.match(content(tree), /模拟模型故障/)
  failSave = true
  const generationsBefore = calls.filter(([name]) => name === 'generate').length
  button('分析 Alice 的全部记录').props.onClick()
  await settle()
  assert.equal(calls.filter(([name]) => name === 'generate').length, generationsBefore)
  assert.ok(nodes(tree).some((node) => node.type === 'input' && node.props.value === '最新编辑但尚未到400ms'))
  assert.match(content(tree), /模拟草稿保存失败/)
  nodes(tree).find((node) => node.type === 'button' && content(node).startsWith('Bob')).props.onClick()
  await settle()
  assert.match(content(tree), /未切换联系人/)
  assert.ok(button('分析 Alice 的全部记录'))
  assert.match(content(tree), /有限证据摘录.*发送至你配置的 AI 服务/)
  failSave = 'declined'
  button('分析 Alice 的全部记录').props.onClick()
  await settle()
  assert.equal(calls.filter(([name]) => name === 'generate').length, generationsBefore)
  assert.match(content(tree), /草稿未保存/)
  failSave = false
  button('提交审核决定').props.onClick()
  await settle()
  assert.equal(calls.find(([name]) => name === 'apply')[1].decisions['confirmedFacts:0'], 'reject')
  assert.equal(decisionEditor().props.value, 'rejected')
  assert.equal(decisionEditor().props.disabled, true)
  assert.equal(nodes(tree).find((node) => node.type === 'input' && node.props['aria-label'] === '编辑建议').props.disabled, true)
  button('读取记忆历史').props.onClick()
  await settle()
  assert.match(content(tree), /旧目标/)
  consent = false
  button('确认恢复此版本').props.onClick()
  await settle()
  assert.equal(calls.filter(([name]) => name === 'restore').length, 0)
  consent = true
  button('确认恢复此版本').props.onClick()
  await settle()
  assert.equal(calls.find(([name]) => name === 'restore')[1].revision, 'current-revision')
  assert.equal(calls.find(([name]) => name === 'restore')[1].kind, 'version')
  assert.equal(calls.find(([name]) => name === 'restore')[1].accountScope, 'wxid:me')
  mode = 'pending'
  button('分析 Alice 的全部记录').props.onClick()
  await settle()
  assert.ok(button('分析中…').props.disabled)
  button('删除此档案').props.onClick()
  await settle()
  assert.ok(calls.some(([name]) => name === 'cancel'))
  assert.ok(calls.some(([name]) => name === 'forget'))
  assert.equal(button('分析 Alice 的全部记录').props.disabled, false)
  assert.ok(!content(tree).includes('待审核的 AI 画像建议'))
  assert.equal(review, undefined)
  for (const slot of slots) slot?.cleanup?.()
})
