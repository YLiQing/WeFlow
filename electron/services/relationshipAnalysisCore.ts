import { createHash } from 'node:crypto'
import type { RelationshipProfileStatistics, RelationshipAnalysisCheckpoint } from './relationshipProfileCore'

export interface RelationshipMessage {
  id: string
  messageKey: string
  localId: number
  createTime: number
  sender: string
  participant: 'mine' | 'theirs' | 'unknown'
  content: string
  messageType: string
}

export interface RelationshipEvidenceQuery {
  keywords: string[]
  since?: number
  until?: number
  participant?: 'mine' | 'theirs'
}

export function normalizeRelationshipEvidenceQueries(input: unknown): RelationshipEvidenceQuery[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 4).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    // Scope is fixed by the caller; model-provided account/contact selectors are never executed.
    if ('sessionId' in row || 'session_id' in row || 'accountScope' in row || 'account_scope' in row) return []
    const keywords = Array.isArray(row.keywords) ? Array.from(new Set(row.keywords.slice(0, 4)
      .filter((term): term is string => typeof term === 'string' && term.trim().length >= 2 && term.trim().length <= 40)
      .map((term) => term.trim()))) : []
    const time = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 4_000_000_000 ? value : undefined
    const since = time(row.since), until = time(row.until)
    if (row.since != null && since === undefined || row.until != null && until === undefined || since && until && since > until) return []
    if (!keywords.length && since === undefined && until === undefined) return []
    if (row.participant != null && row.participant !== 'mine' && row.participant !== 'theirs') return []
    return [{ keywords, since, until, participant: row.participant as RelationshipEvidenceQuery['participant'] }]
  })
}

export function queryRelationshipEvidence(sessionId: string, messages: RelationshipMessage[], input: unknown) {
  const queries = normalizeRelationshipEvidenceQueries(input)
  const rows = normalizeRelationshipMessages(messages).filter((row) => row.id === relationshipMessageId(sessionId, row.messageKey))
  const evidence = new Map<string, { id: string; messageKey: string; localId: number; createTime: number; sender: string; quote: string; reason: string }>()
  const results = queries.map((query, queryIndex) => {
    const indexes = rows.flatMap((row, index) => row.content && row.messageType !== '系统'
      && (!query.participant || row.participant === query.participant)
      && (query.since === undefined || row.createTime >= query.since)
      && (query.until === undefined || row.createTime <= query.until)
      && (!query.keywords.length || query.keywords.some((word) => row.content.toLowerCase().includes(word.toLowerCase()))) ? [index] : [])
    const ids = new Set<string>()
    // ponytail: literal OR search, two time-distributed hits/query with adjacent context; semantic search can follow measured misses.
    const hits = indexes.length > 1 ? [indexes[0], indexes.at(-1)!] : indexes
    for (const index of hits) for (const neighbor of [index, index - 1, index + 1]) {
      const row = rows[neighbor]
      if (!row?.content || row.messageType === '系统' || Math.abs(row.createTime - rows[index].createTime) > 6 * 3600) continue
      ids.add(row.id)
      if (!evidence.has(row.id)) evidence.set(row.id, { id: row.id, messageKey: row.messageKey, localId: row.localId, createTime: row.createTime,
        sender: row.sender, quote: row.content.slice(0, 220), reason: `历史查询 ${queryIndex + 1}${neighbor === index ? '：命中' : '：上下文'}（${query.keywords.join(' / ') || '时间段'}）` })
    }
    return { query, matchedMessages: indexes.length, returnedEvidenceIds: Array.from(ids) }
  })
  return { results, evidence: Array.from(evidence.values()).sort((a, b) => a.createTime - b.createTime || a.id.localeCompare(b.id)) }
}

export async function retrieveRelationshipReplyEvidence(
  sessionId: string, input: unknown,
  search: (keyword: string, query: RelationshipEvidenceQuery) => Promise<RelationshipMessage[]>,
  around: (message: RelationshipMessage) => Promise<RelationshipMessage[]>,
  checkTask: () => void
) {
  const evidence = new Map<string, { id: string; messageKey: string; localId: number; createTime: number; sender: string; quote: string; reason: string }>()
  const queries = normalizeRelationshipEvidenceQueries(input).filter((query) => query.keywords.length).slice(0, 2)
    .map((query) => ({ ...query, keywords: query.keywords.slice(0, 3) }))
  const results = []
  for (const [index, query] of queries.entries()) {
    const candidates: RelationshipMessage[] = []
    for (const keyword of query.keywords) {
      checkTask()
      candidates.push(...(await search(keyword, query)).slice(0, 8))
      checkTask()
    }
    const valid = (row: RelationshipMessage) => row.id === relationshipMessageId(sessionId, row.messageKey)
      && row.content && row.messageType !== '系统'
    const matches = normalizeRelationshipMessages(candidates).filter((row) => valid(row)
      && (!query.participant || row.participant === query.participant)
      && (query.since === undefined || row.createTime >= query.since)
      && (query.until === undefined || row.createTime <= query.until)
      && query.keywords.some((word) => row.content.toLowerCase().includes(word.toLowerCase())))
    const ids = new Set<string>()
    // ponytail: bounded database keyword search, not a full-history or semantic recall guarantee.
    for (const hit of matches.length > 1 ? [matches[0], matches.at(-1)!] : matches) {
      checkTask()
      const neighbors = (await around(hit)).slice(0, 2)
      checkTask()
      for (const row of [hit, ...neighbors]) {
        if (!valid(row) || Math.abs(row.createTime - hit.createTime) > 6 * 3600 || evidence.size >= 12 && !evidence.has(row.id)) continue
        ids.add(row.id)
        evidence.set(row.id, { id: row.id, messageKey: row.messageKey, localId: row.localId, createTime: row.createTime,
          sender: row.sender, quote: row.content.slice(0, 220), reason: `回复历史查询 ${index + 1}：${row.id === hit.id ? '命中' : '上下文'}` })
      }
    }
    results.push({ query, returnedMatches: matches.length, limited: true, evidenceIds: Array.from(ids) })
  }
  return { results, evidence: Array.from(evidence.values()).sort((a, b) => a.createTime - b.createTime || a.id.localeCompare(b.id)) }
}

export function relationshipMessageType(type: number): string {
  return ({ 0: '文本', 1: '文本', 3: '图片', 34: '语音', 43: '视频', 47: '表情', 49: '链接/文件', 10000: '系统' } as Record<number, string>)[type] || `类型${type}`
}

export function relationshipMessageId(sessionId: string, messageKey: string): string {
  return `m-${createHash('sha256').update(`${sessionId}\0${messageKey}`).digest('hex').slice(0, 24)}`
}

export function resolveRelationshipParticipant(message: { senderUsername?: string | null; isSend?: number | null }, myId: string, objectId: string): RelationshipMessage['participant'] {
  const sender = String(message.senderUsername || '').trim().toLowerCase()
  if (sender && sender === myId.trim().toLowerCase()) return 'mine'
  if (sender && sender === objectId.trim().toLowerCase()) return 'theirs'
  // 未知账号不能通过前缀相似度被认成我或对方；只接受数据库明确的收发标记。
  return message.isSend === 1 ? 'mine' : message.isSend === 0 ? 'theirs' : 'unknown'
}

export async function readRelationshipPages<T>(read: (offset: number) => Promise<{ success: boolean; error?: string; messages?: T[]; nextOffset?: number; hasMore?: boolean }>, onPage: (count: number) => void): Promise<T[]> {
  const messages: T[] = []
  let offset = 0
  while (true) {
    const page = await read(offset)
    if (!page.success) throw new Error(page.error || '读取聊天记录失败')
    messages.push(...(page.messages || []))
    onPage(messages.length)
    if (!page.hasMore) return messages
    const next = page.nextOffset ?? offset + (page.messages?.length || 0)
    if (!Number.isFinite(next) || next <= offset) throw new Error('聊天记录分页没有继续前进，请重试；本次未生成不完整分析')
    offset = next
  }
}

export function normalizeRelationshipMessages(messages: RelationshipMessage[]): RelationshipMessage[] {
  return Array.from(new Map(messages.map((message) => [message.id, {
    ...message, createTime: message.createTime > 10_000_000_000 ? Math.floor(message.createTime / 1000) : message.createTime
  }])).values()).sort((a, b) => a.createTime - b.createTime || a.id.localeCompare(b.id))
}

export function relationshipSourceFingerprint(messages: RelationshipMessage[], checkpoint?: Pick<RelationshipAnalysisCheckpoint, 'lastMessageAt' | 'boundaryMessageIds' | 'lastMessageId'>): string {
  const boundary = new Set(checkpoint?.boundaryMessageIds?.length ? checkpoint.boundaryMessageIds : [checkpoint?.lastMessageId])
  const rows = normalizeRelationshipMessages(messages).filter((row) => !checkpoint?.lastMessageAt
    || row.createTime < checkpoint.lastMessageAt || row.createTime === checkpoint.lastMessageAt && boundary.has(row.id))
  // Display labels are editable metadata, not source message identity.
  return createHash('sha256').update(JSON.stringify(rows.map(({ id, messageKey, localId, createTime, participant, content, messageType }) =>
    [id, messageKey, localId, createTime, participant, content, messageType]))).digest('hex')
}

export function relationshipMessagesSinceCheckpoint(messages: RelationshipMessage[], checkpoint?: RelationshipAnalysisCheckpoint): RelationshipMessage[] {
  if (!checkpoint?.lastMessageAt) return messages
  const boundary = new Set(checkpoint.boundaryMessageIds?.length ? checkpoint.boundaryMessageIds : [checkpoint.lastMessageId])
  return messages.filter((message) => message.createTime > checkpoint.lastMessageAt! || (message.createTime === checkpoint.lastMessageAt && !boundary.has(message.id)))
}

export function buildRelationshipStatistics(messages: RelationshipMessage[]): RelationshipProfileStatistics {
  const sorted = normalizeRelationshipMessages(messages)
  const day = new Map<string, { date: string; mine: number; theirs: number; total: number }>()
  const week = new Map<string, { week: string; mine: number; theirs: number; total: number }>()
  const types: Record<string, number> = {}
  const keywords = new Map<string, number>()
  const intervals: number[] = []
  const stopwords = new Set(['然后', '就是', '这个', '那个', '可以', '还是', '我们', '你们', '哈哈', '好的', '真的', '什么', '怎么', '没有', '不是'])
  let myMessages = 0, objectMessages = 0, unknownMessages = 0
  let myInitiations = 0, objectInitiations = 0, conversationSegments = 0, longestSilence = 0
  let myReplyCount = 0, objectReplyCount = 0, myTurns = 0, objectTurns = 0
  let previous: RelationshipMessage | undefined
  let segmentStart = 0, segmentCount = 0, longestConversationMessages = 0, longestConversationDuration = 0
  for (const item of sorted) {
    types[item.messageType] = (types[item.messageType] || 0) + 1
    if (item.participant === 'mine') myMessages++
    else if (item.participant === 'theirs') objectMessages++
    else unknownMessages++
    // 日历统计统一采用北京时间，避免 UTC 零点切开本地一天。
    const date = new Date((item.createTime + 8 * 3600) * 1000)
    const dateKey = date.toISOString().slice(0, 10)
    const daily = day.get(dateKey) || { date: dateKey, mine: 0, theirs: 0, total: 0 }
    daily.total++
    if (item.participant === 'mine') daily.mine++
    if (item.participant === 'theirs') daily.theirs++
    day.set(dateKey, daily)
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() || 7) + 1)
    const weekKey = date.toISOString().slice(0, 10)
    const weekly = week.get(weekKey) || { week: weekKey, mine: 0, theirs: 0, total: 0 }
    weekly.total++
    if (item.participant === 'mine') weekly.mine++
    if (item.participant === 'theirs') weekly.theirs++
    week.set(weekKey, weekly)
    if (item.messageType === '文本') {
      // ponytail: 主题候选使用轻量词段统计，精确中文分词可复用项目 jieba。
      for (const token of item.content.match(/[\u4e00-\u9fff]{2,8}|[A-Za-z0-9_]{2,}/g) || []) {
        if (!stopwords.has(token)) keywords.set(token, (keywords.get(token) || 0) + 1)
      }
    }
    if (item.participant === 'unknown' || item.messageType === '系统') continue
    const gap = previous ? item.createTime - previous.createTime : 0
    longestSilence = Math.max(longestSilence, gap)
    const newSegment = !previous || gap > 6 * 3600
    if (newSegment) {
      conversationSegments++
      segmentStart = item.createTime
      segmentCount = 0
      if (item.participant === 'mine') myInitiations++
      else objectInitiations++
    }
    segmentCount++
    longestConversationMessages = Math.max(longestConversationMessages, segmentCount)
    longestConversationDuration = Math.max(longestConversationDuration, item.createTime - segmentStart)
    const newTurn = newSegment || previous?.participant !== item.participant
    if (newTurn) {
      if (item.participant === 'mine') myTurns++
      else objectTurns++
    }
    if (previous && !newSegment && previous.participant !== item.participant) {
      if (item.participant === 'mine') myReplyCount++
      else objectReplyCount++
      intervals.push(gap)
    }
    previous = item
  }
  intervals.sort((a, b) => a - b)
  const middle = Math.floor(intervals.length / 2)
  return {
    totalMessages: sorted.length, myMessages, objectMessages, unknownMessages, myInitiations, objectInitiations,
    myReplyCount, objectReplyCount, replyCount: myReplyCount + objectReplyCount,
    // 回复率按对方的连续发言回合计算；超过六小时开启新段，不视为原回合回复。
    myReplyRate: objectTurns ? myReplyCount / objectTurns : undefined,
    objectReplyRate: myTurns ? objectReplyCount / myTurns : undefined,
    replyRate: myTurns + objectTurns ? (myReplyCount + objectReplyCount) / (myTurns + objectTurns) : undefined,
    averageReplyInterval: intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : undefined,
    medianReplyInterval: intervals.length ? intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2 : undefined,
    conversationSegments, longestSilence: longestSilence || undefined, longestConversationMessages, longestConversationDuration,
    firstMessageAt: sorted[0]?.createTime, lastMessageAt: sorted.at(-1)?.createTime,
    dailyActivity: Array.from(day.values()), weeklyActivity: Array.from(week.values()), messageTypes: types,
    topKeywords: Array.from(keywords, ([keyword, count]) => ({ keyword, count })).sort((a, b) => b.count - a.count).slice(0, 20)
  }
}

export function selectRelationshipEvidence(messages: RelationshipMessage[], statistics: RelationshipProfileStatistics, max = 48) {
  const sorted = normalizeRelationshipMessages(messages).filter((item) => item.content)
  const selected = new Map<string, { id: string; messageKey: string; localId: number; createTime: number; sender: string; quote: string; reason: string }>()
  const add = (index: number, reason: string) => {
    const item = sorted[index]
    if (!item || selected.has(item.id) || selected.size >= max) return
    selected.set(item.id, { id: item.id, messageKey: item.messageKey, localId: item.localId, createTime: item.createTime, sender: item.sender, quote: item.content.slice(0, 220), reason })
  }
  const sample = (indexes: number[], quota: number, reason: string, context = false) => {
    const count = Math.min(quota, indexes.length)
    for (let i = 0; i < count; i++) {
      const index = indexes[Math.floor(i * (indexes.length - 1) / Math.max(1, count - 1))]
      if (context) add(index - 1, `${reason}：前文`)
      add(index, reason)
      if (context) add(index + 1, `${reason}：后文`)
    }
  }
  sample(sorted.map((_, i) => i), Math.min(12, max), '时间线覆盖')
  const categories = [
    { reason: '沉默前后', matches: (_: RelationshipMessage, i: number) => i > 0 && sorted[i].createTime - sorted[i - 1].createTime > 24 * 3600 },
    { reason: '邀约与拒绝', matches: (item: RelationshipMessage) => /见面|一起|约|不方便|不想|改天|拒绝/.test(item.content) },
    { reason: '冲突与修复', matches: (item: RelationshipMessage) => /抱歉|对不起|生气|难过|误会|别联系|停止/.test(item.content) },
    { reason: '主动开启', matches: (_: RelationshipMessage, i: number) => i === 0 || sorted[i].createTime - sorted[i - 1].createTime > 6 * 3600 },
    { reason: '高频主题', matches: (item: RelationshipMessage) => statistics.topKeywords.slice(0, 6).some(({ keyword }) => item.content.includes(keyword)) }
  ]
  for (const category of categories) sample(sorted.flatMap((item, i) => category.matches(item, i) ? [i] : []), 2, category.reason, true)
  sample(sorted.map((_, i) => i), max - selected.size, '补充时间线')
  return Array.from(selected.values()).sort((a, b) => a.createTime - b.createTime || a.id.localeCompare(b.id))
}
