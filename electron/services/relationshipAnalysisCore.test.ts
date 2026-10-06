import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRelationshipStatistics, normalizeRelationshipMessages, relationshipSourceFingerprint, readRelationshipPages, relationshipMessageId, relationshipMessagesSinceCheckpoint, relationshipMessageType, selectRelationshipEvidence, resolveRelationshipParticipant, normalizeRelationshipEvidenceQueries, queryRelationshipEvidence, retrieveRelationshipReplyEvidence, type RelationshipMessage } from './relationshipAnalysisCore.ts'

const message = (id: number, time: number, participant: RelationshipMessage['participant'], content = '周末见面') => ({
  id: relationshipMessageId('alice', `key-${id}`), messageKey: `key-${id}`, localId: id, createTime: time,
  sender: participant === 'mine' ? '我' : participant === 'theirs' ? 'Alice' : '未知', participant, content, messageType: '文本'
})

test('原文指纹校验覆盖历史变更，不因正常新增、排序、重复或对象改名失效', () => {
  const rows = [message(1, 100, 'mine'), message(2, 101, 'theirs')]
  const expected = relationshipSourceFingerprint(rows)
  const checkpoint = { lastMessageAt: 101, lastMessageId: rows[1].id, boundaryMessageIds: [rows[1].id] }
  assert.equal(relationshipSourceFingerprint([...rows, message(3, 101, 'mine'), message(4, 102, 'theirs')], checkpoint), expected)
  assert.equal(relationshipSourceFingerprint([rows[1], rows[0], rows[0]]), expected)
  assert.equal(relationshipSourceFingerprint(rows.map((row) => ({ ...row, sender: '新称呼' }))), expected)
  const dated = rows.map((row) => ({ ...row, createTime: 1_700_000_000 + row.createTime }))
  assert.equal(relationshipSourceFingerprint(dated.map((row) => ({ ...row, createTime: row.createTime * 1000 }))), relationshipSourceFingerprint(dated))
  for (const patch of [{ content: '修改正文' }, { participant: 'mine' as const }, { messageType: '图片' }, { createTime: 100 }, { localId: 20 }]) {
    assert.notEqual(relationshipSourceFingerprint([rows[0], { ...rows[1], ...patch }], checkpoint), expected)
  }
  assert.notEqual(relationshipSourceFingerprint(rows.slice(0, 1), checkpoint), expected)
  assert.notEqual(relationshipSourceFingerprint([message(5, 90, 'mine'), ...rows], checkpoint), expected)
  const boundedCheckpoint = { lastMessageAt: 100, lastMessageId: rows[0].id, boundaryMessageIds: [rows[0].id] }
  const bounded = relationshipSourceFingerprint(rows, boundedCheckpoint)
  assert.equal(bounded, relationshipSourceFingerprint([rows[0]], boundedCheckpoint))
  assert.equal(relationshipSourceFingerprint([...rows, message(3, 100, 'theirs')], boundedCheckpoint), bounded)
})

test('回复历史检索限制查询、消息和上下文预算，过滤跨会话及错位命中', async () => {
  const searches: string[] = [], contexts: number[] = []
  const queries = Array.from({ length: 8 }, () => ({ keywords: ['称呼', '约定', '拒绝', '不会执行'], participant: 'theirs' }))
  const rows = Array.from({ length: 40 }, (_, i) => message(i, 100 + i, 'theirs', '称呼约定拒绝'.repeat(60)))
  const retrieval = await retrieveRelationshipReplyEvidence('alice', queries, async (word) => { searches.push(word); return rows }, async (hit) => {
    contexts.push(hit.localId)
    return [message(100 + hit.localId, hit.createTime - 1, 'mine', '我的表达'), message(200 + hit.localId, hit.createTime + 1, 'theirs', '对方回答'), message(900, 999, 'theirs', '超预算')]
  }, () => {})
  assert.equal(searches.length, 6)
  assert.ok(!searches.includes('不会执行'))
  assert.equal(contexts.length, 4)
  assert.equal(retrieval.results.length, 2)
  assert.ok(retrieval.results.every((result) => result.limited))
  assert.ok(retrieval.evidence.length <= 12)
  assert.ok(retrieval.evidence.every((item) => item.quote.length <= 220 && item.localId !== 900))
  const wrong = [{ ...message(1, 100, 'theirs', '约定'), id: relationshipMessageId('bob', 'key-1') }, message(2, 100, 'mine', '约定'), message(3, 500, 'theirs', '约定'), message(4, 110, 'theirs', '不相关')]
  const filtered = await retrieveRelationshipReplyEvidence('alice', [{ keywords: ['约定'], participant: 'theirs', since: 100, until: 200 }], async () => wrong, async () => { throw new Error('should not read context') }, () => {})
  assert.equal(filtered.evidence.length, 0)
  assert.equal(filtered.results[0].returnedMatches, 0)
  const invalid = await retrieveRelationshipReplyEvidence('alice', [{ keywords: ['约定'], session_id: 'bob' }, { since: 100 }], async () => { throw new Error('should not search') }, async () => [], () => {})
  assert.equal(invalid.results.length, 0)
  await assert.rejects(retrieveRelationshipReplyEvidence('alice', [{ keywords: ['约定'] }], async () => { throw new Error('读取失败') }, async () => [], () => {}), /读取失败/)
  let cancelled = false
  await assert.rejects(retrieveRelationshipReplyEvidence('alice', [{ keywords: ['约定'] }], async () => { cancelled = true; return rows }, async () => [], () => { if (cancelled) throw new Error('任务取消') }), /任务取消/)
})

test('历史查询限制范围、关键词、时间与预算；不执行跨联系人或无限查询', () => {
  assert.equal(normalizeRelationshipEvidenceQueries([{ keywords: ['x'] }, {}, { keywords: ['承诺'], session_id: 'bob' }, { since: '2026-01-01' }]).length, 0)
  assert.equal(normalizeRelationshipEvidenceQueries([{ since: 200, until: 100 }, { keywords: ['承诺'], participant: 'unknown' }]).length, 0)
  assert.equal(normalizeRelationshipEvidenceQueries([{ keywords: ['承诺'], since: 1_800_000_000_000 }]).length, 0)
  const queries = normalizeRelationshipEvidenceQueries(Array.from({ length: 10 }, () => ({ keywords: ['承诺', '承诺', '生日', '纪念日', '第五个'], since: 100, until: 200, participant: 'theirs' })))
  assert.equal(queries.length, 4)
  assert.deepEqual(queries[0].keywords, ['承诺', '生日', '纪念日'])
  const rows = [message(1, 100, 'mine', '生日快乐'), message(2, 110, 'theirs', '生日谢谢'), message(3, 120, 'mine', '记得承诺'),
    { ...message(4, 130, 'theirs', '生日来自其他人'), id: relationshipMessageId('bob', 'key-4') }, message(5, 40000, 'mine', '不相关旧消息')]
  const result = queryRelationshipEvidence('alice', rows, queries)
  assert.equal(result.results[0].matchedMessages, 1)
  assert.ok(result.evidence.some((entry) => entry.localId === 2))
  assert.ok(result.evidence.some((entry) => entry.localId === 1))
  assert.ok(!result.evidence.some((entry) => entry.localId === 4 || entry.localId === 5))
  const absent = queryRelationshipEvidence('alice', rows, [{ keywords: ['不存在'] }])
  assert.equal(absent.results[0].matchedMessages, 0)
  assert.equal(absent.evidence.length, 0)
  assert.equal(queryRelationshipEvidence('alice', rows, [{ keywords: ['.*'] }]).results[0].matchedMessages, 0)
  const dateOnly = queryRelationshipEvidence('alice', rows, [{ since: 105, until: 115 }])
  assert.equal(dateOnly.results[0].matchedMessages, 1)
  assert.ok(dateOnly.evidence.some((entry) => entry.localId === 2))
  const long = Array.from({ length: 2000 }, (_, i) => message(i + 1, 100 + i, i % 2 ? 'mine' : 'theirs', '生日承诺纪念日'))
  const limited = queryRelationshipEvidence('alice', long, queries.map((entry) => ({ ...entry, until: 3000 })))
  assert.ok(limited.evidence.length <= 24)
  assert.ok(limited.evidence.some((entry) => entry.localId <= 3))
  assert.ok(limited.evidence.some((entry) => entry.localId >= 1998))
  for (const entry of limited.evidence) assert.equal(entry.quote, long.find((row) => row.id === entry.id)?.content)
})

test('增量边界保留同一秒新增消息且排除已分析边界消息', () => {
  const rows = [message(1, 100, 'mine'), message(2, 100, 'theirs'), message(3, 100, 'mine'), message(4, 101, 'theirs')]
  const checkpoint = { lastMessageAt: 100, lastMessageId: rows[1].id, boundaryMessageIds: [rows[0].id, rows[1].id], totalMessages: 2, analyzedAt: 1 }
  assert.deepEqual(relationshipMessagesSinceCheckpoint(rows, checkpoint).map((row) => row.id), [rows[2].id, rows[3].id])
})

test('身份始终按当前账号和联系人映射；相似账号和无收发标记不能被猜测', () => {
  assert.equal(resolveRelationshipParticipant({ senderUsername: 'wxid_me', isSend: 0 }, 'wxid_me', 'wxid_alice'), 'mine')
  assert.equal(resolveRelationshipParticipant({ senderUsername: 'wxid_alice', isSend: 1 }, 'wxid_me', 'wxid_alice'), 'theirs')
  assert.equal(resolveRelationshipParticipant({ senderUsername: 'wxid_me_other', isSend: null }, 'wxid_me', 'wxid_alice'), 'unknown')
  assert.equal(resolveRelationshipParticipant({ senderUsername: null, isSend: 1 }, 'wxid_me', 'wxid_alice'), 'mine')
  assert.equal(resolveRelationshipParticipant({ senderUsername: null, isSend: 0 }, 'wxid_me', 'wxid_alice'), 'theirs')
})

test('分页读取到 hasMore=false，包括有下一游标的空页；失败和无前进游标不能伪装全量成功', async () => {
  const offsets: number[] = []
  const messages = await readRelationshipPages(async (offset) => {
    offsets.push(offset)
    if (offset === 0) return { success: true, messages: [1, 2], nextOffset: 5, hasMore: true }
    if (offset === 5) return { success: true, messages: [], nextOffset: 7, hasMore: true }
    return { success: true, messages: [2, 3], hasMore: false }
  }, () => {})
  assert.deepEqual(offsets, [0, 5, 7])
  assert.deepEqual(messages, [1, 2, 2, 3])
  await assert.rejects(readRelationshipPages(async () => ({ success: true, hasMore: true, nextOffset: 0 }), () => {}), /没有继续前进/)
  await assert.rejects(readRelationshipPages(async () => ({ success: false, error: '断开连接' }), () => {}), /断开连接/)
})

test('统计去重升序、归一化秒毫秒、分离未知身份，双方回复率不会超过 1', () => {
  const rows = [message(1, 100, 'mine'), message(2, 110, 'mine'), message(3, 120, 'theirs'), message(4, 130, 'mine'), message(5, 140, 'theirs'), message(6, 150, 'unknown'), message(7, 40000, 'theirs')]
  const normalized = normalizeRelationshipMessages([rows[2], rows[0], rows[1], rows[2], message(8, 1_800_000_000_000, 'mine')])
  assert.equal(normalized.length, 4)
  assert.equal(normalized[0].localId, 1)
  assert.equal(normalized.at(-1)?.createTime, 1_800_000_000)
  const stats = buildRelationshipStatistics([...rows].reverse())
  assert.equal(stats.totalMessages, 7)
  assert.equal(stats.myMessages, 3)
  assert.equal(stats.objectMessages, 3)
  assert.equal(stats.unknownMessages, 1)
  assert.equal(stats.myReplyCount, 1)
  assert.equal(stats.objectReplyCount, 2)
  assert.equal(stats.objectReplyRate, 1)
  assert.equal(stats.myReplyRate, 1 / 3)
  assert.equal(stats.myInitiations, 1)
  assert.equal(stats.objectInitiations, 1)
  assert.equal(stats.conversationSegments, 2)
  assert.equal(stats.averageReplyInterval, 10)
  assert.equal(stats.medianReplyInterval, 10)
  assert.equal(stats.longestConversationMessages, 5)
  assert.equal(relationshipMessageType(1), '文本')
  assert.equal(relationshipMessageType(34), '语音')
})

test('年月活跃度采用北京时间，未知与附件记录仍计入统计', () => {
  const timestamp = Date.UTC(2026, 8, 30, 20) / 1000
  const rows = [message(1, timestamp, 'mine'), { ...message(2, timestamp + 1, 'unknown', '[其他消息]'), messageType: '图片' }]
  const stats = buildRelationshipStatistics(rows)
  assert.equal(stats.dailyActivity[0].date, '2026-10-01')
  assert.equal(stats.dailyActivity[0].total, 2)
  assert.equal(stats.messageTypes.图片, 1)
})

test('多年证据保留时间覆盖和关键行为上下文，引用能回溯且编号不含数据库路径', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => message(i + 1, 1_600_000_000 + i * 3600, i % 2 ? 'mine' : 'theirs', i === 1500 ? '对不起，昨天有误会' : i === 1000 ? '下次一起见面' : '普通对话'))
  const evidence = selectRelationshipEvidence(rows, buildRelationshipStatistics(rows))
  assert.ok(evidence.length <= 48)
  for (let quarter = 0; quarter < 4; quarter++) assert.ok(evidence.some((item) => item.localId > quarter * 500 && item.localId <= (quarter + 1) * 500))
  assert.ok(evidence.some((item) => item.localId === 1501))
  assert.ok(evidence.some((item) => item.localId === 1500))
  assert.ok(evidence.some((item) => item.localId === 1502))
  for (const item of evidence) {
    const original = rows.find((row) => row.id === item.id)
    assert.equal(item.messageKey, original?.messageKey)
    assert.equal(item.quote, original?.content)
  }
  const key = 'D%3A%5Cwechat_files%5Cmessage.db:Msg:123'
  assert.match(relationshipMessageId('alice', key), /^m-[a-f0-9]{24}$/)
  assert.notEqual(relationshipMessageId('alice', key), relationshipMessageId('bob', key))
})
