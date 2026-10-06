import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { ConfigService } from './config'
import { REPLY_MODES } from './replyAssistantCore'
import {
  createEmptyRelationshipState,
  normalizeRelationshipState,
  upsertRelationshipProfile,
  addRelationshipEvent,
  addConfirmedFact,
  addRelationshipHypothesis,
  addRelationshipReplyOutcome,
  removeConfirmedFact,
  removeRelationshipHypothesis,
  buildRelationshipMemoryContext,
  selectRelationshipHistoricalMemory,
  applyRelationshipProfileDraft,
  reviewRelationshipHypothesis,
  relationshipDraftFields,
  type RelationshipDraftDecision,
  type RelationshipProfileState,
  type RelationshipStrategy,
  type UserRelationshipProfile,
  type ObjectRelationshipProfile,
  type RelationshipProfileDraft,
  type RelationshipDraftApprovals,
  type RelationshipHypothesisStatus,
  type RelationshipAnalysisCheckpoint,
  type RelationshipAnalysisHistoryEntry,
  type RelationshipAnalysisReport,
  type RelationshipMemoryVersion,
  type RelationshipMemoryArchive,
  type RelationshipAutomaticDraftStatus,
  setRelationshipAutomaticDraftStatus
} from './relationshipProfileCore'

type PendingReview = { draft: RelationshipProfileDraft; selection: Record<string, boolean>; decisions?: Record<string, RelationshipDraftDecision> }
type ReportRecovery = { fingerprint: string; report: RelationshipAnalysisReport; savedAt: number; evidence?: RelationshipProfileDraft['evidence'] }
type MemoryHistory = { versions: RelationshipMemoryVersion[]; archives: RelationshipMemoryArchive[] }
type StoreShape = { version: 1; scopes: Record<string, RelationshipProfileState>; reviews?: Record<string, Record<string, PendingReview>>; analyses?: Record<string, Record<string, RelationshipAnalysisHistoryEntry[]>>; recoveries?: Record<string, Record<string, ReportRecovery>>; memories?: Record<string, Record<string, MemoryHistory>> }

export class RelationshipProfileService {
  private loaded = false
  private store: StoreShape = { version: 1, scopes: {} }
  private filePath: string | null = null

  private resolveFilePath(): string {
    if (this.filePath) return this.filePath
    const configured = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    const userDataPath = configured || app?.getPath?.('userData') || process.cwd()
    fs.mkdirSync(userDataPath, { recursive: true })
    this.filePath = path.join(userDataPath, 'weflow-relationship-profiles.json')
    return this.filePath
  }

  private scopeKey(): string {
    const config = ConfigService.getInstance()
    const myWxid = String(config.getMyWxidCleaned() || '').trim()
    if (myWxid) return `wxid:${myWxid}`
    const dbPath = String(config.get('dbPath') || '').trim()
    return dbPath ? `db:${createHash('sha1').update(dbPath).digest('hex').slice(0, 16)}` : 'default'
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.resolveFilePath(), 'utf-8')) as Partial<StoreShape>
      if (raw && typeof raw === 'object' && raw.scopes && typeof raw.scopes === 'object' && !Array.isArray(raw.scopes)) {
        this.store = { version: 1, scopes: raw.scopes as Record<string, RelationshipProfileState>, reviews: raw.reviews || {}, analyses: raw.analyses || {}, recoveries: raw.recoveries || {}, memories: raw.memories || {} }
      } else throw new Error('关系档案文件结构损坏，请先恢复备份')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.store = { version: 1, scopes: {} }
    }
    this.loaded = true
  }

  private persist(): void {
    const target = this.resolveFilePath()
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(this.store, null, 2), 'utf-8')
    fs.renameSync(`${target}.tmp`, target)
  }

  private currentState(): RelationshipProfileState {
    this.ensureLoaded()
    return normalizeRelationshipState(this.store.scopes[this.scopeKey()])
  }

  private saveState(state: RelationshipProfileState, clearReviews?: string[] | 'all', reviewOutcome?: { sessionId: string; draft: RelationshipProfileDraft; approvals: RelationshipDraftApprovals; decisions?: Record<string, RelationshipDraftDecision>; remaining?: PendingReview }, reason = '档案更新'): RelationshipProfileState {
    this.ensureLoaded()
    const scope = this.scopeKey()
    const previous = this.store
    const before = normalizeRelationshipState(previous.scopes[scope])
    const memories = clearReviews === 'all' ? {} : { ...previous.memories?.[scope] }
    if (Array.isArray(clearReviews) && !reviewOutcome) for (const id of clearReviews) delete memories[id]
    for (const [sessionId, object] of Object.entries(state.objects)) {
      const old = before.objects[sessionId] || { sessionId, confirmedFacts: [], hypotheses: [], keyEvents: [], updatedAt: 0 }
      if (JSON.stringify(this.memoryContent(before, sessionId)) === JSON.stringify(this.memoryContent(state, sessionId))) continue
      const history = memories[sessionId] || { versions: [], archives: [] }
      const archives = new Map(history.archives.map((entry) => [entry.id, entry]))
      const archive = (field: RelationshipMemoryArchive['field'], value: string, event?: RelationshipMemoryArchive['event']) => {
        const id = createHash('sha256').update(JSON.stringify([field, value, event])).digest('hex')
        const currentValues = field === 'confirmedFacts' ? object.confirmedFacts : field === 'keyEvents' ? object.keyEvents.map((item) => item.summary) : object.selfProfile?.[field] || []
        const proposal = reviewOutcome && (field === 'confirmedFacts' ? reviewOutcome.draft.object.confirmedFacts : field === 'keyEvents' ? [] : reviewOutcome.draft.user[field])
        const approvedIndexes = reviewOutcome && (field === 'confirmedFacts' ? reviewOutcome.approvals.object?.confirmedFacts : field === 'keyEvents' ? [] : reviewOutcome.approvals.user?.[field])
        const replaced = proposal && approvedIndexes?.some((index) => proposal[index]?.replacesValue === value)
          || field === 'keyEvents' && object.keyEvents.some((item) => item.id === event?.id)
        const capacity = !replaced && field !== 'boundaries' && currentValues.length === 20
          && (reason === '确认事实' && field === 'confirmedFacts' || reason === '添加关键事件' && field === 'keyEvents'
            || reason === '确认关系专属表达偏好' && field === 'communicationPreferences' || Boolean(reviewOutcome && (field === 'keyEvents' ? reviewOutcome.approvals.object?.keyEvents?.length : approvedIndexes?.length)))
        const source = old.fieldSources?.find((entry) => entry.value === value)
        archives.set(id, { id, field, value, event, archivedAt: Date.now(), reason: capacity ? 'capacity' : 'removed',
          source: field === 'communicationPreferences' && old.selfProfile?.communicationPreferenceModes?.[value]
            ? { field: `self.${field}`, value, confidence: 'high', evidenceIds: [], quotes: [], reviewedAt: Date.now(), taskId: '', ...source, replyMode: old.selfProfile.communicationPreferenceModes[value] } : source })
      }
      for (const value of old.confirmedFacts) if (!object.confirmedFacts.includes(value)) archive('confirmedFacts', value)
      for (const event of old.keyEvents) if (!object.keyEvents.some((item) => item.id === event.id && item.summary === event.summary && item.occurredAt === event.occurredAt)) archive('keyEvents', event.summary, event)
      for (const field of ['communicationPreferences', 'strengths', 'limitations', 'boundaries'] as const) {
        for (const value of old.selfProfile?.[field] || []) if (!object.selfProfile?.[field]?.includes(value)) archive(field, value)
      }
      // ponytail: last 50 snapshots for rollback; compact removed facts/events remain archived without a 20-item truncation.
      memories[sessionId] = { versions: [...history.versions, { id: randomUUID(), createdAt: Date.now(), reason: reviewOutcome ? '审核 AI 草稿' : reason,
        object: old, relationship: before.relationships[sessionId] }].slice(-50), archives: Array.from(archives.values()) }
    }
    const reviews = clearReviews === 'all' ? {} : { ...previous.reviews?.[scope] }
    if (Array.isArray(clearReviews)) for (const sessionId of clearReviews) delete reviews[sessionId]
    if (reviewOutcome?.remaining) reviews[reviewOutcome.sessionId] = reviewOutcome.remaining
    const analyses = clearReviews === 'all' ? {} : { ...previous.analyses?.[scope] }
    const recoveries = clearReviews === 'all' ? {} : { ...previous.recoveries?.[scope] }
    if (Array.isArray(clearReviews)) for (const sessionId of clearReviews) delete recoveries[sessionId]
    if (Array.isArray(clearReviews) && !reviewOutcome) for (const sessionId of clearReviews) delete analyses[sessionId]
    if (reviewOutcome) {
      const { sessionId, draft, approvals } = reviewOutcome
      const history = analyses[sessionId] || []
      const oldApprovals = history.find((entry) => entry.draft.taskId === draft.taskId)?.approvals
      const cumulative: RelationshipDraftApprovals = { user: { ...oldApprovals?.user }, object: { ...oldApprovals?.object }, relationship: { ...oldApprovals?.relationship, ...approvals.relationship } }
      for (const key of ['communicationPreferences', 'strengths', 'limitations', 'boundaries'] as const) cumulative.user![key] = Array.from(new Set([...(oldApprovals?.user?.[key] || []), ...(approvals.user?.[key] || [])]))
      for (const key of ['confirmedFacts', 'hypotheses', 'keyEvents'] as const) cumulative.object![key] = Array.from(new Set([...(oldApprovals?.object?.[key] || []), ...(approvals.object?.[key] || [])]))
      cumulative.object!.displayLabel = Boolean(oldApprovals?.object?.displayLabel || approvals.object?.displayLabel)
      analyses[sessionId] = [...history.filter((entry) => entry.draft.taskId !== draft.taskId), { draft, status: 'accepted' as const, reviewedAt: Date.now(), approvals: cumulative, decisions: reviewOutcome.decisions }].slice(-20)
    }
    this.store = { ...previous, scopes: { ...previous.scopes, [scope]: normalizeRelationshipState(state) }, reviews: { ...previous.reviews, [scope]: reviews }, analyses: { ...previous.analyses, [scope]: analyses }, recoveries: { ...previous.recoveries, [scope]: recoveries }, memories: { ...previous.memories, [scope]: memories } }
    try { this.persist() } catch (error) { this.store = previous; throw error }
    return this.store.scopes[scope]
  }

  getAccountScope(): string {
    return this.scopeKey()
  }

  assertAccountScope(expectedScope: string): void {
    if (!expectedScope || expectedScope !== this.scopeKey()) throw new Error('账号已切换，请重新打开关系档案后再操作')
  }

  getState(): { success: boolean; accountScope: string; state: RelationshipProfileState } {
    return { success: true, accountScope: this.scopeKey(), state: this.currentState() }
  }

  getMemoryContext(sessionId: string, query = ''): string {
    return this.getReplyMemoryContext(sessionId, query).context
  }

  getReplyMemoryContext(sessionId: string, query = '', replyMode?: string) {
    const state = this.currentState()
    let context = buildRelationshipMemoryContext(state, sessionId, query, replyMode)
    const candidates = selectRelationshipHistoricalMemory(state, sessionId, this.store.memories?.[this.scopeKey()]?.[sessionId]?.archives || [], query, replyMode)
    const historicalMemory: typeof candidates = []
    const header = '\n【历史归档背景：仅作历史回顾，不是当前事实、偏好或意愿；不恢复旧边界，也不能覆盖当前意图。需重新审核才能写回当前档案】'
    for (const entry of candidates) {
      const value = { ...entry, expressionExample: entry.expressionExample ? { previous: entry.expressionExample.previous.slice(0, 100), approved: entry.expressionExample.approved.slice(0, 120), feedback: entry.expressionExample.feedback.slice(0, 100) } : undefined }
      const line = `\n${JSON.stringify(value)}`
      // Keep complete records within the shared budget without trimming any explicit current boundaries.
      if (context.length + line.length + (historicalMemory.length ? 0 : header.length) > 6000) continue
      context += `${historicalMemory.length ? '' : header}${line}`
      historicalMemory.push(value)
    }
    return { context, historicalMemory }
  }

  getMemoryRevision(sessionId: string): string {
    return this.memoryRevision(this.currentState(), sessionId)
  }

  setAutomaticDraftStatus(sessionId: string, status: RelationshipAutomaticDraftStatus, accountScope: string): { success: boolean; state: RelationshipProfileState } {
    this.assertAccountScope(accountScope)
    const state = this.currentState()
    if (!sessionId || !state.objects[sessionId]) return { success: false, state }
    // Operational status is intentionally not persisted through saveState: it must not
    // create a memory version or change the revision guarded by an open draft.
    const next = setRelationshipAutomaticDraftStatus(state, sessionId, status)
    this.ensureLoaded()
    const previous = this.store
    this.store = { ...previous, scopes: { ...previous.scopes, [this.scopeKey()]: next } }
    try { this.persist() } catch (error) { this.store = previous; throw error }
    return { success: true, state: next }
  }

  private memoryRevision(state: RelationshipProfileState, sessionId: string): string {
    return createHash('sha256').update(JSON.stringify([state.user, this.memoryContent(state, sessionId)])).digest('hex')
  }

  private memoryContent(state: RelationshipProfileState, sessionId: string) {
    const object = state.objects[sessionId]
    if (!object) return [null, state.relationships[sessionId]]
    const { updatedAt: _updated, automaticDraftUpdates: _automatic, automaticDraftStatus: _automaticStatus, analysisCheckpoint: _checkpoint, replyOutcomes: _outcomes, ...content } = object
    return [content, state.relationships[sessionId]]
  }

  getMemoryHistory(sessionId: string, accountScope: string) {
    this.assertAccountScope(accountScope)
    const state = this.currentState()
    const history = this.store.memories?.[accountScope]?.[sessionId]
    return { success: true, revision: this.memoryRevision(state, sessionId), versions: (history?.versions || []).slice().reverse(), archives: (history?.archives || []).slice().reverse() }
  }

  restoreMemory(input: { accountScope: string; sessionId: string; revision: string; kind: 'version' | 'archive'; id: string }): { success: boolean; state: RelationshipProfileState; message: string } {
    this.assertAccountScope(input.accountScope)
    const state = this.currentState()
    if (!state.memoryEnabled || state.memoryPaused) return { success: false, state, message: '请先启用并恢复长期关系档案' }
    if (!input.sessionId || input.sessionId.endsWith('@chatroom') || !state.objects[input.sessionId]) return { success: false, state, message: '当前联系人档案不存在' }
    if (this.memoryRevision(state, input.sessionId) !== input.revision) return { success: false, state, message: '档案已变化，请刷新历史并重新确认恢复' }
    const history = this.store.memories?.[input.accountScope]?.[input.sessionId]
    let next = state
    if (input.kind === 'version') {
      const version = history?.versions.find((entry) => entry.id === input.id)
      if (!version) return { success: false, state, message: '历史版本不存在' }
      const current = state.objects[input.sessionId]
      next = { ...state, objects: { ...state.objects, [input.sessionId]: { ...version.object, sessionId: input.sessionId,
        automaticDraftUpdates: current.automaticDraftUpdates, automaticDraftStatus: current.automaticDraftStatus, analysisCheckpoint: current.analysisCheckpoint, replyOutcomes: current.replyOutcomes, updatedAt: Date.now() } },
        relationships: { ...state.relationships, [input.sessionId]: { ...version.relationship, updatedAt: Date.now() } }, updatedAt: Date.now() }
    } else if (input.kind === 'archive') {
      const archived = history?.archives.find((entry) => entry.id === input.id)
      if (!archived) return { success: false, state, message: '归档条目不存在' }
      if (archived.field === 'confirmedFacts') next = addConfirmedFact(state, input.sessionId, archived.value)
      else if (archived.field === 'keyEvents' && archived.event) next = addRelationshipEvent(state, input.sessionId, archived.event)
      else if (archived.field !== 'keyEvents') {
        const self = state.objects[input.sessionId].selfProfile
        const values = Array.from(new Set([...(self?.[archived.field] || []), archived.value]))
        const communicationPreferenceModes = { ...self?.communicationPreferenceModes }
        if (archived.field === 'communicationPreferences') {
          if (archived.source?.replyMode) communicationPreferenceModes[archived.value] = archived.source.replyMode
          else delete communicationPreferenceModes[archived.value]
        }
        next = upsertRelationshipProfile(state, input.sessionId, { object: { selfProfile: { ...self, communicationPreferenceModes, [archived.field]: archived.field === 'boundaries' ? values : values.slice(-20) } } })
      }
    } else return { success: false, state, message: '恢复类型无效' }
    if (input.kind === 'archive') {
      const source = history?.archives.find((entry) => entry.id === input.id)?.source
      if (source) next = upsertRelationshipProfile(next, input.sessionId, { object: { fieldSources: [...(next.objects[input.sessionId].fieldSources || []).filter((entry) => entry.field !== source.field || entry.value !== source.value), { ...source, reviewedAt: Date.now() }].slice(-80) } })
    }
    return { success: true, state: this.saveState(next, undefined, undefined, input.kind === 'version' ? '恢复旧版本前的档案' : '恢复归档条目前的档案'), message: '已恢复当前关系的记忆；自动更新设置和分析检查点保持不变' }
  }

  getAnalysisHistory(sessionId: string): { success: boolean; entries: RelationshipAnalysisHistoryEntry[] } {
    this.ensureLoaded()
    const scope = this.scopeKey()
    return { success: true, entries: (this.store.analyses?.[scope]?.[sessionId] || [])
      .filter((entry) => entry.draft?.sessionId === sessionId && entry.draft.accountScope === scope).slice().sort((a, b) => b.draft.generatedAt - a.draft.generatedAt) }
  }

  getProcessedCheckpoint(sessionId: string): RelationshipAnalysisCheckpoint | undefined {
    // 只有用户提交审核后的分析才算已处理；待审核、丢弃或被替代的草稿不能推进增量边界。
    const latest = this.getAnalysisHistory(sessionId).entries.find((entry) => entry.status === 'accepted')?.draft
    if (!latest) return undefined
    return { totalMessages: latest.coverage.totalMessages, analyzedAt: latest.generatedAt,
      lastMessageAt: latest.coverage.lastMessageAt, lastMessageId: latest.coverage.lastMessageId,
      boundaryMessageIds: latest.coverage.boundaryMessageIds }
  }

  getCompletedAnalysisCheckpoint(sessionId: string): RelationshipAnalysisCheckpoint | undefined {
    // Scheduling progress is independent of memory approval, including discarded drafts.
    const latest = this.getAnalysisHistory(sessionId).entries[0]?.draft
    if (!latest) return undefined
    return { totalMessages: latest.coverage.totalMessages, analyzedAt: latest.generatedAt,
      lastMessageAt: latest.coverage.lastMessageAt, lastMessageId: latest.coverage.lastMessageId,
      boundaryMessageIds: latest.coverage.boundaryMessageIds }
  }

  hasReportRecovery(sessionId: string): boolean {
    this.ensureLoaded()
    const recovery = this.store.recoveries?.[this.scopeKey()]?.[sessionId]
    return Boolean(recovery && Date.now() - recovery.savedAt < 24 * 3600 * 1000)
  }

  getReportRecovery(sessionId: string, fingerprint: string): RelationshipAnalysisReport | undefined {
    this.ensureLoaded()
    const recovery = this.store.recoveries?.[this.scopeKey()]?.[sessionId]
    return recovery && recovery.fingerprint === fingerprint && this.hasReportRecovery(sessionId)
      ? recovery.report : undefined
  }

  getReportRecoveryEvidence(sessionId: string, fingerprint: string): RelationshipProfileDraft['evidence'] {
    this.ensureLoaded()
    return this.getReportRecovery(sessionId, fingerprint) ? this.store.recoveries?.[this.scopeKey()]?.[sessionId]?.evidence || [] : []
  }

  saveReportRecovery(accountScope: string, sessionId: string, fingerprint: string, report: RelationshipAnalysisReport, evidence: RelationshipProfileDraft['evidence'] = []): void {
    this.assertAccountScope(accountScope)
    this.ensureLoaded()
    if (!sessionId || sessionId.endsWith('@chatroom') || !fingerprint) throw new Error('报告恢复信息不完整')
    const previous = this.store
    // ponytail: one report per contact, last eight within 24h; no raw message index persisted.
    const entries = Object.entries(previous.recoveries?.[accountScope] || {})
      .filter(([id, entry]) => id !== sessionId && Date.now() - entry.savedAt < 24 * 3600 * 1000)
      .sort((a, b) => a[1].savedAt - b[1].savedAt).slice(-7)
    const recoveries = Object.fromEntries([...entries, [sessionId, { fingerprint, report, evidence: evidence.slice(0, 48), savedAt: Date.now() }]])
    this.store = { ...previous, recoveries: { ...previous.recoveries, [accountScope]: recoveries } }
    try { this.persist() } catch (error) { this.store = previous; throw error }
  }

  saveGeneratedDraft(draft: RelationshipProfileDraft): { success: boolean } {
    this.ensureLoaded()
    const scope = this.scopeKey()
    if (!draft?.sessionId || draft.accountScope !== scope) throw new Error('草稿与当前账号不一致')
    const previous = this.store
    const history = previous.analyses?.[scope]?.[draft.sessionId] || []
    const entries: RelationshipAnalysisHistoryEntry[] = history.filter((entry) => entry.draft.taskId !== draft.taskId)
      .map((entry) => entry.status === 'pending' ? { ...entry, status: 'superseded' } : entry)
    entries.push({ draft, status: 'pending' })
    const recoveries = { ...previous.recoveries?.[scope] }
    delete recoveries[draft.sessionId]
    this.store = { ...previous,
      reviews: { ...previous.reviews, [scope]: { ...previous.reviews?.[scope], [draft.sessionId]: { draft, selection: {} } } },
      analyses: { ...previous.analyses, [scope]: { ...previous.analyses?.[scope], [draft.sessionId]: entries.slice(-20) } },
      recoveries: { ...previous.recoveries, [scope]: recoveries } }
    try { this.persist() } catch (error) { this.store = previous; throw error }
    return { success: true }
  }

  getRejectedSuggestions(sessionId: string): string[] {
    const decisions = new Map<string, boolean>()
    for (const entry of this.getAnalysisHistory(sessionId).entries.sort((a, b) => (b.reviewedAt || 0) - (a.reviewedAt || 0))) {
      for (const field of relationshipDraftFields(entry.draft)) {
        const decision = entry.decisions?.[field.key]
        if ((decision === 'accepted' || decision === 'rejected') && !decisions.has(field.value)) decisions.set(field.value, decision === 'rejected')
      }
    }
    return Array.from(decisions).filter(([, rejected]) => rejected).map(([value]) => value).slice(0, 40)
  }

  getPendingReview(sessionId: string): { success: boolean; review?: PendingReview } {
    this.ensureLoaded()
    const review = this.store.reviews?.[this.scopeKey()]?.[sessionId]
    return { success: true, review: review?.draft?.sessionId === sessionId && review.draft.accountScope === this.scopeKey() ? review : undefined }
  }

  savePendingReview(input: PendingReview): { success: boolean } {
    this.ensureLoaded()
    const scope = this.scopeKey()
    if (!input?.draft?.sessionId || input.draft.accountScope !== scope) throw new Error('草稿与当前账号不一致')
    this.assertDraftSourceUnchanged(input.draft)
    const previous = this.store
    const existing = previous.reviews?.[scope]?.[input.draft.sessionId]
    if (existing && existing.draft.taskId !== input.draft.taskId) throw new Error('此草稿已被新分析替代，请重新打开审核面板')
    if (!existing && previous.analyses?.[scope]?.[input.draft.sessionId]?.some((entry) => entry.draft.taskId === input.draft.taskId && entry.status !== 'pending')) throw new Error('此草稿已处理，不能重新暂存旧审核内容')
    const decisions: Record<string, RelationshipDraftDecision> = {}
    for (const { key } of relationshipDraftFields(input.draft)) {
      const old = existing?.decisions?.[key]
      const incoming = input.decisions?.[key]
      decisions[key] = old === 'accepted' || old === 'rejected' ? old : incoming === 'accept' || incoming === 'reject' ? incoming : input.selection?.[key] ? 'accept' : 'pending'
    }
    this.assertSettledFieldsUnchanged(existing, input.draft)
    this.store = { ...previous, reviews: { ...previous.reviews, [scope]: { ...previous.reviews?.[scope], [input.draft.sessionId]: { ...input, decisions } } } }
    try { this.persist() } catch (error) { this.store = previous; throw error }
    return { success: true }
  }

  discardPendingReview(sessionId: string): { success: boolean } {
    this.ensureLoaded()
    const scope = this.scopeKey()
    const reviews = { ...this.store.reviews?.[scope] }
    const review = reviews[sessionId]
    delete reviews[sessionId]
    const previous = this.store
    const history = previous.analyses?.[scope]?.[sessionId] || []
    const entries: RelationshipAnalysisHistoryEntry[] = review ? [...history.filter((entry) => entry.draft.taskId !== review.draft.taskId),
      { draft: review.draft, status: 'discarded' as const, reviewedAt: Date.now(), decisions: history.find((entry) => entry.draft.taskId === review.draft.taskId)?.decisions }].slice(-20) : history
    let state = this.currentState()
    const object = state.objects[sessionId]
    if (object?.automaticDraftUpdates || object?.automaticDraftStatus) {
      state = setRelationshipAutomaticDraftStatus(state, sessionId, { state: 'idle', lastCheckedAt: Date.now(), updatedAt: Date.now() })
    }
    this.store = { ...previous, scopes: { ...previous.scopes, [scope]: state }, reviews: { ...previous.reviews, [scope]: reviews }, analyses: { ...previous.analyses, [scope]: { ...previous.analyses?.[scope], [sessionId]: entries } } }
    try { this.persist() } catch (error) { this.store = previous; throw error }
    return { success: true }
  }

  private assertSettledFieldsUnchanged(review: PendingReview | undefined, draft: RelationshipProfileDraft): void {
    if (!review) return
    const fields = new Map(relationshipDraftFields(draft).map((field) => [field.key, field.value]))
    for (const field of relationshipDraftFields(review.draft)) {
      const decision = review.decisions?.[field.key]
      if ((decision === 'accepted' || decision === 'rejected') && fields.get(field.key) !== field.value) throw new Error('已提交的审核项不能在旧草稿中修改，请使用关系档案编辑功能')
    }
  }

  assertDraftSourceUnchanged(draft: RelationshipProfileDraft): void {
    this.assertAccountScope(draft.accountScope)
    const pending = this.getPendingReview(draft.sessionId).review?.draft
    const original = this.getAnalysisHistory(draft.sessionId).entries.find((entry) => entry.draft.taskId === draft.taskId)?.draft
      || (pending?.taskId === draft.taskId ? pending : undefined)
    if (!original && !draft.coverage.sourceFingerprint) return
    if (!original) throw new Error('未找到此分析草稿，请重新分析')
    const source = (item: RelationshipProfileDraft) => {
      const { sourceFingerprint, totalMessages, firstMessageAt, lastMessageAt, lastMessageId, boundaryMessageIds } = item.coverage
      return JSON.stringify([sourceFingerprint, totalMessages, firstMessageAt, lastMessageAt, lastMessageId, boundaryMessageIds, item.evidence])
    }
    if (source(original) !== source(draft)) throw new Error('草稿的分析范围或证据已变化，请重新分析；审核只能修改建议文本')
  }

  private draftDecision(input: Parameters<RelationshipProfileService['applyDraft']>[0], key: string): RelationshipDraftDecision {
    const [field, rawIndex] = key.split(':')
    const index = Number(rawIndex)
    const userField = field as keyof NonNullable<RelationshipDraftApprovals['user']>
    const objectField = field as 'confirmedFacts' | 'hypotheses' | 'keyEvents'
    const relationshipField = rawIndex as keyof NonNullable<RelationshipDraftApprovals['relationship']>
    const approved = field === 'relationship' ? input.approvals?.relationship?.[relationshipField] : key === 'displayLabel'
      ? input.approvals?.object?.displayLabel : input.approvals?.user?.[userField]?.includes(index) || input.approvals?.object?.[objectField]?.includes(index)
    return input.decisions?.[key] ?? (approved ? 'accept' : 'pending')
  }

  hasNewDraftAcceptances(input: Parameters<RelationshipProfileService['applyDraft']>[0]): boolean {
    const current = this.getPendingReview(input.sessionId).review
    return relationshipDraftFields(input.draft).some(({ key }) => {
      const previous = current?.decisions?.[key]
      return previous !== 'accepted' && previous !== 'rejected' && this.draftDecision(input, key) === 'accept'
    })
  }

  addEvent(input: { sessionId: string; id: string; summary: string; occurredAt: string; source?: 'user' | 'model' | 'chat'; evidenceIds?: string[] }): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    if (!state.memoryEnabled) return { success: false, state, message: '请先明确启用长期关系档案' }
    if (state.memoryPaused) return { success: false, state, message: '长期关系档案已暂停更新' }
    const next = addRelationshipEvent(state, input.sessionId, { ...input, source: 'user' })
    if (next === state) return { success: false, state, message: '事件信息不完整' }
    return { success: true, state: this.saveState(next, undefined, undefined, '添加关键事件'), message: '关键事件已保存' }
  }

  confirmFact(sessionId: string, fact: string): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    if (!state.memoryEnabled) return { success: false, state, message: '请先明确启用长期关系档案' }
    if (state.memoryPaused) return { success: false, state, message: '长期关系档案已暂停更新' }
    const next = addConfirmedFact(state, sessionId, fact)
    if (next === state) return { success: false, state, message: '事实内容不能为空' }
    return { success: true, state: this.saveState(next, undefined, undefined, '确认事实'), message: '事实已保存到关系档案' }
  }

  removeFact(sessionId: string, fact: string): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    const next = removeConfirmedFact(state, sessionId, fact)
    if (next === state) return { success: false, state, message: '未找到该事实' }
    return { success: true, state: this.saveState(next, undefined, undefined, '移除当前事实并归档'), message: '事实已从当前档案移除，历史归档仍可恢复' }
  }

  confirmHypothesis(input: { sessionId: string; value: string; confidence?: 'low' | 'medium' | 'high'; evidenceIds?: string[] }): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    if (!state.memoryEnabled) return { success: false, state, message: '请先明确启用长期关系档案' }
    if (state.memoryPaused) return { success: false, state, message: '长期关系档案已暂停更新' }
    const next = addRelationshipHypothesis(state, input.sessionId, input.value, input.confidence, input.evidenceIds)
    if (next === state) return { success: false, state, message: '推测内容不能为空' }
    return { success: true, state: this.saveState(next), message: '推测已保存，并标记为暂定' }
  }

  recordReplyOutcome(input: { sessionId: string; accountScope: string; id?: string; suggestionId?: string; mode?: string; draft: string; outcome: string; originalDraft?: string; intent?: string; revisionFeedback?: string }): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    if (input?.accountScope !== this.scopeKey()) return { success: false, state, message: '回复建议来自其他账号，请重新生成' }
    if (!state.memoryEnabled) return { success: false, state, message: '请先明确启用长期关系档案' }
    if (state.memoryPaused) return { success: false, state, message: '长期关系档案已暂停更新' }
    const allowedOutcomes = new Set(['积极回应', '含糊回应', '未回应', '未发送', '已发送', '已复制', '发送后积极回应', '发送后含糊回应'])
    const outcome = String(input.outcome || '').trim()
    if (!allowedOutcomes.has(outcome)) return { success: false, state, message: '回复结果类型无效，请重新选择' }
    const next = addRelationshipReplyOutcome(state, input.sessionId, {
      id: input.id || `reply-${Date.now()}`,
      suggestionId: input.suggestionId,
      mode: input.mode,
      draft: input.draft,
      outcome,
      originalDraft: input.originalDraft,
      intent: input.intent,
      revisionFeedback: input.revisionFeedback,
      createdAt: Date.now()
    })
    if (next === state) return { success: false, state, message: '回复反馈信息不完整' }
    return { success: true, state: this.saveState(next), message: '回复反馈已记录，将用于当前关系的后续建议' }
  }

  confirmReplyPreference(input: { accountScope: string; sessionId: string; value: string; suggestionId: string; feedback: string; replyMode?: string; expressionExample?: { previous: string; approved: string } }): { success: boolean; state: RelationshipProfileState; message: string } {
    this.assertAccountScope(input.accountScope)
    const state = this.currentState()
    if (!state.memoryEnabled || state.memoryPaused) return { success: false, state, message: '请先启用并恢复长期关系档案' }
    const value = typeof input.value === 'string' ? input.value.trim().slice(0, 200) : ''
    if (!input.sessionId || input.sessionId.endsWith('@chatroom') || !value || !input.suggestionId || !input.feedback?.trim()) return { success: false, state, message: '表达偏好或修改依据不完整' }
    if (input.replyMode !== undefined && !(REPLY_MODES as readonly unknown[]).includes(input.replyMode)) return { success: false, state, message: '表达偏好的适用模式无效，本次未保存' }
    const previous = typeof input.expressionExample?.previous === 'string' ? input.expressionExample.previous.trim().slice(0, 500) : ''
    const approved = typeof input.expressionExample?.approved === 'string' ? input.expressionExample.approved.trim().slice(0, 240) : ''
    if (input.expressionExample && (!previous || !approved)) return { success: false, state, message: '表达范例缺少修改前或你认可的文本，不会保存' }
    const object = state.objects[input.sessionId]
    const communicationPreferenceModes = { ...object?.selfProfile?.communicationPreferenceModes }
    if (input.replyMode) communicationPreferenceModes[value] = input.replyMode
    else delete communicationPreferenceModes[value]
    const selfProfile = { ...object?.selfProfile, communicationPreferences: Array.from(new Set([...(object?.selfProfile?.communicationPreferences || []), value])).slice(-20), communicationPreferenceModes }
    const fieldSources = [...(object?.fieldSources || []).filter((entry) => !['user.communicationPreferences', 'self.communicationPreferences'].includes(entry.field) || entry.value !== value), {
      field: 'self.communicationPreferences', value, confidence: 'high' as const, evidenceIds: [], quotes: [], reviewedAt: Date.now(), taskId: `reply:${input.suggestionId}`,
      replyMode: input.replyMode,
      expressionExample: previous && approved ? { previous, approved, feedback: input.feedback.trim().slice(0, 300) } : undefined
    }].slice(-80)
    const next = upsertRelationshipProfile(state, input.sessionId, { object: { selfProfile, fieldSources } })
    return { success: true, state: this.saveState(next, undefined, undefined, '确认关系专属表达偏好'), message: '已保存为当前关系的沟通偏好，不影响其他联系人' }
  }

  removeHypothesis(sessionId: string, value: string): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    const next = removeRelationshipHypothesis(state, sessionId, value)
    if (next === state) return { success: false, state, message: '未找到该推测' }
    return { success: true, state: this.saveState(next), message: '推测已删除' }
  }

  reviewHypothesis(input: { accountScope: string; sessionId: string; value: string; status: RelationshipHypothesisStatus; expiresAt?: number }): { success: boolean; state: RelationshipProfileState; message: string } {
    this.assertAccountScope(input.accountScope)
    const state = this.currentState()
    if (!state.memoryEnabled || state.memoryPaused) return { success: false, state, message: '长期关系档案未启用或已暂停更新' }
    const next = reviewRelationshipHypothesis(state, input.sessionId, input.value, input.status, input.expiresAt)
    if (next === state) return { success: false, state, message: '推测不存在或有效期无效' }
    return { success: true, state: this.saveState(next), message: input.status === 'confirmed' ? '已由你确认，并加入事实' : input.status === 'refuted' ? '已标记为否定，不再作为背景推测' : input.status === 'expired' ? '已标记过期' : '已重新设定推测有效期' }
  }

  enableMemory(): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    const next = this.saveState({ ...state, memoryEnabled: true, memoryPaused: false, updatedAt: Date.now() })
    return { success: true, state: next, message: '长期关系档案已启用，可随时暂停或撤销' }
  }

  setPaused(paused: boolean): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    if (!state.memoryEnabled) return { success: false, state, message: '请先明确启用长期关系档案' }
    const next = this.saveState({ ...state, memoryPaused: paused === true, updatedAt: Date.now() })
    return { success: true, state: next, message: paused ? '长期关系档案已暂停更新' : '长期关系档案已恢复更新' }
  }

  update(input: {
    accountScope?: string
    sessionId?: string
    user?: Partial<UserRelationshipProfile>
    object?: Partial<ObjectRelationshipProfile>
    relationship?: Partial<RelationshipStrategy>
  }): { success: boolean; state: RelationshipProfileState; message: string } {
    if (input.accountScope !== undefined) this.assertAccountScope(input.accountScope)
    const state = this.currentState()
    if (!state.memoryEnabled) return { success: false, state, message: '请先明确启用长期关系档案' }
    if (state.memoryPaused) return { success: false, state, message: '长期关系档案已暂停更新' }
    if ((input.object?.confirmedFacts?.length || 0) > 20 || (['communicationPreferences', 'strengths', 'limitations'] as const).some((field) => (input.object?.selfProfile?.[field]?.length || 0) > 20)) {
      return { success: false, state, message: '当前事实或关系画像列表最多20条，请先精简；本次未保存，旧档案未改变' }
    }
    const selfProfile = input.object?.selfProfile
    const patch = selfProfile && input.sessionId ? { ...input, object: { ...input.object, selfProfile: { ...selfProfile,
      communicationPreferenceModes: selfProfile.communicationPreferenceModes ?? state.objects[input.sessionId]?.selfProfile?.communicationPreferenceModes } } } : input
    const next = upsertRelationshipProfile(state, input.sessionId || '', patch)
    if (next === state) return { success: false, state, message: '联系人标识不能为空' }
    return { success: true, state: this.saveState(next), message: '关系档案已更新' }
  }

  applyDraft(input: { sessionId: string; draft: RelationshipProfileDraft; approvals: RelationshipDraftApprovals; decisions?: Record<string, RelationshipDraftDecision> }): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    if (!input?.draft || input.draft.sessionId !== input.sessionId || input.draft.accountScope !== this.scopeKey()) return { success: false, state, message: '草稿账号或联系人与当前对象不一致，请重新分析' }
    if (!state.memoryEnabled) return { success: false, state, message: '请先明确启用长期关系档案' }
    if (state.memoryPaused) return { success: false, state, message: '长期关系档案已暂停更新' }
    if (input.draft.coverage.profileRevision && input.draft.coverage.profileRevision !== this.memoryRevision(state, input.sessionId)) return { success: false, state, message: '当前关系档案已变化，这份分析草稿已过时，请重新分析后再审核' }
    const current = this.getPendingReview(input.sessionId).review
    if (current && current.draft.taskId !== input.draft.taskId) return { success: false, state, message: '此草稿已被新分析替代，请重新打开审核面板' }
    if (!current && this.getAnalysisHistory(input.sessionId).entries.some((entry) => entry.draft.taskId === input.draft.taskId && entry.status !== 'pending')) return { success: false, state, message: '此草稿已处理，不能重复提交' }
    this.assertDraftSourceUnchanged(input.draft)
    this.assertSettledFieldsUnchanged(current, input.draft)
    const decisions: Record<string, RelationshipDraftDecision> = {}
    const approvals: RelationshipDraftApprovals = { user: {}, object: {}, relationship: {} }
    let changed = false
    for (const { key } of relationshipDraftFields(input.draft)) {
      const old = current?.decisions?.[key]
      if (old === 'accepted' || old === 'rejected') { decisions[key] = old; continue }
      const [field, rawIndex] = key.split(':')
      const index = Number(rawIndex)
      const userField = field as keyof NonNullable<RelationshipDraftApprovals['user']>
      const objectField = field as 'confirmedFacts' | 'hypotheses' | 'keyEvents'
      const relationshipField = rawIndex as keyof NonNullable<RelationshipDraftApprovals['relationship']>
      const decision = this.draftDecision(input, key)
      decisions[key] = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'pending'
      if (decision !== 'accept' && decision !== 'reject') continue
      changed = true
      if (decision === 'reject') continue
      if (field === 'relationship') approvals.relationship![relationshipField] = true
      else if (key === 'displayLabel') approvals.object!.displayLabel = true
      else if (field in input.draft.user) (approvals.user![userField] ||= []).push(index)
      else (approvals.object![objectField] ||= []).push(index)
    }
    if (!changed) return { success: false, state, message: '没有新的接受或拒绝项，待定内容未写入档案' }
    const next = applyRelationshipProfileDraft(state, input.sessionId, input.draft, approvals)
    const remainingDraft = Object.values(decisions).includes('pending')
      ? { ...input.draft, coverage: { ...input.draft.coverage, profileRevision: this.memoryRevision(next, input.sessionId) } }
      : undefined
    const objectAfter = next.objects[input.sessionId]
    const automaticState = remainingDraft ? 'waiting_review' : 'idle'
    const nextWithAutomaticStatus = (objectAfter?.automaticDraftUpdates || objectAfter?.automaticDraftStatus) && objectAfter.automaticDraftStatus?.state !== automaticState
      ? setRelationshipAutomaticDraftStatus(next, input.sessionId, { state: automaticState, updatedAt: Date.now() })
      : next
    const remaining = remainingDraft ? { draft: remainingDraft, selection: {}, decisions } : undefined
    const saved = this.saveState(nextWithAutomaticStatus, [input.sessionId], { sessionId: input.sessionId, draft: input.draft, approvals, decisions, remaining })
    return { success: true, state: saved, message: remaining ? '已提交接受和拒绝项；待定项仍保留，未写入档案' : '审核已提交；仅接受项写入关系档案' }
  }

  forgetObject(sessionIdRaw: string): { success: boolean; state: RelationshipProfileState; message: string } {
    const sessionId = String(sessionIdRaw || '').trim()
    const state = this.currentState()
    if (!sessionId) return { success: false, state, message: '联系人标识不能为空' }
    const { [sessionId]: _object, ...objects } = state.objects
    const { [sessionId]: _relationship, ...relationships } = state.relationships
    const next = this.saveState({ ...state, objects, relationships, updatedAt: Date.now() }, [sessionId])
    return { success: true, state: next, message: '该联系人关系档案已删除' }
  }

  revoke(deleteData = false): { success: boolean; state: RelationshipProfileState; message: string } {
    const state = this.currentState()
    const next = deleteData
      ? createEmptyRelationshipState()
      : { ...state, memoryEnabled: false, memoryPaused: false, updatedAt: Date.now() }
    return { success: true, state: this.saveState(next, deleteData ? 'all' : undefined), message: deleteData ? '长期关系档案已撤销并删除' : '长期关系档案已撤销，现有资料已保留' }
  }
}

export const relationshipProfileService = new RelationshipProfileService()
