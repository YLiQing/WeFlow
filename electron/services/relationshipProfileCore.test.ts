import assert from 'node:assert/strict'
import test from 'node:test'
test('超过20条的明确边界仍完整保存，不随画像列表截断', () => {
  const boundaries = Array.from({ length: 25 }, (_, i) => `明确边界-${i}`)
  const state = upsertRelationshipProfile(createEmptyRelationshipState(), 'alice', { user: { boundaries }, object: { selfProfile: { boundaries } } })
  assert.equal(state.user.boundaries?.length, 25)
  assert.equal(state.objects.alice.selfProfile?.boundaries?.length, 25)
  const context = buildRelationshipMemoryContext({ ...state, memoryEnabled: true }, 'alice')
  assert.match(context, /明确边界-0/)
  assert.match(context, /明确边界-24/)
})
import {
  createEmptyRelationshipState,
  buildRelationshipMemoryContext,
  selectRelationshipHistoricalMemory,
  buildRelationshipDraftChanges,
  normalizeRelationshipState,
  upsertRelationshipProfile,
  addRelationshipEvent,
  addConfirmedFact,
  addRelationshipHypothesis,
  removeConfirmedFact,
  removeRelationshipHypothesis,
  addRelationshipReplyOutcome,
  setRelationshipAutomaticDraftStatus,
  setRelationshipAnalysisCheckpoint,
  applyRelationshipProfileDraft,
  reviewRelationshipHypothesis,
  relationshipHypothesisStatus,
  type RelationshipProfileDraft,
  type RelationshipProfileState
} from './relationshipProfileCore.ts'

test('历史记忆召回只使用容量归档，排除当前条目、主动移除、旧边界和其他联系人', () => {
  const state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', {
    object: { confirmedFacts: ['周六当前安排'] }
  })
  const archives = [
    { id: 'historical', field: 'confirmedFacts' as const, value: '周六之前约定过一起散步', archivedAt: 1, reason: 'capacity' as const },
    { id: 'active', field: 'confirmedFacts' as const, value: '周六当前安排', archivedAt: 1, reason: 'capacity' as const },
    { id: 'removed', field: 'confirmedFacts' as const, value: '周六主动删除的记录', archivedAt: 2, reason: 'removed' as const },
    { id: 'legacy', field: 'confirmedFacts' as const, value: '周六来源不明的旧归档', archivedAt: 3 },
    { id: 'boundary', field: 'boundaries' as const, value: '周六不联系', archivedAt: 4, reason: 'capacity' as const }
  ]
  const selected = selectRelationshipHistoricalMemory(state, 'alice', archives, '还记得周六一起散步吗？')
  assert.deepEqual(selected.map((entry) => entry.id), ['historical'])
  assert.equal(selectRelationshipHistoricalMemory(state, 'bob', archives, '周六').length, 0)
  assert.equal(selectRelationshipHistoricalMemory({ ...state, memoryEnabled: false }, 'alice', archives, '周六').length, 0)
  assert.equal(selectRelationshipHistoricalMemory(state, 'alice', archives, '').length, 0)
  assert.equal(selectRelationshipHistoricalMemory(state, 'alice', archives, '完全无关的主题').length, 0)
  const many = Array.from({ length: 100 }, (_, i) => ({ ...archives[0], id: String(i) }))
  assert.equal(selectRelationshipHistoricalMemory(state, 'alice', many, '周六').length, 4)
})

test('关系表达偏好按审核的模式使用，来源记录淘汰或编辑画像不能变成通用偏好', () => {
  const state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', { object: {
    selfProfile: { communicationPreferences: ['平时少用表情', '冲突时先认错', '拒绝时不解释太多'], communicationPreferenceModes: { '冲突时先认错': 'repair', '拒绝时不解释太多': 'boundary' }, boundaries: ['不公开住址'] },
    fieldSources: [{ field: 'self.communicationPreferences', value: '冲突时先认错', confidence: 'high', evidenceIds: [], quotes: [], reviewedAt: 1, taskId: 'one', replyMode: 'repair', expressionExample: { previous: '都是你不对', approved: '刚才我的语气不好', feedback: '冲突先承认自己的语气' } }]
  } })
  const ordinary = buildRelationshipMemoryContext(state, 'alice', '', 'natural')
  assert.match(ordinary, /平时少用表情/)
  assert.match(ordinary, /不公开住址/)
  assert.doesNotMatch(ordinary, /冲突时先认错|刚才我的语气不好|拒绝时不解释太多/)
  const repair = buildRelationshipMemoryContext(state, 'alice', '', 'repair')
  assert.match(repair, /冲突时先认错/)
  assert.match(repair, /刚才我的语气不好/)
  assert.doesNotMatch(repair, /拒绝时不解释太多/)
  const noSources = upsertRelationshipProfile(state, 'alice', { object: { fieldSources: [] } })
  assert.doesNotMatch(buildRelationshipMemoryContext(noSources, 'alice', '', 'natural'), /冲突时先认错/)
  const revised: RelationshipProfileDraft = { ...draftMetadata(), user: { communicationPreferences: [{ value: '冲突时先承认语气问题', replacesValue: '冲突时先认错', confidence: 'high', evidenceIds: [], quotes: [] }], strengths: [], limitations: [], boundaries: [] }, object: { confirmedFacts: [], hypotheses: [], keyEvents: [] }, relationship: {} }
  const replaced = applyRelationshipProfileDraft(noSources, 'alice', revised, { user: { communicationPreferences: [0] } })
  assert.equal(replaced.objects.alice.selfProfile?.communicationPreferenceModes?.['冲突时先承认语气问题'], 'repair')
  assert.doesNotMatch(buildRelationshipMemoryContext(replaced, 'alice', '', 'natural'), /冲突时先承认语气问题/)
  assert.match(buildRelationshipMemoryContext(replaced, 'alice', '', 'repair'), /冲突时先承认语气问题/)
  const archives = [{ id: 'scope', field: 'communicationPreferences' as const, value: '冲突表达很简短', archivedAt: 1, reason: 'capacity' as const, source: state.objects.alice.fieldSources![0] }]
  assert.equal(selectRelationshipHistoricalMemory(noSources, 'alice', archives, '冲突', 'natural').length, 0)
  assert.equal(selectRelationshipHistoricalMemory(noSources, 'alice', archives, '冲突', 'repair').length, 1)
})

test('关系草稿本地变化摘要只比较当前档案，不把模型报告当作已写入记忆', () => {
  const state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', {
    object: { confirmedFacts: ['原有事实'], selfProfile: { communicationPreferences: ['简短直接'] } }, relationship: { goal: '保持朋友关系' }
  })
  const changes = buildRelationshipDraftChanges(state, 'alice', {
    user: { communicationPreferences: [{ value: '少用亲昵称呼', confidence: 'low', evidenceIds: [], quotes: [] }], strengths: [], limitations: [], boundaries: [] },
    object: { confirmedFacts: [{ value: '更新事实', replacesValue: '原有事实', confidence: 'medium', evidenceIds: [], quotes: [] }], hypotheses: [], keyEvents: [] },
    relationship: { goal: { value: '继续观察', confidence: 'low', evidenceIds: [], quotes: [] } }
  })
  assert.ok(changes.added.some((item) => item.value === '少用亲昵称呼'))
  assert.ok(changes.replacements.some((item) => item.previousValue === '原有事实' && item.value === '更新事实'))
  assert.ok(changes.replacements.some((item) => item.previousValue === '保持朋友关系' && item.value === '继续观察'))
  const labelChanges = buildRelationshipDraftChanges(state, 'alice', {
    user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] },
    object: { displayLabel: { value: 'Alice 新称呼', confidence: 'low', evidenceIds: [], quotes: [] }, confirmedFacts: [], hypotheses: [], keyEvents: [] }, relationship: {}
  })
  assert.ok(labelChanges.added.some((item) => item.key === 'object.displayLabel' && item.value === 'Alice 新称呼'))
})
import { buildRelationshipStatistics } from './relationshipAnalysisCore.ts'

const draftMetadata = () => ({
  sessionId: 'alice', accountScope: 'test-account', taskId: 'test-task', generatedAt: 1,
  coverage: { totalMessages: 0, analyzedMessages: 0, truncated: false },
  statistics: buildRelationshipStatistics([]), report: { facts: [], hypotheses: [], unknowns: [] }, evidence: []
})

test('新关系档案默认关闭长期记忆且不预填对象信息', () => {
  const state = createEmptyRelationshipState()
  assert.equal(state.memoryEnabled, false)
  assert.deepEqual(state.user, {})
  assert.deepEqual(state.objects, {})
  assert.deepEqual(state.relationships, {})
})

test('对象画像和关系策略按 sessionId 隔离', () => {
  const state = createEmptyRelationshipState()
  const next = upsertRelationshipProfile(state, 'alice', {
    object: { displayLabel: 'Alice', confirmedFacts: ['周末通常有空'] },
    relationship: { role: '暧昧对象', goal: '自然推进', replyAttitude: '轻松、真诚' }
  })
  const other = upsertRelationshipProfile(next, 'bob', {
    object: { displayLabel: 'Bob' },
    relationship: { role: '同事', goal: '高效沟通' }
  })
  assert.equal(other.objects.alice?.displayLabel, 'Alice')
  assert.equal(other.relationships.alice?.role, '暧昧对象')
  assert.equal(other.objects.bob?.displayLabel, 'Bob')
  assert.equal(other.relationships.bob?.role, '同事')
  assert.equal(other.relationships.alice?.goal, '自然推进')
})

test('事实、推测和事件不会被归并成同一字段', () => {
  const raw: Partial<RelationshipProfileState> = {
    memoryEnabled: true,
    objects: {
      alice: {
        sessionId: 'alice',
        displayLabel: 'Alice',
        confirmedFacts: ['明确说过周末有空'],
        hypotheses: [{ value: '可能偏好低频联系', confidence: 'medium', source: 'model' }],
        keyEvents: [{ id: 'e1', summary: '第一次具体邀约', occurredAt: '2026-09-28', source: 'user' }],
        updatedAt: 1
      }
    }
  }
  const state = normalizeRelationshipState(raw)
  assert.deepEqual(state.objects.alice?.confirmedFacts, ['明确说过周末有空'])
  assert.equal(state.objects.alice?.hypotheses[0]?.value, '可能偏好低频联系')
  assert.equal(state.objects.alice?.keyEvents[0]?.id, 'e1')
})

test('评分被限制在 0 到 100，且非法联系人不会写入', () => {
  const state = normalizeRelationshipState({
    memoryEnabled: true,
    objects: {
      alice: { sessionId: 'wrong', displayLabel: 'Alice', subjectiveScore: 140 }
    }
  })
  assert.equal(state.objects.alice?.sessionId, 'alice')
  assert.equal(state.objects.alice?.subjectiveScore, 100)
  assert.deepEqual(upsertRelationshipProfile(state, '', { object: { displayLabel: 'ignored' } }), state)
})

test('用户全局画像可以独立于联系人保存', () => {
  const state = createEmptyRelationshipState()
  const next = upsertRelationshipProfile(state, '', { user: { displayLabel: '我', communicationPreferences: ['直接、少解释'] } })
  assert.equal(next.user.displayLabel, '我')
  assert.deepEqual(next.user.communicationPreferences, ['直接、少解释'])
  assert.deepEqual(next.objects, {})
})

test('未授权时不注入关系档案，授权后只注入当前对象并区分事实与推测', () => {
  const state = upsertRelationshipProfile(createEmptyRelationshipState(), 'alice', {
    user: {
      mbti: 'INFP',
      subjectiveScore: 72,
      strengths: ['真诚'],
      limitations: ['容易多想'],
      boundaries: ['不接受冷处理']
    },
    object: {
      subjectiveScore: 80,
      confirmedFacts: ['明确说过周末有空'],
      hypotheses: [{ value: '可能偏好低频联系', confidence: 'medium', source: 'model' }]
    },
    relationship: { role: '暧昧对象', replyAttitude: '轻松、真诚' }
  })
  assert.equal(buildRelationshipMemoryContext(state, 'alice'), '')
  const enabled = { ...state, memoryEnabled: true }
  const context = buildRelationshipMemoryContext(enabled, 'alice')
  assert.match(context, /已确认事实：明确说过周末有空/)
  assert.match(context, /用户 MBTI（用户提供）：INFP/)
  assert.match(context, /用户主观综合评分（用户自评）：72/)
  assert.match(context, /用户优势：真诚/)
  assert.match(context, /对象主观综合评分（用户评价）：80/)
  assert.match(context, /暂定推测（不可当作事实）：可能偏好低频联系/)
  assert.match(context, /用户在这段关系中的角色：暧昧对象/)
  const otherContext = buildRelationshipMemoryContext(enabled, 'bob')
  assert.match(otherContext, /用户 MBTI（用户提供）：INFP/)
  assert.doesNotMatch(otherContext, /明确说过周末有空/)
  assert.doesNotMatch(otherContext, /可能偏好低频联系/)
})

test('关键事件按对象隔离、同 ID 更新且最多保留 20 条', () => {
  let state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  for (let index = 0; index < 21; index += 1) {
    state = addRelationshipEvent(state, 'alice', {
      id: `event-${index}`,
      summary: `事件 ${index}`,
      occurredAt: `2026-09-${String(index + 1).padStart(2, '0')}`,
      source: 'user'
    })
  }
  assert.equal(state.objects.alice?.keyEvents.length, 20)
  assert.equal(state.objects.alice?.keyEvents[0]?.id, 'event-1')
  const updated = addRelationshipEvent(state, 'alice', {
    id: 'event-20', summary: '已修正的事件', occurredAt: '2026-10-01', source: 'user'
  })
  assert.equal(updated.objects.alice?.keyEvents.length, 20)
  assert.equal(updated.objects.alice?.keyEvents.at(-1)?.summary, '已修正的事件')
})

test('分析结果只有被确认后才进入事实或推测层，并各自受上限约束', () => {
  let state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  state = addConfirmedFact(state, 'alice', '对方明确说过周末有空')
  state = addConfirmedFact(state, 'alice', '对方明确说过周末有空')
  assert.deepEqual(state.objects.alice?.confirmedFacts, ['对方明确说过周末有空'])
  state = addRelationshipHypothesis(state, 'alice', '可能偏好低频联系', 'medium', ['m1'])
  assert.equal(state.objects.alice?.hypotheses[0]?.source, 'model')
  assert.deepEqual(state.objects.alice?.hypotheses[0]?.evidenceIds, ['m1'])
  state = removeConfirmedFact(state, 'alice', '对方明确说过周末有空')
  state = removeRelationshipHypothesis(state, 'alice', '可能偏好低频联系')
  assert.deepEqual(state.objects.alice?.confirmedFacts, [])
  assert.deepEqual(state.objects.alice?.hypotheses, [])
})

test('AI 草稿只有审核选中后才写入对应层', () => {
  const state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  const draft: RelationshipProfileDraft = {
    ...draftMetadata(),
    user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] },
    object: {
      confirmedFacts: [{ value: '明确说过周末有空', confidence: 'high' as const, evidenceIds: ['m1'], quotes: ['周末有空'] }],
      hypotheses: [{ value: '可能偏好低频联系', confidence: 'medium' as const, evidenceIds: ['m2'], quotes: ['最近回复较慢'] }],
      keyEvents: [],
      displayLabel: undefined
    },
    relationship: {}
  }
  const unchanged = applyRelationshipProfileDraft(state, 'alice', draft, { object: { hypotheses: [0] } })
  assert.deepEqual(unchanged.objects.alice?.confirmedFacts, [])
  assert.equal(unchanged.objects.alice?.hypotheses[0]?.value, '可能偏好低频联系')
  const selected = applyRelationshipProfileDraft(state, 'alice', draft, { object: { confirmedFacts: [0] } })
  assert.deepEqual(selected.objects.alice?.confirmedFacts, ['明确说过周末有空'])
  assert.deepEqual(selected.objects.alice?.hypotheses, [])
})

test('关系画像草稿支持全量覆盖、统计和报告字段', () => {
  const draft = {
    coverage: { totalMessages: 120, analyzedMessages: 120, truncated: false },
    statistics: { totalMessages: 120, myMessages: 60, objectMessages: 60, myInitiations: 8, objectInitiations: 6, replyCount: 90, replyRate: 1.5, conversationSegments: 12, dailyActivity: [], weeklyActivity: [], messageTypes: { 文本: 100 }, topKeywords: [] },
    report: { facts: [], hypotheses: [], unknowns: [], recommendation: undefined, nextAction: undefined, stopCondition: undefined },
    evidence: [], user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] }, object: { confirmedFacts: [], hypotheses: [], keyEvents: [] }, relationship: {}
  }
  assert.equal(draft.coverage.totalMessages, 120)
  assert.equal(draft.statistics.conversationSegments, 12)
  assert.deepEqual(draft.report.facts, [])
})

test('审核我的画像仅写入当前关系；跨联系人、未授权、暂停时拒绝写入', () => {
  const state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  const field = { value: '面对 Alice 喜欢幽默', confidence: 'medium' as const, evidenceIds: ['m1'], quotes: ['哈哈'] }
  const draft: RelationshipProfileDraft = { ...draftMetadata(), user: { communicationPreferences: [field], strengths: [], limitations: [], boundaries: [] }, object: { confirmedFacts: [], hypotheses: [], keyEvents: [] }, relationship: {} }
  const next = applyRelationshipProfileDraft(state, 'alice', draft, { user: { communicationPreferences: [0] } })
  assert.deepEqual(next.user.communicationPreferences, [])
  assert.deepEqual(next.objects.alice.selfProfile?.communicationPreferences, [field.value])
  assert.match(buildRelationshipMemoryContext(next, 'alice'), /面对 Alice 喜欢幽默/)
  assert.doesNotMatch(buildRelationshipMemoryContext(next, 'bob'), /面对 Alice 喜欢幽默/)
  assert.equal(applyRelationshipProfileDraft(state, 'bob', draft, { user: { communicationPreferences: [0] } }), state)
  const disabled = { ...state, memoryEnabled: false }
  assert.equal(applyRelationshipProfileDraft(disabled, 'alice', draft, { user: { communicationPreferences: [0] } }), disabled)
  const paused = { ...state, memoryPaused: true }
  assert.equal(applyRelationshipProfileDraft(paused, 'alice', draft, { user: { communicationPreferences: [0] } }), paused)
})

test('过期关系策略不会作为当前目标注入', () => {
  const state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', { relationship: { role: '朋友', goal: '旧目标', expiresAt: Date.now() - 1 } })
  const context = buildRelationshipMemoryContext(state, 'alice')
  assert.match(context, /策略已过期/)
  assert.doesNotMatch(context, /旧目标/)
})

test('回复反馈和分析检查点按联系人隔离，并进入后续关系上下文', () => {
  let state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  state = addRelationshipReplyOutcome(state, 'alice', {
    id: 'reply-1', suggestionId: 'suggestion-1', mode: 'caring', draft: '等你方便时再聊', outcome: '积极回应', createdAt: 100
  })
  state = setRelationshipAnalysisCheckpoint(state, 'alice', {
    lastMessageId: 'm-123', lastMessageAt: 200, totalMessages: 88, analyzedAt: 300
  })
  assert.equal(state.objects.alice?.replyOutcomes?.[0]?.outcome, '积极回应')
  assert.equal(state.objects.alice?.analysisCheckpoint?.lastMessageId, 'm-123')
  const aliceContext = buildRelationshipMemoryContext(state, 'alice')
  assert.match(aliceContext, /积极回应/)
  assert.match(aliceContext, /等你方便时再聊/)
  assert.doesNotMatch(buildRelationshipMemoryContext(state, 'bob'), /等你方便时再聊/)
  assert.equal(state.objects.bob, undefined)
})

test('待审核消息积压是独立的运行状态，保留0、校验数值且不进入回复背景', () => {
  let state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', { object: { displayLabel: 'Alice' } })
  const profileTime = state.objects.alice.updatedAt
  state = setRelationshipAutomaticDraftStatus(state, 'alice', { state: 'waiting_review', queuedNewMessages: 0, queuedCheckedAt: 100, pendingReviewTaskId: 'task-a', updatedAt: 100 })
  let restored = normalizeRelationshipState(JSON.parse(JSON.stringify(state)))
  assert.equal(restored.objects.alice.automaticDraftStatus?.queuedNewMessages, 0)
  assert.equal(restored.objects.alice.automaticDraftStatus?.queuedCheckedAt, 100)
  assert.equal(restored.objects.alice.automaticDraftStatus?.pendingReviewTaskId, 'task-a')
  assert.equal(restored.objects.alice.updatedAt, profileTime)
  assert.doesNotMatch(buildRelationshipMemoryContext(restored, 'alice'), /task-a|积压|新增消息/)
  const raw = JSON.parse(JSON.stringify(state))
  raw.objects.alice.automaticDraftStatus.queuedNewMessages = -5.2
  raw.objects.alice.automaticDraftStatus.queuedCheckedAt = null
  restored = normalizeRelationshipState(raw)
  assert.equal(restored.objects.alice.automaticDraftStatus?.queuedNewMessages, 0)
  assert.equal(restored.objects.alice.automaticDraftStatus?.queuedCheckedAt, undefined)
})

test('自动更新状态按联系人持久化但不改变长期记忆版本内容', () => {
  let state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  state = upsertRelationshipProfile(state, 'alice', { object: { displayLabel: 'Alice', automaticDraftUpdates: true } })
  const objectUpdatedAt = state.objects.alice?.updatedAt
  const stateUpdatedAt = state.updatedAt
  const revisionBefore = JSON.stringify([state.objects.alice?.displayLabel, state.objects.alice?.confirmedFacts, state.relationships.alice])
  state = setRelationshipAutomaticDraftStatus(state, 'alice', { state: 'failed', lastCheckedAt: 10, lastError: '网络超时', updatedAt: 10 })
  assert.equal(state.objects.alice?.automaticDraftStatus?.state, 'failed')
  assert.equal(state.objects.alice?.automaticDraftStatus?.lastError, '网络超时')
  assert.equal(state.objects.alice?.updatedAt, objectUpdatedAt)
  assert.equal(state.updatedAt, stateUpdatedAt)
  assert.equal(JSON.stringify([state.objects.alice?.displayLabel, state.objects.alice?.confirmedFacts, state.relationships.alice]), revisionBefore)
  assert.equal(state.objects.bob, undefined)
})

test('回复反馈按建议 ID 保留状态及文本历史；不跨联系人', () => {
  let state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  state = addRelationshipReplyOutcome(state, 'alice', { id: 'one', suggestionId: 's1', draft: '收到', outcome: '积极回应', createdAt: 1 })
  state = addRelationshipReplyOutcome(state, 'alice', { id: 'two', suggestionId: 's1', draft: '好呀', outcome: '发送后积极回应', createdAt: 2 })
  assert.equal(state.objects.alice?.replyOutcomes?.length, 1)
  assert.equal(state.objects.alice?.replyOutcomes?.[0].outcome, '发送后积极回应')
  assert.deepEqual(state.objects.alice?.replyOutcomes?.[0].history?.map((item) => item.outcome), ['积极回应', '发送后积极回应'])
  assert.deepEqual(state.objects.alice?.replyOutcomes?.[0].history?.map((item) => item.draft), ['收到', '好呀'])
  state = addRelationshipReplyOutcome(state, 'alice', { suggestionId: 's1', id: 'two', draft: '下周再说', outcome: '发送后积极回应', createdAt: 2 })
  assert.deepEqual(state.objects.alice?.replyOutcomes?.[0].history?.map((item) => item.draft), ['收到', '好呀', '下周再说'], 'same timestamp and status cannot merge different texts')
  const context = buildRelationshipMemoryContext(state, 'alice')
  assert.match(context, /当前记录：发送后积极回应「下周再说」/)
  assert.match(context, /此前记录：积极回应「收到」；发送后积极回应「好呀」/)
  assert.match(context, /已复制不等于已发送/)
  assert.match(context, /不能推断因果或自动学习偏好/)
  assert.doesNotMatch(buildRelationshipMemoryContext(state, 'bob'), /状态轨迹|好呀/)
  state.objects.alice.replyOutcomes![0].history = [{ outcome: '已发送', createdAt: 0 }]
  assert.match(buildRelationshipMemoryContext(state, 'alice'), /旧记录未保存对应文本，不得归因于当前草稿/)
})

test('表达范例须关联当前已确认偏好；历史意图不升级为长期目标，移除偏好后停止注入', () => {
  const value = '面对登山邀约不使用亲昵称呼'
  let state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', {
    object: { selfProfile: { communicationPreferences: [value, ...Array.from({ length: 12 }, (_, i) => `近期偏好${i}`)] }, fieldSources: [
      { field: 'self.communicationPreferences', value, confidence: 'high', evidenceIds: [], quotes: [], reviewedAt: 1, taskId: 'reply:1', expressionExample: { previous: '宝贝去登山吧', approved: '周末去登山吗', feedback: '别叫宝贝' } },
      { field: 'self.communicationPreferences', value: '已移除的偏好', confidence: 'high', evidenceIds: [], quotes: [], reviewedAt: 2, taskId: 'reply:2', expressionExample: { previous: '废弃原文', approved: '废弃范例', feedback: '废弃修改' } }
    ] }, relationship: { goal: '保持朋友关系' }
  })
  state = addRelationshipReplyOutcome(state, 'alice', { id: '1', createdAt: 1, draft: '这周不方便', outcome: '未发送', intent: '本周拒绝见面', revisionFeedback: '不用感叹号' })
  const context = buildRelationshipMemoryContext(state, 'alice', '登山')
  assert.match(context, /这段关系中的沟通偏好：面对登山邀约/)
  assert.match(context, /认可的表达：「周末去登山吗」/)
  assert.doesNotMatch(context, /废弃范例/)
  assert.match(context, /当次意图：本周拒绝见面/)
  assert.match(context, /不是长期目标或已确认偏好/)
  assert.match(context, /当前目标：保持朋友关系/)
  assert.doesNotMatch(buildRelationshipMemoryContext(state, 'bob'), /周末去登山|本周拒绝见面/)
  assert.equal(buildRelationshipMemoryContext({ ...state, memoryEnabled: false }, 'alice'), '')
  state = upsertRelationshipProfile(state, 'alice', { object: { selfProfile: { communicationPreferences: [] } } })
  assert.doesNotMatch(buildRelationshipMemoryContext(state, 'alice'), /认可的表达/)
})

test('审核草稿后推进分析检查点，失败或空审核不会推进', () => {
  const state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  const draft: RelationshipProfileDraft = {
    ...draftMetadata(),
    generatedAt: 500,
    coverage: { totalMessages: 12, analyzedMessages: 12, lastMessageAt: 400, lastMessageId: 'm-12', truncated: false },
    user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] },
    object: { confirmedFacts: [], hypotheses: [], keyEvents: [], displayLabel: undefined },
    relationship: {}
  }
  const unchanged = applyRelationshipProfileDraft(state, 'alice', draft, {})
  assert.equal(unchanged.objects.alice, undefined)
  const next = applyRelationshipProfileDraft(state, 'alice', draft, { object: { confirmedFacts: [] } })
  assert.equal(next.objects.alice, undefined)
  assert.equal(applyRelationshipProfileDraft(state, 'alice', draft, { object: { confirmedFacts: [99] } }), state)
  const withApproval: RelationshipProfileDraft = { ...draft, object: { ...draft.object, confirmedFacts: [{ value: '已确认', confidence: 'high', evidenceIds: [], quotes: [] }] } }
  const advanced = applyRelationshipProfileDraft(state, 'alice', withApproval, { object: { confirmedFacts: [0] } })
  assert.equal(advanced.objects.alice?.analysisCheckpoint?.lastMessageId, 'm-12')
  assert.equal(advanced.objects.alice?.analysisCheckpoint?.totalMessages, 12)
})

test('审核保存只保留选中字段的真实证据摘录，反馈修改按建议 ID 去重且受授权约束', () => {
  const state = { ...createEmptyRelationshipState(), memoryEnabled: true }
  const draft: RelationshipProfileDraft = {
    ...draftMetadata(),
    evidence: [{ id: 'm1', localId: 1, createTime: 1, sender: 'Alice', quote: '周六有空' }],
    user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] },
    object: { confirmedFacts: [{ value: '周六有空', confidence: 'high', evidenceIds: ['m1', 'fake'], quotes: ['模型编造的原文'] }], hypotheses: [], keyEvents: [] }, relationship: {}
  }
  const saved = applyRelationshipProfileDraft(state, 'alice', draft, { object: { confirmedFacts: [0] } })
  assert.deepEqual(saved.objects.alice.fieldSources?.[0].evidenceIds, ['m1'])
  assert.deepEqual(saved.objects.alice.fieldSources?.[0].quotes, ['周六有空'])
  const outcome = { id: 'first', suggestionId: 'suggestion1', draft: '收到', outcome: '未回应', createdAt: 1 }
  const first = addRelationshipReplyOutcome(saved, 'alice', outcome)
  const corrected = addRelationshipReplyOutcome(first, 'alice', { ...outcome, id: 'second', outcome: '积极回应' })
  assert.equal(corrected.objects.alice.replyOutcomes?.length, 1)
  assert.equal(corrected.objects.alice.replyOutcomes?.[0].outcome, '积极回应')
  const paused = { ...saved, memoryPaused: true }
  assert.equal(addRelationshipReplyOutcome(paused, 'alice', outcome), paused)
  const revoked = { ...saved, memoryEnabled: false }
  assert.equal(addRelationshipReplyOutcome(revoked, 'alice', outcome), revoked)
})

test('冲突字段只在审批后替换旧值；当前目标和边界优先保留并检索相关事件', () => {
  let state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', {
    object: { confirmedFacts: ['以前周末休息'], selfProfile: { boundaries: ['不接受工作时反复追问'], communicationPreferences: ['对 Alice 简洁直接'] } },
    relationship: { role: '朋友', goal: '保持朋友关系', stopCondition: '明确拒绝后停止' },
    user: { strengths: Array.from({ length: 20 }, () => '很长的全局特点'.repeat(100)) }
  })
  state = addRelationshipEvent(state, 'alice', { id: 'older', summary: '讨论登山安排', occurredAt: '2025-01-01' })
  for (let i = 0; i < 8; i++) state = addRelationshipEvent(state, 'alice', { id: `new-${i}`, summary: `其他事件${i}`, occurredAt: '2026-10-01' })
  const field = { value: '现在周末需要加班', replacesValue: '以前周末休息', confidence: 'high' as const, evidenceIds: [], quotes: [] }
  const draft: RelationshipProfileDraft = { ...draftMetadata(), user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] }, object: { confirmedFacts: [field], hypotheses: [], keyEvents: [] }, relationship: {} }
  assert.equal(applyRelationshipProfileDraft(state, 'alice', draft, {}), state)
  const next = applyRelationshipProfileDraft(state, 'alice', draft, { object: { confirmedFacts: [0] } })
  assert.deepEqual(next.objects.alice.confirmedFacts, ['现在周末需要加班'])
  const context = buildRelationshipMemoryContext(next, 'alice', '登山')
  assert.match(context, /保持朋友关系/)
  assert.match(context, /不接受工作时反复追问/)
  assert.match(context, /讨论登山安排/)
  assert.ok(context.indexOf('保持朋友关系') < context.indexOf('很长的全局特点'))
})

test('所有明确边界完整注入；预算不足时拒绝生成而非忽略边界', () => {
  const globalBoundaries = Array.from({ length: 8 }, (_, index) => `全局限制${index}：不得透露地址`)
  const selfBoundaries = Array.from({ length: 8 }, (_, index) => `当前关系限制${index}：不反复追问`)
  const state = upsertRelationshipProfile({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', {
    user: { boundaries: globalBoundaries }, object: { selfProfile: { boundaries: selfBoundaries } }
  })
  const context = buildRelationshipMemoryContext(state, 'alice')
  for (const boundary of [...globalBoundaries, ...selfBoundaries]) assert.ok(context.includes(boundary))
  assert.doesNotMatch(buildRelationshipMemoryContext(state, 'bob'), /当前关系限制/)
  const tooLarge = upsertRelationshipProfile(state, 'alice', { user: { boundaries: ['超长限制'.repeat(2000)] } })
  assert.throws(() => buildRelationshipMemoryContext(tooLarge, 'alice'), /不会忽略任何边界/)
})

test('推测生命周期：默认30天有效、否定与过期不注入、确认事实须用户审核', () => {
  let state = addRelationshipHypothesis({ ...createEmptyRelationshipState(), memoryEnabled: true }, 'alice', '最近忙于工作', 'medium')
  const initial = state.objects.alice.hypotheses[0]
  assert.equal(initial.status, 'active')
  assert.equal(initial.expiresAt! - initial.updatedAt!, 30 * 24 * 3600 * 1000)
  assert.equal(relationshipHypothesisStatus(initial, initial.expiresAt! + 1), 'expired')
  assert.match(buildRelationshipMemoryContext(state, 'alice'), /最近忙于工作/)
  const refuted = reviewRelationshipHypothesis(state, 'alice', initial.value, 'refuted')
  assert.equal(buildRelationshipMemoryContext(refuted, 'alice').split('\n').find((line) => line.startsWith('暂定推测')), undefined)
  assert.match(buildRelationshipMemoryContext(refuted, 'alice'), /用户已否定的旧解释.*最近忙于工作/)
  assert.equal(refuted.objects.alice.confirmedFacts.length, 0)
  const expired = reviewRelationshipHypothesis(state, 'alice', initial.value, 'expired')
  assert.doesNotMatch(buildRelationshipMemoryContext(expired, 'alice'), /最近忙于工作/)
  const renewed = reviewRelationshipHypothesis(expired, 'alice', initial.value, 'active')
  assert.match(buildRelationshipMemoryContext(renewed, 'alice'), /最近忙于工作/)
  const confirmed = reviewRelationshipHypothesis(state, 'alice', initial.value, 'confirmed')
  assert.deepEqual(confirmed.objects.alice.confirmedFacts, [initial.value])
  assert.equal(confirmed.objects.alice.hypotheses[0].status, 'confirmed')
  const corrected = reviewRelationshipHypothesis(confirmed, 'alice', initial.value, 'refuted')
  assert.equal(corrected.objects.alice.confirmedFacts.length, 0)
  assert.equal(corrected.objects.alice.hypotheses[0].status, 'refuted')
  assert.equal(reviewRelationshipHypothesis(state, 'bob', initial.value, 'confirmed'), state)
  assert.equal(reviewRelationshipHypothesis({ ...state, memoryPaused: true }, 'alice', initial.value, 'confirmed').objects.alice.confirmedFacts.length, 0)
  assert.equal(reviewRelationshipHypothesis(state, 'alice', initial.value, 'active', Date.now() - 1), state)
  for (let i = 0; i < 6; i++) state = addRelationshipHypothesis(state, 'alice', `新推测${i}`)
  assert.equal(state.objects.alice.hypotheses.length, 5)
})
