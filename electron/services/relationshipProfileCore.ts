export type RelationshipConfidence = 'low' | 'medium' | 'high'
export type RelationshipMemorySource = 'user' | 'model' | 'chat'
export type RelationshipHypothesisStatus = 'active' | 'confirmed' | 'refuted' | 'expired'

export interface RelationshipHypothesis {
  value: string
  confidence: RelationshipConfidence
  source: RelationshipMemorySource
  evidenceIds?: string[]
  updatedAt?: number
  status?: RelationshipHypothesisStatus
  expiresAt?: number
  reviewedAt?: number
}

export interface RelationshipEvent {
  id: string
  summary: string
  occurredAt: string
  source: RelationshipMemorySource
  evidenceIds?: string[]
}

export interface RelationshipReplyOutcome {
  id: string
  suggestionId?: string
  mode?: string
  draft: string
  outcome: string
  createdAt: number
  originalDraft?: string
  intent?: string
  revisionFeedback?: string
  history?: Array<{ outcome: string; createdAt: number; draft?: string }>
}

export type RelationshipAutomaticDraftState = 'idle' | 'checking' | 'analyzing' | 'waiting_review' | 'failed'

export interface RelationshipAutomaticDraftStatus {
  state: RelationshipAutomaticDraftState
  lastCheckedAt?: number
  lastGeneratedAt?: number
  lastAttemptAt?: number
  detectedNewMessages?: number
  queuedNewMessages?: number
  queuedCheckedAt?: number
  pendingReviewTaskId?: string
  lastError?: string
  updatedAt: number
}

export interface RelationshipAnalysisCheckpoint {
  lastMessageId?: string
  boundaryMessageIds?: string[]
  lastMessageAt?: number
  totalMessages: number
  analyzedAt: number
}

export interface RelationshipFieldSource {
  field: string
  value: string
  confidence: RelationshipConfidence
  evidenceIds: string[]
  quotes: string[]
  reviewedAt: number
  taskId: string
  replyMode?: string
  expressionExample?: { previous: string; approved: string; feedback: string }
}

export interface RelationshipMemoryVersion {
  id: string
  createdAt: number
  reason: string
  object: ObjectRelationshipProfile
  relationship?: RelationshipStrategy
}

export interface RelationshipMemoryArchive {
  id: string
  field: 'confirmedFacts' | 'keyEvents' | 'communicationPreferences' | 'strengths' | 'limitations' | 'boundaries'
  value: string
  event?: RelationshipEvent
  source?: RelationshipFieldSource
  archivedAt: number
  reason?: 'capacity' | 'removed'
}

export interface RelationshipHistoricalMemory {
  id: string
  field: RelationshipMemoryArchive['field']
  value: string
  archivedAt: number
  occurredAt?: string
  quotes: string[]
  expressionExample?: RelationshipFieldSource['expressionExample']
  replyMode?: string
}

export function selectRelationshipHistoricalMemory(state: RelationshipProfileState, sessionId: string, archives: RelationshipMemoryArchive[], query: string, replyMode?: string): RelationshipHistoricalMemory[] {
  if (!state.memoryEnabled || !state.objects[sessionId] || !query.trim()) return []
  // ponytail: bounded literal word/bigram recall over compact memory, not semantic search; measure misses before adding an index.
  const literal = query.trim().toLowerCase().slice(0, 200)
  const terms = Array.from(new Set((query.toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9_]{2,}/g) || []).flatMap((term) =>
    /^[\u4e00-\u9fff]+$/.test(term) ? [term, ...Array.from({ length: Math.max(0, term.length - 1) }, (_, i) => term.slice(i, i + 2))].filter((part) => part.length >= 2) : [term]))).slice(0, 120)
  if (!terms.length) return []
  const object = state.objects[sessionId]
  return archives.filter((entry) => entry.reason === 'capacity' && entry.field !== 'boundaries'
    && (!replyMode || !entry.source?.replyMode || entry.source.replyMode === replyMode)).map((entry) => {
    const active = entry.field === 'confirmedFacts' ? object.confirmedFacts.includes(entry.value)
      : entry.field === 'keyEvents' ? object.keyEvents.some((event) => event.id === entry.event?.id)
      : object.selfProfile?.[entry.field]?.includes(entry.value)
    const text = `${entry.value} ${entry.source?.expressionExample?.feedback || ''}`.toLowerCase()
    const score = active ? 0 : Number(literal.length >= 2 && text.includes(literal)) * 100 + terms.reduce((sum, term) => sum + Number(text.includes(term)), 0)
    return { entry, score }
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.entry.archivedAt - a.entry.archivedAt || a.entry.id.localeCompare(b.entry.id))
    .slice(0, 4).map(({ entry }) => ({ id: entry.id, field: entry.field, value: entry.value.slice(0, 200), archivedAt: entry.archivedAt,
      occurredAt: entry.event?.occurredAt, quotes: (entry.source?.quotes || []).slice(0, 2).map((quote) => quote.slice(0, 180)),
      expressionExample: entry.field === 'communicationPreferences' ? entry.source?.expressionExample : undefined, replyMode: entry.source?.replyMode }))
}

export interface UserRelationshipProfile {
  displayLabel?: string
  mbti?: string
  subjectiveScore?: number
  strengths?: string[]
  limitations?: string[]
  communicationPreferences?: string[]
  communicationPreferenceModes?: Record<string, string>
  boundaries?: string[]
  updatedAt?: number
}

export interface ObjectRelationshipProfile {
  sessionId: string
  selfProfile?: UserRelationshipProfile
  displayLabel?: string
  mbti?: string
  subjectiveScore?: number
  confirmedFacts: string[]
  hypotheses: RelationshipHypothesis[]
  keyEvents: RelationshipEvent[]
  replyOutcomes?: RelationshipReplyOutcome[]
  automaticDraftStatus?: RelationshipAutomaticDraftStatus
  analysisCheckpoint?: RelationshipAnalysisCheckpoint
  fieldSources?: RelationshipFieldSource[]
  automaticDraftUpdates?: boolean
  updatedAt: number
}

export interface RelationshipStrategy {
  role?: string
  stage?: string
  goal?: string
  replyAttitude?: string
  currentAction?: string
  observationWindow?: string
  stopCondition?: string
  expiresAt?: number
  updatedAt?: number
}

export interface RelationshipProfileState {
  version: 1
  memoryEnabled: boolean
  memoryPaused: boolean
  user: UserRelationshipProfile
  objects: Record<string, ObjectRelationshipProfile>
  relationships: Record<string, RelationshipStrategy>
  updatedAt: number
}

export interface RelationshipProposedField {
  value: string
  confidence: RelationshipConfidence
  evidenceIds: string[]
  quotes: string[]
  replacesValue?: string
}

export interface RelationshipProposedHypothesis extends RelationshipProposedField {}

export interface RelationshipProposedEvent extends RelationshipProposedField {
  occurredAt: string
  summary: string
}

export interface RelationshipProfileStatistics {
  totalMessages: number
  myMessages: number
  objectMessages: number
  myInitiations: number
  objectInitiations: number
  replyCount: number
  myReplyCount: number
  objectReplyCount: number
  myReplyRate?: number
  objectReplyRate?: number
  unknownMessages: number
  longestConversationMessages: number
  longestConversationDuration: number
  replyRate?: number
  averageReplyInterval?: number
  medianReplyInterval?: number
  conversationSegments: number
  longestSilence?: number
  firstMessageAt?: number
  lastMessageAt?: number
  dailyActivity: Array<{ date: string; mine: number; theirs: number; total: number }>
  weeklyActivity: Array<{ week: string; mine: number; theirs: number; total: number }>
  messageTypes: Record<string, number>
  topKeywords: Array<{ keyword: string; count: number }>
}

export interface RelationshipAnalysisReport {
  facts: RelationshipProposedField[]
  hypotheses: RelationshipProposedField[]
  unknowns: RelationshipProposedField[]
  recommendation?: RelationshipProposedField
  nextAction?: RelationshipProposedField
  stopCondition?: RelationshipProposedField
}

export interface RelationshipDraftChange {
  key: string
  value: string
  previousValue?: string
  kind: 'add' | 'replace'
}

export interface RelationshipDraftChanges {
  added: RelationshipDraftChange[]
  replacements: RelationshipDraftChange[]
}

export interface RelationshipProfileDraft {
  sessionId: string
  accountScope: string
  taskId: string
  generatedAt: number
  coverage: {
    totalMessages: number
    analyzedMessages: number
    firstMessageAt?: number
    lastMessageAt?: number
    lastMessageId?: string
    boundaryMessageIds?: string[]
    newMessages?: number
    readMessages?: number
    readMode?: 'full' | 'incremental'
    profileRevision?: string
    sourceFingerprint?: string
    truncated: boolean
  }
  statistics: RelationshipProfileStatistics
  report: RelationshipAnalysisReport
  evidence: Array<{ id: string; messageKey?: string; localId: number; createTime: number; sender: string; quote: string; reason?: string }>
  user: {
    communicationPreferences: RelationshipProposedField[]
    strengths: RelationshipProposedField[]
    limitations: RelationshipProposedField[]
    boundaries: RelationshipProposedField[]
  }
  object: {
    displayLabel?: RelationshipProposedField
    confirmedFacts: RelationshipProposedField[]
    hypotheses: RelationshipProposedHypothesis[]
    keyEvents: RelationshipProposedEvent[]
  }
  relationship: {
    role?: RelationshipProposedField
    stage?: RelationshipProposedField
    goal?: RelationshipProposedField
    replyAttitude?: RelationshipProposedField
    currentAction?: RelationshipProposedField
    observationWindow?: RelationshipProposedField
    stopCondition?: RelationshipProposedField
  }
  changes?: RelationshipDraftChanges
}

export interface RelationshipAnalysisHistoryEntry {
  draft: RelationshipProfileDraft
  status: 'pending' | 'accepted' | 'discarded' | 'superseded'
  reviewedAt?: number
  approvals?: RelationshipDraftApprovals
  decisions?: Record<string, RelationshipDraftDecision>
}

export type RelationshipDraftDecision = 'pending' | 'accept' | 'reject' | 'accepted' | 'rejected'

export function relationshipDraftFields(draft: RelationshipProfileDraft): Array<{ key: string; value: string }> {
  return [
    ...Object.entries(draft.user).flatMap(([field, items]) => items.map((item, index) => ({ key: `${field}:${index}`, value: item.value }))),
    ...(['confirmedFacts', 'hypotheses', 'keyEvents'] as const).flatMap((field) => draft.object[field].map((item, index) => ({ key: `${field}:${index}`, value: item.value }))),
    ...(draft.object.displayLabel ? [{ key: 'displayLabel', value: draft.object.displayLabel.value }] : []),
    ...Object.entries(draft.relationship).flatMap(([field, item]) => item ? [{ key: `relationship:${field}`, value: item.value }] : [])
  ]
}

export interface RelationshipDraftApprovals {
  user?: Partial<Record<'communicationPreferences' | 'strengths' | 'limitations' | 'boundaries', number[]>>
  object?: Partial<Record<'confirmedFacts' | 'hypotheses' | 'keyEvents', number[]>> & { displayLabel?: boolean }
  relationship?: Partial<Record<'role' | 'stage' | 'goal' | 'replyAttitude' | 'currentAction' | 'observationWindow' | 'stopCondition', boolean>>
}

export function buildRelationshipDraftChanges(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  draft: Pick<RelationshipProfileDraft, 'user' | 'object' | 'relationship'>
): RelationshipDraftChanges {
  const sessionId = String(sessionIdRaw || '').trim()
  const object = state.objects?.[sessionId]
  const relationship = state.relationships?.[sessionId]
  const added: RelationshipDraftChange[] = []
  const replacements: RelationshipDraftChange[] = []
  const add = (key: string, item: RelationshipProposedField | undefined, current: string[] = []) => {
    if (!item?.value || current.includes(item.value)) return
    const previous = item.replacesValue && current.includes(item.replacesValue) ? item.replacesValue : undefined
    ;(previous ? replacements : added).push({ key, value: item.value, previousValue: previous, kind: previous ? 'replace' : 'add' })
  }
  const self = object?.selfProfile
  for (const key of ['communicationPreferences', 'strengths', 'limitations', 'boundaries'] as const) {
    for (const [index, item] of (draft.user?.[key] || []).entries()) add(`user.${key}:${index}`, item, self?.[key] || [])
  }
  for (const key of ['confirmedFacts', 'hypotheses'] as const) {
    const current = key === 'confirmedFacts' ? object?.confirmedFacts || [] : (object?.hypotheses || []).map((item) => item.value)
    for (const [index, item] of (draft.object?.[key] || []).entries()) add(`object.${key}:${index}`, item, current)
  }
  for (const [index, item] of (draft.object?.keyEvents || []).entries()) {
    const current = (object?.keyEvents || []).map((event) => `${event.occurredAt} ${event.summary}`)
    add(`object.keyEvents:${index}`, item, current)
  }
  if (draft.object?.displayLabel?.value && draft.object.displayLabel.value !== object?.displayLabel) {
    const previous = draft.object.displayLabel.replacesValue || object?.displayLabel
    ;(previous ? replacements : added).push({ key: 'object.displayLabel', value: draft.object.displayLabel.value, previousValue: previous, kind: previous ? 'replace' : 'add' })
  }
  for (const [key, item] of Object.entries(draft.relationship || {})) {
    if (!item) continue
    const current = relationship?.[key as keyof RelationshipStrategy]
    if (!item.value || item.value === current) continue
    const previous = item.replacesValue || (typeof current === 'string' ? current : undefined)
    ;(previous ? replacements : added).push({ key: `relationship.${key}`, value: item.value, previousValue: previous, kind: previous ? 'replace' : 'add' })
  }
  return { added: added.slice(0, 80), replacements: replacements.slice(0, 80) }
}

const normalizeReplyOutcomes = (value: unknown): RelationshipReplyOutcome[] => {
  if (!Array.isArray(value)) return []
  return value.map((entry): RelationshipReplyOutcome | null => {
    if (!entry || typeof entry !== 'object') return null
    const item = entry as Record<string, unknown>
    const draft = cleanString(item.draft)
    const outcome = cleanString(item.outcome)
    if (!draft || !outcome) return null
    const history = Array.isArray(item.history) ? item.history.map((event) => {
      if (!event || typeof event !== 'object') return null
      const row = event as Record<string, unknown>
      const outcome = cleanString(row.outcome)
      const createdAt = Number(row.createdAt)
      return outcome && Number.isFinite(createdAt) ? { outcome: outcome.slice(0, 80), createdAt, draft: cleanString(row.draft)?.slice(0, 240) } : null
    }).filter((event): event is { outcome: string; createdAt: number; draft: string | undefined } => Boolean(event)).slice(-12) : []
    return {
      id: cleanString(item.id) || `reply-${Number(item.createdAt) || 0}-${draft.slice(0, 20)}`,
      suggestionId: cleanString(item.suggestionId),
      mode: cleanString(item.mode),
      originalDraft: cleanString(item.originalDraft)?.slice(0, 240),
      intent: cleanString(item.intent)?.slice(0, 300),
      revisionFeedback: cleanString(item.revisionFeedback)?.slice(0, 300),
      draft: draft.slice(0, 240),
      outcome: outcome.slice(0, 80),
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
      history
    }
  }).filter((item): item is RelationshipReplyOutcome => Boolean(item)).slice(-20)
}

const normalizeAnalysisCheckpoint = (value: unknown): RelationshipAnalysisCheckpoint | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const totalMessages = Number(item.totalMessages)
  const analyzedAt = Number(item.analyzedAt)
  if (!Number.isFinite(totalMessages) || totalMessages < 0 || !Number.isFinite(analyzedAt)) return undefined
  return {
    lastMessageId: cleanString(item.lastMessageId),
    boundaryMessageIds: cleanList(item.boundaryMessageIds, 500),
    lastMessageAt: Number.isFinite(Number(item.lastMessageAt)) ? Number(item.lastMessageAt) : undefined,
    totalMessages: Math.floor(totalMessages),
    analyzedAt
  }
}

const clampScore = (value: unknown): number | undefined => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(0, Math.min(100, Math.round(parsed)))
}

const cleanString = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim()
  return text || undefined
}

const cleanList = (value: unknown, max = 20): string[] => Array.isArray(value)
  ? Array.from(new Set(value.map(cleanString).filter((item): item is string => Boolean(item)))).slice(0, max)
  : []

const cleanConfidence = (value: unknown): RelationshipConfidence => value === 'high' || value === 'medium' ? value : 'low'
const cleanSource = (value: unknown): RelationshipMemorySource => value === 'model' || value === 'chat' ? value : 'user'

export function createEmptyRelationshipState(): RelationshipProfileState {
  return {
    version: 1,
    memoryEnabled: false,
    memoryPaused: false,
    user: {},
    objects: {},
    relationships: {},
    updatedAt: Date.now()
  }
}

export function normalizeRelationshipState(raw: unknown): RelationshipProfileState {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const userSource = source.user && typeof source.user === 'object' ? source.user as Record<string, unknown> : {}
  const objectsSource = source.objects && typeof source.objects === 'object' ? source.objects as Record<string, unknown> : {}
  const relationshipsSource = source.relationships && typeof source.relationships === 'object' ? source.relationships as Record<string, unknown> : {}
  const objects: Record<string, ObjectRelationshipProfile> = {}
  for (const [sessionIdRaw, value] of Object.entries(objectsSource)) {
    const sessionId = sessionIdRaw.trim()
    if (!sessionId || !value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    const hypotheses = Array.isArray(item.hypotheses) ? item.hypotheses.map((entry): RelationshipHypothesis | null => {
      if (!entry || typeof entry !== 'object') return null
      const hypothesis = entry as Record<string, unknown>
      const text = cleanString(hypothesis.value)
      return text ? {
        value: text,
        confidence: cleanConfidence(hypothesis.confidence),
        source: cleanSource(hypothesis.source),
        evidenceIds: cleanList(hypothesis.evidenceIds, 12),
        status: hypothesis.status === 'confirmed' || hypothesis.status === 'refuted' || hypothesis.status === 'expired' ? hypothesis.status : 'active',
        expiresAt: Number.isFinite(Number(hypothesis.expiresAt)) && Number(hypothesis.expiresAt) > 0 ? Number(hypothesis.expiresAt) : undefined,
        reviewedAt: Number.isFinite(Number(hypothesis.reviewedAt)) ? Number(hypothesis.reviewedAt) : undefined,
        updatedAt: Number.isFinite(Number(hypothesis.updatedAt)) ? Number(hypothesis.updatedAt) : undefined
      } : null
    }).filter((entry): entry is RelationshipHypothesis => Boolean(entry)) : []
    const activeHypotheses = hypotheses.filter((entry) => !entry.status || entry.status === 'active').slice(-5)
    const reviewedHypotheses = hypotheses.filter((entry) => entry.status && entry.status !== 'active').slice(-15)
    const keyEvents = Array.isArray(item.keyEvents) ? item.keyEvents.map((entry): RelationshipEvent | null => {
      if (!entry || typeof entry !== 'object') return null
      const event = entry as Record<string, unknown>
      const id = cleanString(event.id)
      const summary = cleanString(event.summary)
      const occurredAt = cleanString(event.occurredAt)
      return id && summary && occurredAt ? {
        id,
        summary: summary.slice(0, 200),
        occurredAt,
        source: cleanSource(event.source),
        evidenceIds: cleanList(event.evidenceIds, 12)
      } : null
    }).filter((entry): entry is RelationshipEvent => Boolean(entry)).slice(-20) : []
    objects[sessionId] = {
      sessionId,
      selfProfile: item.selfProfile && typeof item.selfProfile === 'object'
        ? normalizeUserProfile(item.selfProfile as Record<string, unknown>) : undefined,
      displayLabel: cleanString(item.displayLabel),
      mbti: cleanString(item.mbti),
      subjectiveScore: clampScore(item.subjectiveScore),
      confirmedFacts: cleanList(item.confirmedFacts),
      hypotheses: [...reviewedHypotheses, ...activeHypotheses],
      keyEvents,
      replyOutcomes: normalizeReplyOutcomes(item.replyOutcomes),
      automaticDraftStatus: item.automaticDraftStatus && typeof item.automaticDraftStatus === 'object'
        ? (() => {
          const status = item.automaticDraftStatus as Record<string, unknown>
          const state = status.state === 'checking' || status.state === 'analyzing' || status.state === 'waiting_review' || status.state === 'failed' ? status.state : 'idle'
          return {
            state,
            lastCheckedAt: Number.isFinite(Number(status.lastCheckedAt)) ? Number(status.lastCheckedAt) : undefined,
            lastGeneratedAt: Number.isFinite(Number(status.lastGeneratedAt)) ? Number(status.lastGeneratedAt) : undefined,
            lastAttemptAt: Number.isFinite(Number(status.lastAttemptAt)) ? Number(status.lastAttemptAt) : undefined,
            detectedNewMessages: Number.isFinite(Number(status.detectedNewMessages)) ? Math.max(0, Math.floor(Number(status.detectedNewMessages))) : undefined,
            queuedNewMessages: status.queuedNewMessages != null && Number.isFinite(Number(status.queuedNewMessages)) ? Math.max(0, Math.floor(Number(status.queuedNewMessages))) : undefined,
            queuedCheckedAt: status.queuedCheckedAt != null && Number.isFinite(Number(status.queuedCheckedAt)) ? Number(status.queuedCheckedAt) : undefined,
            pendingReviewTaskId: cleanString(status.pendingReviewTaskId),
            lastError: cleanString(status.lastError)?.slice(0, 300),
            updatedAt: Number.isFinite(Number(status.updatedAt)) ? Number(status.updatedAt) : Date.now()
          }
        })() : undefined,
      analysisCheckpoint: normalizeAnalysisCheckpoint(item.analysisCheckpoint),
      fieldSources: Array.isArray(item.fieldSources) ? item.fieldSources.filter((entry) => entry && typeof entry === 'object').map((entry): RelationshipFieldSource => {
        const row = entry as Record<string, unknown>
        const example = row.expressionExample as Record<string, unknown> | undefined
        const previous = cleanString(example?.previous)?.slice(0, 500), approved = cleanString(example?.approved)?.slice(0, 240), feedback = cleanString(example?.feedback)?.slice(0, 300)
        return { field: cleanString(row.field) || '', value: cleanString(row.value) || '', confidence: cleanConfidence(row.confidence), evidenceIds: cleanList(row.evidenceIds, 12), quotes: cleanList(row.quotes, 3).map((quote) => quote.slice(0, 220)), reviewedAt: Number(row.reviewedAt) || 0, taskId: cleanString(row.taskId) || '', replyMode: cleanString(row.replyMode)?.slice(0, 80), expressionExample: previous && approved && feedback ? { previous, approved, feedback } : undefined }
      }).filter((entry) => entry.field && entry.value).slice(-80) : [],
      automaticDraftUpdates: item.automaticDraftUpdates === true,
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now()
    }
  }
  const relationships: Record<string, RelationshipStrategy> = {}
  for (const [sessionIdRaw, value] of Object.entries(relationshipsSource)) {
    const sessionId = sessionIdRaw.trim()
    if (!sessionId || !value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    relationships[sessionId] = {
      role: cleanString(item.role),
      stage: cleanString(item.stage),
      goal: cleanString(item.goal),
      replyAttitude: cleanString(item.replyAttitude),
      currentAction: cleanString(item.currentAction),
      observationWindow: cleanString(item.observationWindow),
      stopCondition: cleanString(item.stopCondition),
      expiresAt: Number.isFinite(Number(item.expiresAt)) ? Number(item.expiresAt) : undefined,
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : undefined
    }
  }
  return {
    version: 1,
    memoryEnabled: source.memoryEnabled === true,
    memoryPaused: source.memoryPaused === true,
    user: normalizeUserProfile(userSource),
    objects,
    relationships,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now()
  }
}

function normalizeUserProfile(source: Record<string, unknown>): UserRelationshipProfile {
  const communicationPreferences = cleanList(source.communicationPreferences)
  const modes = source.communicationPreferenceModes && typeof source.communicationPreferenceModes === 'object' && !Array.isArray(source.communicationPreferenceModes)
    ? source.communicationPreferenceModes as Record<string, unknown> : {}
  const normalizedModes = Object.fromEntries(communicationPreferences.filter((value) => cleanString(modes[value])).map((value) => [value, cleanString(modes[value])!.slice(0, 80)]))
  return {
    displayLabel: cleanString(source.displayLabel), mbti: cleanString(source.mbti), subjectiveScore: clampScore(source.subjectiveScore),
    strengths: cleanList(source.strengths), limitations: cleanList(source.limitations),
    communicationPreferences, communicationPreferenceModes: Object.keys(normalizedModes).length ? normalizedModes : undefined, boundaries: cleanList(source.boundaries, Infinity),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : undefined
  }
}

export function upsertRelationshipProfile(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  patch: { user?: Partial<UserRelationshipProfile>; object?: Partial<ObjectRelationshipProfile>; relationship?: Partial<RelationshipStrategy> }
): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  if (!sessionId && !patch.user) return state
  if (!patch.user && !patch.object && !patch.relationship) return state
  const now = Date.now()
  const currentObject = state.objects[sessionId] || {
    sessionId,
    confirmedFacts: [],
    hypotheses: [],
    keyEvents: [],
    updatedAt: now
  }
  return normalizeRelationshipState({
    ...state,
    user: patch.user ? { ...state.user, ...patch.user, updatedAt: now } : state.user,
    objects: sessionId && patch.object
      ? { ...state.objects, [sessionId]: { ...currentObject, ...patch.object, sessionId, updatedAt: now } }
      : state.objects,
    relationships: patch.relationship
      && sessionId
      ? { ...state.relationships, [sessionId]: { ...state.relationships[sessionId], ...patch.relationship, updatedAt: now } }
      : state.relationships,
    updatedAt: now
  })
}

const approvedValues = (items: RelationshipProposedField[] | undefined, indexes: number[] | undefined): string[] =>
  (Array.isArray(indexes) ? indexes : []).filter((index) => Number.isInteger(index) && index >= 0)
    .map((index) => cleanString(items?.[index]?.value)).filter((value): value is string => Boolean(value))

export function applyRelationshipProfileDraft(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  draft: RelationshipProfileDraft,
  approvals: RelationshipDraftApprovals
): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  if (!state.memoryEnabled || state.memoryPaused || !sessionId || !draft || draft.sessionId !== sessionId || !approvals) return state
  const object = draft.object || { confirmedFacts: [], hypotheses: [], keyEvents: [] }
  const relationship = draft.relationship || {}
  const user = draft.user || { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] }
  const hasApproval = Object.values(approvals.user || {}).some((items) => Array.isArray(items) && items.length > 0)
    || Boolean(approvals.object?.displayLabel)
    || Object.values(approvals.object || {}).some((items) => Array.isArray(items) && items.length > 0)
    || Object.values(approvals.relationship || {}).some(Boolean)
  if (!hasApproval) return state
  const userPatch: Partial<UserRelationshipProfile> = {}
  const preferenceModes = { ...state.objects[sessionId]?.selfProfile?.communicationPreferenceModes }
  for (const key of ['communicationPreferences', 'strengths', 'limitations', 'boundaries'] as const) {
    const values = approvedValues(user[key], approvals.user?.[key])
    const replacements = (approvals.user?.[key] || []).map((index) => user[key]?.[index]?.replacesValue).filter(Boolean)
    if (values.length) {
      const merged = Array.from(new Set([...(state.objects[sessionId]?.selfProfile?.[key] || []).filter((value) => !replacements.includes(value)), ...values]))
      userPatch[key] = key === 'boundaries' ? merged : merged.slice(-20)
      if (key === 'communicationPreferences') {
        for (const index of approvals.user?.communicationPreferences || []) {
          const item = user.communicationPreferences[index]
          if (item?.replacesValue && preferenceModes[item.replacesValue]) preferenceModes[item.value] = preferenceModes[item.replacesValue]
        }
        userPatch.communicationPreferenceModes = preferenceModes
      }
    }
  }
  const objectPatch: Partial<ObjectRelationshipProfile> = {}
  if (Object.keys(userPatch).length) objectPatch.selfProfile = { ...state.objects[sessionId]?.selfProfile, ...userPatch, updatedAt: Date.now() }
  if (approvals.object?.displayLabel && object.displayLabel?.value) objectPatch.displayLabel = object.displayLabel.value
  const facts = approvedValues(object.confirmedFacts, approvals.object?.confirmedFacts)
  const factReplacements = (approvals.object?.confirmedFacts || []).map((index) => object.confirmedFacts?.[index]?.replacesValue).filter(Boolean)
  if (facts.length) objectPatch.confirmedFacts = Array.from(new Set([...(state.objects[sessionId]?.confirmedFacts || []).filter((value) => !factReplacements.includes(value)), ...facts])).slice(-20)
  const relationshipPatch = Object.fromEntries(Object.entries(relationship).filter(([key, item]) => item?.value && approvals.relationship?.[key as keyof NonNullable<RelationshipDraftApprovals['relationship']>] === true).map(([key, item]) => [key, (item as RelationshipProposedField).value]))
  let next = upsertRelationshipProfile(state, sessionId, {
    object: Object.keys(objectPatch).length ? objectPatch : undefined,
    relationship: Object.keys(relationshipPatch).length ? relationshipPatch : undefined
  })
  for (const index of approvals.object?.hypotheses || []) {
    const item = object.hypotheses?.[index]
    if (item?.value) {
      if (item.replacesValue) next = removeRelationshipHypothesis(next, sessionId, item.replacesValue)
      next = addRelationshipHypothesis(next, sessionId, item.value, item.confidence, item.evidenceIds)
    }
  }
  for (const index of approvals.object?.keyEvents || []) {
    const item = object.keyEvents?.[index]
    if (item?.summary && item.occurredAt) next = addRelationshipEvent(next, sessionId, { id: `draft-event:${item.occurredAt}:${item.summary.slice(0, 200)}`, summary: item.summary, occurredAt: item.occurredAt, source: 'chat', evidenceIds: item.evidenceIds })
  }
  if (next === state) return state
  const sources: RelationshipFieldSource[] = [...(state.objects[sessionId]?.fieldSources || [])]
  const recordSource = (field: string, item: RelationshipProposedField | undefined) => {
    if (!item || typeof item.value !== 'string' || !item.value.trim()) return
    const evidenceIds = cleanList(item.evidenceIds, 12).filter((id) => draft.evidence.some((entry) => entry.id === id))
    const value = item.value.trim()
    const existing = sources.findIndex((entry) => entry.field === field && entry.value === value)
    const replyMode = field === 'user.communicationPreferences' ? next.objects[sessionId]?.selfProfile?.communicationPreferenceModes?.[value] : existing >= 0 ? sources[existing].replyMode : undefined
    if (existing >= 0) sources.splice(existing, 1)
    sources.push({ field, value, confidence: cleanConfidence(item.confidence), evidenceIds, quotes: evidenceIds.map((id) => draft.evidence.find((entry) => entry.id === id)?.quote || '').filter(Boolean).slice(0, 3), reviewedAt: Date.now(), taskId: draft.taskId, replyMode })
  }
  for (const key of ['communicationPreferences', 'strengths', 'limitations', 'boundaries'] as const) {
    for (const index of approvals.user?.[key] || []) recordSource(`self.${key}`, user[key]?.[index])
  }
  if (approvals.object?.displayLabel) recordSource('object.displayLabel', object.displayLabel)
  for (const key of ['confirmedFacts', 'hypotheses', 'keyEvents'] as const) {
    for (const index of approvals.object?.[key] || []) recordSource(`object.${key}`, object[key]?.[index])
  }
  for (const key of Object.keys(relationshipPatch)) recordSource(`relationship.${key}`, relationship[key as keyof typeof relationship])
  next = upsertRelationshipProfile(next, sessionId, { object: { fieldSources: sources.slice(-80) } })
  if (draft.coverage.lastMessageId || draft.coverage.lastMessageAt !== undefined) {
    next = setRelationshipAnalysisCheckpoint(next, sessionId, {
      lastMessageId: draft.coverage.lastMessageId,
      boundaryMessageIds: draft.coverage.boundaryMessageIds,
      lastMessageAt: draft.coverage.lastMessageAt,
      totalMessages: draft.coverage.totalMessages,
      analyzedAt: draft.generatedAt
    })
  }
  return next
}

export function addRelationshipEvent(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  event: Omit<RelationshipEvent, 'source'> & { source?: RelationshipMemorySource }
): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  const id = cleanString(event.id)
  const summary = cleanString(event.summary)
  const occurredAt = cleanString(event.occurredAt)
  if (!sessionId || !id || !summary || !occurredAt) return state
  const now = Date.now()
  const currentObject = state.objects[sessionId] || {
    sessionId,
    confirmedFacts: [],
    hypotheses: [],
    keyEvents: [],
    updatedAt: now
  }
  const nextEvents = currentObject.keyEvents.filter((item) => item.id !== id)
  nextEvents.push({
    id,
    summary: summary.slice(0, 200),
    occurredAt,
    source: cleanSource(event.source),
    evidenceIds: cleanList(event.evidenceIds, 12)
  })
  return normalizeRelationshipState({
    ...state,
    objects: {
      ...state.objects,
      [sessionId]: { ...currentObject, sessionId, keyEvents: nextEvents.slice(-20), updatedAt: now }
    },
    updatedAt: now
  })
}

export function addConfirmedFact(state: RelationshipProfileState, sessionIdRaw: string, factRaw: string): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  const fact = cleanString(factRaw)
  if (!sessionId || !fact) return state
  const now = Date.now()
  const currentObject = state.objects[sessionId] || {
    sessionId,
    confirmedFacts: [],
    hypotheses: [],
    keyEvents: [],
    updatedAt: now
  }
  const confirmedFacts = Array.from(new Set([...currentObject.confirmedFacts, fact.slice(0, 200)])).slice(-20)
  return normalizeRelationshipState({
    ...state,
    objects: { ...state.objects, [sessionId]: { ...currentObject, sessionId, confirmedFacts, updatedAt: now } },
    updatedAt: now
  })
}

export function addRelationshipHypothesis(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  hypothesisRaw: string,
  confidence: RelationshipConfidence = 'low',
  evidenceIds?: string[]
): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  const value = cleanString(hypothesisRaw)
  if (!sessionId || !value) return state
  const now = Date.now()
  const currentObject = state.objects[sessionId] || {
    sessionId,
    confirmedFacts: [],
    hypotheses: [],
    keyEvents: [],
    updatedAt: now
  }
  const hypotheses = currentObject.hypotheses.filter((item) => item.value !== value)
  hypotheses.push({ value: value.slice(0, 200), confidence: cleanConfidence(confidence), source: 'model', evidenceIds: cleanList(evidenceIds, 12), updatedAt: now, status: 'active', expiresAt: now + 30 * 24 * 3600 * 1000 })
  return normalizeRelationshipState({
    ...state,
    objects: { ...state.objects, [sessionId]: { ...currentObject, sessionId, hypotheses, updatedAt: now } },
    updatedAt: now
  })
}

export function relationshipHypothesisStatus(item: RelationshipHypothesis, now = Date.now()): RelationshipHypothesisStatus {
  if (item.status && item.status !== 'active') return item.status
  const expiresAt = item.expiresAt ?? (item.updatedAt ? item.updatedAt + 30 * 24 * 3600 * 1000 : undefined)
  return expiresAt && expiresAt <= now ? 'expired' : 'active'
}

export function reviewRelationshipHypothesis(
  state: RelationshipProfileState, sessionId: string, value: string,
  status: RelationshipHypothesisStatus, expiresAt?: number
): RelationshipProfileState {
  if (!state.memoryEnabled || state.memoryPaused || !['active', 'confirmed', 'refuted', 'expired'].includes(status)) return state
  const object = state.objects[sessionId]
  if (!object?.hypotheses.some((item) => item.value === value)) return state
  const now = Date.now()
  if (status === 'active' && expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now)) return state
  let next = upsertRelationshipProfile(state, sessionId, { object: {
    hypotheses: object.hypotheses.map((item) => item.value === value ? { ...item, status, reviewedAt: now,
      expiresAt: status === 'active' ? expiresAt ?? now + 30 * 24 * 3600 * 1000 : item.expiresAt } : item)
  } })
  if (status !== 'confirmed' && object.hypotheses.some((item) => item.value === value && item.status === 'confirmed')) next = removeConfirmedFact(next, sessionId, value)
  return status === 'confirmed' ? addConfirmedFact(next, sessionId, value) : next
}

export function addRelationshipReplyOutcome(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  outcome: Omit<RelationshipReplyOutcome, 'createdAt'> & { createdAt?: number }
): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  if (!state.memoryEnabled || state.memoryPaused) return state
  const draft = cleanString(outcome.draft)
  const result = cleanString(outcome.outcome)
  if (!sessionId || !draft || !result) return state
  const now = Number.isFinite(Number(outcome.createdAt)) ? Number(outcome.createdAt) : Date.now()
  const currentObject = state.objects[sessionId] || {
    sessionId,
    confirmedFacts: [],
    hypotheses: [],
    keyEvents: [],
    updatedAt: now
  }
  const id = cleanString(outcome.suggestionId) || cleanString(outcome.id) || `reply-${now}`
  const previous = (currentObject.replyOutcomes || []).find((item) => item.id === id)
  const history = [...(previous?.history || []), ...(previous ? [{ outcome: previous.outcome, createdAt: previous.createdAt, draft: previous.draft }] : []), { outcome: result.slice(0, 80), createdAt: now, draft: draft.slice(0, 240) }]
    .filter((event, index, items) => index === 0 || event.outcome !== items[index - 1].outcome || event.createdAt !== items[index - 1].createdAt || event.draft !== items[index - 1].draft).slice(-12)
  const entries = (currentObject.replyOutcomes || []).filter((item) => item.id !== id)
  entries.push({ id, suggestionId: cleanString(outcome.suggestionId), mode: cleanString(outcome.mode), draft: draft.slice(0, 240), outcome: result.slice(0, 80), createdAt: now,
    originalDraft: cleanString(outcome.originalDraft) || previous?.originalDraft, intent: cleanString(outcome.intent) || previous?.intent, revisionFeedback: cleanString(outcome.revisionFeedback) || previous?.revisionFeedback, history })
  return normalizeRelationshipState({
    ...state,
    objects: { ...state.objects, [sessionId]: { ...currentObject, sessionId, replyOutcomes: entries.slice(-20), updatedAt: now } },
    updatedAt: now
  })
}

export function setRelationshipAnalysisCheckpoint(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  checkpoint: RelationshipAnalysisCheckpoint
): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  if (!sessionId || !checkpoint || !Number.isFinite(checkpoint.totalMessages) || checkpoint.totalMessages < 0 || !Number.isFinite(checkpoint.analyzedAt)) return state
  if ((state.objects[sessionId]?.analysisCheckpoint?.analyzedAt || 0) > checkpoint.analyzedAt) return state
  const now = Date.now()
  const currentObject = state.objects[sessionId] || {
    sessionId,
    confirmedFacts: [],
    hypotheses: [],
    keyEvents: [],
    updatedAt: now
  }
  return normalizeRelationshipState({
    ...state,
    objects: {
      ...state.objects,
      [sessionId]: {
        ...currentObject,
        sessionId,
        analysisCheckpoint: {
          lastMessageId: cleanString(checkpoint.lastMessageId),
          boundaryMessageIds: cleanList(checkpoint.boundaryMessageIds, 500),
          lastMessageAt: Number.isFinite(Number(checkpoint.lastMessageAt)) ? Number(checkpoint.lastMessageAt) : undefined,
          totalMessages: Math.floor(checkpoint.totalMessages),
          analyzedAt: checkpoint.analyzedAt
        },
        updatedAt: now
      }
    },
    updatedAt: now
  })
}

export function setRelationshipAutomaticDraftStatus(
  state: RelationshipProfileState,
  sessionIdRaw: string,
  status: RelationshipAutomaticDraftStatus
): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  if (!sessionId || !status || !['idle', 'checking', 'analyzing', 'waiting_review', 'failed'].includes(status.state)) return state
  const now = Date.now()
  const currentObject = state.objects[sessionId] || { sessionId, confirmedFacts: [], hypotheses: [], keyEvents: [], updatedAt: now }
  return normalizeRelationshipState({
    ...state,
    objects: {
      ...state.objects,
      // Runtime status is operational metadata; do not bump the profile timestamp and remount
      // the editor while the user is typing relationship fields.
      [sessionId]: { ...currentObject, sessionId, automaticDraftStatus: { ...currentObject.automaticDraftStatus, ...status, updatedAt: Number.isFinite(status.updatedAt) ? status.updatedAt : now } }
    },
    updatedAt: state.updatedAt
  })
}

export function removeConfirmedFact(state: RelationshipProfileState, sessionIdRaw: string, factRaw: string): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  const fact = cleanString(factRaw)
  const currentObject = state.objects[sessionId]
  if (!sessionId || !fact || !currentObject?.confirmedFacts.includes(fact)) return state
  const now = Date.now()
  return normalizeRelationshipState({
    ...state,
    objects: { ...state.objects, [sessionId]: { ...currentObject, confirmedFacts: currentObject.confirmedFacts.filter((item) => item !== fact), updatedAt: now } },
    updatedAt: now
  })
}

export function removeRelationshipHypothesis(state: RelationshipProfileState, sessionIdRaw: string, valueRaw: string): RelationshipProfileState {
  const sessionId = String(sessionIdRaw || '').trim()
  const value = cleanString(valueRaw)
  const currentObject = state.objects[sessionId]
  if (!sessionId || !value || !currentObject?.hypotheses.some((item) => item.value === value)) return state
  const now = Date.now()
  return normalizeRelationshipState({
    ...state,
    objects: { ...state.objects, [sessionId]: { ...currentObject, hypotheses: currentObject.hypotheses.filter((item) => item.value !== value), updatedAt: now } },
    updatedAt: now
  })
}

export function buildRelationshipMemoryContext(state: RelationshipProfileState, sessionIdRaw: string, query = '', replyMode?: string): string {
  if (!state.memoryEnabled) return ''
  const sessionId = String(sessionIdRaw || '').trim()
  if (!sessionId) return ''
  const object = state.objects[sessionId]
  const strategy = state.relationships[sessionId]
  const self = object?.selfProfile
  const user = state.user
  const lines = ['【用户已授权的关系档案（仅作背景，不是聊天证据）】']
  // Explicit boundaries must never be silently discarded by the context budget.
  for (const [label, values] of [
    ['这段关系中的边界', self?.boundaries], ['用户边界', user.boundaries]
  ] as const) {
    if (values?.length) lines.push(`${label}：${values.join('；')}`)
  }
  if (lines.join('\n').length > 6000) throw new Error('已确认的边界超出模型上下文预算，请精简边界后再生成建议；不会忽略任何边界')
  const add = (label: string, value: string | undefined, max = 220) => {
    if (value?.trim()) lines.push(`${label}：${value.trim().slice(0, max)}`)
  }
  const addList = (label: string, values: string[] | undefined, max = 3) =>
    add(label, values?.slice(-max).map((value) => value.slice(0, 100)).join('；'), max * 102)
  const terms = Array.from(new Set(query.toLowerCase().match(/[\u4e00-\u9fff]{2,4}|[a-z0-9_]{2,}/g) || [])).slice(0, 20)
  const relevant = <T,>(items: T[], text: (item: T) => string, limit: number): T[] => items.map((item, index) => ({
    item, index, score: terms.reduce((score, term) => score + Number(text(item).toLowerCase().includes(term)), 0)
  })).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, limit).map((entry) => entry.item)
  if (strategy) {
    add('用户在这段关系中的角色', strategy.role)
    if (strategy.expiresAt && strategy.expiresAt <= Date.now()) {
      lines.push('关系策略已过期，阶段、目标、态度和行动需要用户重新确认。')
    } else {
      add('当前目标', strategy.goal)
      add('当前回复态度', strategy.replyAttitude)
      add('停止条件', strategy.stopCondition)
      add('当前关系阶段', strategy.stage)
      add('当前行动', strategy.currentAction)
      add('观察窗口', strategy.observationWindow)
    }
  }
  if (self) {
    lines.push('【我在当前关系中的画像，仅适用于当前对象】')
    const scopeOf = (value: string) => self.communicationPreferenceModes?.[value]
    const preferences = (self.communicationPreferences || []).filter((value) => !replyMode || !scopeOf(value) || scopeOf(value) === replyMode)
    addList('这段关系中的沟通偏好', relevant(preferences, (value) => value, 6).map((value) => `${scopeOf(value) ? `〔仅用于 ${scopeOf(value)} 模式〕` : ''}${value}`), 6)
    addList('这段关系中的限制', self.limitations, 2)
    addList('这段关系中的优势', self.strengths, 2)
    const examples = relevant((object?.fieldSources || []).filter((entry) => entry.expressionExample && preferences.includes(entry.value)),
      (entry) => `${entry.value} ${entry.expressionExample?.feedback}`, 2)
    add('用户明确确认的当前关系表达范例（不是已发送消息或固定观点；只参考表达方式）', examples.map((entry) => {
      const example = entry.expressionExample!
      return `${entry.replyMode ? `适用模式：${entry.replyMode}；` : ''}偏好：${entry.value.slice(0, 100)}；不认可的表达：「${example.previous.slice(0, 100)}」；认可的表达：「${example.approved.slice(0, 120)}」；修改依据：${example.feedback.slice(0, 100)}`
    }).join('\n'), 1000)
  }
  add('用户称呼', user.displayLabel, 60)
  add('用户 MBTI（用户提供）', user.mbti, 40)
  if (user.subjectiveScore !== undefined) add('用户主观综合评分（用户自评）', String(user.subjectiveScore))
  addList('用户优势', user.strengths, 2)
  addList('用户短板', user.limitations, 2)
  addList('用户沟通偏好', user.communicationPreferences, 2)
  if (object) {
    add('对象称呼', object.displayLabel, 60)
    add('对象 MBTI（用户提供）', object.mbti, 40)
    if (object.subjectiveScore !== undefined) add('对象主观综合评分（用户评价）', String(object.subjectiveScore))
    addList('已确认事实', relevant(object.confirmedFacts, (value) => value, 6), 6)
    const hypotheses = relevant(object.hypotheses.filter((item) => relationshipHypothesisStatus(item) === 'active'), (item) => item.value, 3)
    add('暂定推测（不可当作事实）', hypotheses.map((item) => `${item.value.slice(0, 90)}〔${item.confidence}〕`).join('；'), 300)
    const refuted = object.hypotheses.filter((item) => relationshipHypothesisStatus(item) === 'refuted').slice(-3)
    add('用户已否定的旧解释（禁止当成有效推测或事实）', refuted.map((item) => item.value.slice(0, 90)).join('；'), 300)
    const events = relevant(object.keyEvents, (item) => item.summary, 4)
    add('相关关键事件', events.map((item) => `${item.occurredAt} ${item.summary.slice(0, 90)}`).join('；'), 420)
    const feedback = (object.replyOutcomes || []).slice(-3)
    add('最近回复反馈（用户手动记录，未核验实际消息；已复制不等于已发送，不能推断因果或自动学习偏好）', feedback.map((item) => {
      const earlier = (item.history || []).filter((event) => event.createdAt !== item.createdAt || event.outcome !== item.outcome || event.draft !== item.draft).slice(-2)
      const trail = earlier.length ? `；此前记录：${earlier.map((event) => `${event.outcome}「${event.draft?.slice(0, 70) || '旧记录未保存对应文本，不得归因于当前草稿'}」`).join('；')}` : ''
      return `${item.mode || '自然'}；当前记录：${item.outcome}「${item.draft.slice(0, 70)}」${trail}`
    }).join('\n'), 1000)
    add('历史回复的当次意图与修改（只解释当次反馈，不是长期目标或已确认偏好）', feedback.filter((item) => item.intent || item.revisionFeedback).map((item) => `当次意图：${item.intent?.slice(0, 80) || '未说明'}；修改意见：${item.revisionFeedback?.slice(0, 100) || '无'}`).join('；'), 400)
  }
  return lines.length === 1 ? '' : lines.join('\n').slice(0, 6000)
}
