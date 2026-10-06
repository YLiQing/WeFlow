const assert = require('node:assert/strict')
const test = require('node:test')
const http = require('node:http')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')
const fs = require('node:fs')
const os = require('node:os')

test('审核 IPC 使用真实持久化档案：重启后原文校验、拒绝与逐项接受', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-source-review-'))
  const fixture = {
    directory, account: 'me', endpoint: '', apiCalls: 0,
    messages: Array.from({ length: 510 }, (_, i) => ({ messageKey: `source-${i}`, localId: i + 1, createTime: 1_700_000_000 + i,
      isSend: i % 2, senderUsername: i % 2 ? 'me' : 'alice', localType: 1, parsedContent: `源消息-${i}`, rawContent: '' }))
  }
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      fixture.apiCalls++
      const input = JSON.parse(body)
      fixture.requestPrompts ||= []; fixture.requestPrompts.push(input.messages)
      const content = input.messages[0].content.includes('回复助手') ? { draft: '收到，改天再聊', reason: '尊重当次安排', risk: '仍需确认安排', positive_follow_up: '确认时间', ambiguous_follow_up: '等待回复', no_response_plan: '不继续追问' }
        : input.messages[0].content.includes('字段整理器')
        ? { user: { communication_preferences: [{ value: '对这个联系人简短直接', confidence: 'low', evidence_ids: [] }], strengths: [], limitations: [], boundaries: [] },
          object: { confirmed_facts: [{ value: '需要人工核实的事实', confidence: 'low', evidence_ids: [] }], hypotheses: [], key_events: [] }, relationship: {} }
        : { facts: [], hypotheses: [], unknowns: [] }
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  fixture.endpoint = `http://127.0.0.1:${server.address().port}/v1`
  const load = async () => {
    const bundled = await esbuild.build({
      stdin: { contents: 'export { insightService } from "./insightService"; export { relationshipProfileService } from "./relationshipProfileService"', resolveDir: __dirname },
      bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'source-review-fixture', setup(build) {
        build.onResolve({ filter: /^(electron|\.\/config|\.\/chatService|\.\/wcdbService|\.\/snsService|\.\/social\/weiboService|\.\.\/windows\/notificationWindow|\.\/insightProfileService|\.\/insightRecordService)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
          const modules = {
            electron: 'export const app = { getPath: () => fixture.directory }',
            './config': 'export const ConfigService = { getInstance: () => ({ getMyWxidCleaned: () => fixture.account, get: (key) => ({ aiModelApiBaseUrl: fixture.endpoint, aiModelApiKey: "test-only", aiModelApiModel: "fixture", aiModelApiMaxTokens: 4096 })[key] }) }',
            './chatService': `export const chatService = {
              getMessages: async (id, offset, size, since, until) => { if (fixture.onRead) await fixture.onRead(); const rows = fixture.messages.filter(row => row.createTime >= since && (!until || row.createTime <= until)); return { success: true, messages: rows.slice(offset,offset+size), nextOffset: offset+size, hasMore: offset+size < rows.length } },
              getLatestMessages: async (id, count) => ({ success: true, messages: fixture.messages.slice(-count) }),
              getSessions: async () => ({ success: true, sessions: [] })
            }`,
            './wcdbService': 'export const wcdbService = { getMessageCount: async () => ({ success: true, count: fixture.messages.length }) }',
            './snsService': 'export const snsService = {}', './social/weiboService': 'export const weiboService = {}',
            '../windows/notificationWindow': 'export const showNotification = () => {}', './insightProfileService': 'export const insightProfileService = {}', './insightRecordService': 'export const insightRecordService = {}'
          }
          return { contents: modules[args.path] }
        })
      } }]
    })
    const module = { exports: {} }
    vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require, fixture, console,
      process: { env: {}, cwd: () => directory }, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, Date })
    return module.exports
  }
  try {
    const initial = await load()
    initial.relationshipProfileService.enableMemory()
    const generated = await initial.insightService.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'source-review' })
    assert.equal(generated.success, true, generated.message)
    const restarted = await load()
    const profile = restarted.relationshipProfileService
    const restored = profile.getPendingReview('alice').review.draft
    assert.equal(restored.coverage.sourceFingerprint, generated.data.coverage.sourceFingerprint)
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8')
    const registration = source.slice(source.indexOf("  ipcMain.handle('relationshipProfile:applyDraft'"), source.indexOf("  ipcMain.handle('insight:analyzeRelationship'"))
    let handler
    vm.runInNewContext(require('typescript').transpileModule(registration, { compilerOptions: { target: 9, module: 1 } }).outputText, {
      ipcMain: { handle: (_name, callback) => { handler = callback } }, insightService: restarted.insightService
    })
    const payload = { sessionId: 'alice', draft: restored, approvals: {}, decisions: { 'confirmedFacts:0': 'accept' } }
    const originalText = fixture.messages[255].parsedContent
    fixture.messages[255].parsedContent = '重启后修改未被抽样的正文'
    const rejected = await handler({}, payload)
    assert.equal(rejected.success, false)
    assert.match(rejected.message, /聊天记录已修改、删除或补录/)
    assert.equal(profile.getState().state.objects.alice, undefined)
    assert.ok(profile.getPendingReview('alice').review)
    const rejection = await handler({}, { ...payload, decisions: { 'confirmedFacts:0': 'reject' } })
    assert.equal(rejection.success, true, rejection.message)
    assert.equal(profile.getState().state.objects.alice, undefined, 'reject-only review does not create memory')
    fixture.messages[255].parsedContent = originalText
    const remaining = profile.getPendingReview('alice').review
    const edited = { ...remaining.draft, user: { ...remaining.draft.user, communicationPreferences: [{ ...remaining.draft.user.communicationPreferences[0], value: '只对这个联系人少用表情' }] } }
    profile.savePendingReview({ ...remaining, draft: edited })
    fixture.messages.push({ ...fixture.messages.at(-1), messageKey: 'new-normal', localId: 9999, parsedContent: '审核前正常新增消息' })
    const approved = await handler({}, { sessionId: 'alice', draft: edited, approvals: {}, decisions: { 'communicationPreferences:0': 'accept' } })
    assert.equal(approved.success, true, approved.message)
    const state = (await load()).relationshipProfileService.getState().state
    assert.equal(state.objects.alice.selfProfile.communicationPreferences[0], '只对这个联系人少用表情')
    assert.equal(state.objects.alice.confirmedFacts.length, 0)
    assert.equal(state.user.communicationPreferences.length, 0)
    assert.equal(state.objects.bob, undefined)
    assert.equal(fixture.apiCalls, 2, 'source checks and review make no additional model calls')
    for (let i = 0; i < 21; i++) profile.confirmReplyPreference({ accountScope: 'wxid:me', sessionId: 'alice', suggestionId: `style-${i}`, value: `散步时少用表情-${i}`, feedback: '散步聊天要自然', expressionExample: { previous: '一起去散步！！！', approved: '一起散步吗' } })
    profile.confirmReplyPreference({ accountScope: 'wxid:me', sessionId: 'alice', suggestionId: 'only-repair', value: '修复误会时不要讽刺', feedback: '别阴阳怪气', replyMode: 'repair', expressionExample: { previous: '你开心就好', approved: '刚才我的语气不太好' } })
    const afterMemoryRestart = await load()
    const naturalReply = await afterMemoryRestart.insightService.generateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', mode: 'natural', intent: '一起散步聊天' })
    assert.equal(naturalReply.success, true, naturalReply.message)
    assert.ok(naturalReply.data.historicalMemory.some((entry) => entry.value === '散步时少用表情-0'))
    assert.match(fixture.requestPrompts.at(-1)[1].content, /历史归档背景/)
    assert.doesNotMatch(fixture.requestPrompts.at(-1)[1].content, /修复误会时不要讽刺|刚才我的语气不太好/)
    const validInput = { accountScope: 'wxid:me', sessionId: 'alice', suggestionId: naturalReply.data.suggestionId }
    const paidBeforeValidation = fixture.apiCalls
    assert.equal((await afterMemoryRestart.insightService.validateReplyAssistant(validInput)).success, true)
    assert.equal(fixture.apiCalls, paidBeforeValidation)
    afterMemoryRestart.relationshipProfileService.confirmReplyPreference({ accountScope: 'wxid:me', sessionId: 'alice', suggestionId: 'new-preference', value: '散步不使用反问', feedback: '别反问' })
    assert.equal((await afterMemoryRestart.insightService.validateReplyAssistant(validInput)).stale, true)
    const repairReply = await afterMemoryRestart.insightService.generateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', mode: 'repair', intent: '修复误会' })
    assert.equal(repairReply.success, true, repairReply.message)
    assert.match(fixture.requestPrompts.at(-1)[1].content, /修复误会时不要讽刺/)
    assert.match(fixture.requestPrompts.at(-1)[1].content, /刚才我的语气不太好/)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('分析实际 HTTP 调用：全量分页、有限证据、增量背景、错误输出拒绝和取消', async () => {
  let phase = 'report'
  let requests = []
  let blockedRequest
  let unblock
  const requestArrived = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture HTTP request did not arrive within 5s')), 5000)
    unblock = () => { clearTimeout(timer); resolve() }
  })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      if (phase === 'blocked') { blockedRequest = res; unblock?.(); return }
      if (phase === 'query-blocked' && requests.at(-1).messages[1].content.includes('历史查询结果')) { blockedRequest = res; unblock?.(); return }
      if (phase.startsWith('reply-history') && requests.at(-1).messages[0].content.includes('回复助手')
        && (phase === 'reply-history-repeat' || !requests.at(-1).messages[1].content.includes('【当前联系人历史查询结果'))) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'history_query', evidence_queries: [
          { keywords: ['特殊约定'], participant: 'mine' }, { keywords: ['没有这个词'] }, { keywords: ['秘密'], session_id: 'bob' }
        ] }) }, finish_reason: 'stop' }] }))
        return
      }
      const content = phase === 'invalid' || phase === 'draft-invalid' && requests.at(-1).messages[0].content.includes('字段整理器') ? '{}' : requests.at(-1).messages[0].content.includes('回复助手')
        ? phase === 'clarify' ? JSON.stringify({ status: 'clarification', clarification_question: '你愿意见面还是想拒绝？', reason: '意图未知', risk: '不能替你决定' })
        : JSON.stringify({ draft: '周六见', reason: '尊重意愿', risk: '安排可能变化', positive_follow_up: '确认时间', ambiguous_follow_up: '先等回应', no_response_plan: '暂停推进', suggested_mode: 'boundary', suggested_mode_reason: '维护边界', proposed_preference: '少用亲昵称呼，简短直接' }) : requests.at(-1).messages[0].content.includes('字段整理器')
        ? JSON.stringify({ user: { communication_preferences: [], strengths: [], limitations: [], boundaries: [] }, object: { confirmed_facts: [], hypotheses: [{ value: '待验证的解释', confidence: 'high', evidence_ids: ['fake-id'] }], key_events: [] }, relationship: {} })
        : phase === 'query' || phase === 'query-draft-invalid' || phase === 'query-blocked' ? requests.at(-1).messages[1].content.includes('历史查询结果')
          ? JSON.stringify({ facts: [{ value: '历史表达需核实', confidence: 'high', evidence_ids: (requests.at(-1).messages[1].content.match(/m-[a-f0-9]{24}/g) || []).slice(0, 1) }], hypotheses: [], unknowns: [], evidence_queries: [{ keywords: ['不得继续循环'] }] })
          : JSON.stringify({ facts: [], hypotheses: [], unknowns: [], evidence_queries: [{ keywords: ['特殊约定'] }, { keywords: ['完全未命中'] }, { keywords: ['秘密'], session_id: 'bob' }] })
        : JSON.stringify({ facts: [], hypotheses: [], unknowns: [], recommendation: { value: '继续观察', confidence: 'high', evidence_ids: [] } })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: phase === 'query-draft-invalid' && requests.at(-1).messages[0].content.includes('字段整理器') ? '{}' : content }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const progress = []
  const fixture = {
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, scope: 'wxid:me', saved: [], offsets: [], ranges: [],
    checkpoint: undefined, automatic: false, recoveries: new Map(), memory: '用户审核的当前目标：保持朋友关系', model: 'fixture', profileVersion: 1,
    messages: Array.from({ length: 1000 }, (_, i) => ({ messageKey: `key-${i}`, localId: i + 1, createTime: 100 + i, isSend: i % 2, senderUsername: i % 2 ? 'me' : 'alice', localType: 1, parsedContent: `唯一消息-${i}`, rawContent: '' }))
  }
  const result = await esbuild.build({ entryPoints: [path.join(__dirname, 'insightService.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'insight-fixture', setup(build) {
    build.onResolve({ filter: /^(\.\/config|\.\/chatService|\.\/wcdbService|\.\/relationshipProfileService|\.\/snsService|\.\/social\/weiboService|\.\.\/windows\/notificationWindow|\.\/insightProfileService|\.\/insightRecordService)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
      const modules = {
        './config': 'export const ConfigService = { getInstance: () => ({ getMyWxidCleaned: () => "me", get: (key) => ({ aiModelApiBaseUrl: fixture.endpoint, aiModelApiKey: "test-only", aiModelApiModel: fixture.model, aiModelApiMaxTokens: 4096 })[key] }) }',
        './chatService': `export const chatService = {
          getMessages: async (id, offset, size, begin, end) => { fixture.offsets.push(offset); fixture.ranges.push(begin); if (fixture.pageHook) await fixture.pageHook(); if (fixture.failPage) return { success: false, error: "校验分页失败" }; const rows = fixture.messages.filter(m => m.createTime >= begin && (!end || m.createTime <= end)); return { success: true, messages: rows.slice(offset,offset+size), hasMore: offset+size < rows.length, nextOffset: offset+size } },
          getLatestMessages: async (id) => { fixture.latestReads = (fixture.latestReads || 0) + 1; if (fixture.latestHook) await fixture.latestHook(); if (id === fixture.failLatest) return { success: false, error: "测试读取失败" }; return { success: true, messages: [...fixture.messages.slice(-40), ...(fixture.foreignLatest || [])] } },
          searchMessages: async (word, id, limit, offset, since, until) => {
            fixture.searches ||= []; fixture.searches.push({word, id, limit, offset, since, until});
            if (fixture.searchBlocked) await fixture.searchBlocked();
            if (fixture.searchSwitch) fixture.scope = "wxid:other";
            if (fixture.searchRevision) fixture.profileVersion++;
            if (fixture.searchNewMessage) fixture.messages.push({ ...fixture.messages.at(-1), messageKey: "during-history", localId: 99999, parsedContent: "新消息：先别约了" });
            if (fixture.searchFailure) return { success: false, error: "历史读取失败" };
            const matches = fixture.searchEmpty ? [] : fixture.messages.filter(m => m.parsedContent.includes(word)).slice(0, limit);
            return { success: true, messages: [...matches.map(m => ({...m, sessionId:id})), { ...fixture.messages[0], sessionId:"bob", parsedContent:"秘密：特殊约定来自Bob" }] };
          },
          getMessagesAround: async (id, target, count) => {
            fixture.aroundReads ||= []; fixture.aroundReads.push({id, target, count});
            const index = fixture.messages.findIndex(m => m.messageKey === target.messageKey);
            if (fixture.aroundFailure) return {success:false, error:"上下文读取失败"};
            return {success:true, before:index > 0 ? [fixture.messages[index-1]] : [], after:fixture.messages[index+1] ? [fixture.messages[index+1]] : []};
          }
        }`,
        './wcdbService': 'export const wcdbService = { getMessageCount: async () => ({ success: true, count: fixture.messages.length }) }',
        './relationshipProfileService': `export const relationshipProfileService = {
          getAccountScope: () => fixture.scope,
          getState: () => ({ state: { memoryEnabled: true, memoryPaused: fixture.paused, objects: {
            alice: { sessionId: "alice", displayLabel: "Alice version " + fixture.profileVersion, updatedAt: fixture.profileVersion, automaticDraftUpdates: fixture.automatic, analysisCheckpoint: fixture.checkpoint, automaticDraftStatus: fixture.statuses?.alice },
            ...(fixture.extraContact ? { bob: { sessionId: "bob", automaticDraftUpdates: true, automaticDraftStatus: fixture.statuses?.bob } } : {})
          } } }),
          getMemoryRevision: () => String(fixture.profileVersion), getProcessedCheckpoint: () => fixture.checkpoint,
          assertAccountScope: (scope) => { if (!scope || scope !== fixture.scope) throw new Error("账号已切换") },
          assertDraftSourceUnchanged: () => {}, hasNewDraftAcceptances: (input) => input.decisions?.["hypotheses:0"] === "accept",
          applyDraft: (input) => { fixture.applied ||= []; fixture.applied.push(input); return { success: true, state: {}, message: "审核完成" } },
          getCompletedAnalysisCheckpoint: () => fixture.completedCheckpoint || fixture.checkpoint,
          getRejectedSuggestions: () => [], getMemoryContext: () => fixture.memory,
          getReplyMemoryContext: () => ({ context: fixture.memory, historicalMemory: fixture.historicalMemory || [] }),
          hasReportRecovery: (id) => fixture.recoveries.has(fixture.scope + id),
          getReportRecovery: (id, fingerprint) => fixture.recoveries.get(fixture.scope + id)?.fingerprint === fingerprint ? fixture.recoveries.get(fixture.scope + id).report : undefined,
          getReportRecoveryEvidence: (id, fingerprint) => fixture.recoveries.get(fixture.scope + id)?.fingerprint === fingerprint ? fixture.recoveries.get(fixture.scope + id).evidence || [] : [],
          saveReportRecovery: (scope, id, fingerprint, report, evidence) => fixture.recoveries.set(scope + id, { fingerprint, report, evidence }),
          getPendingReview: (id) => ({ review: fixture.saved.findLast((entry) => entry.draft.sessionId === id) }),
          saveGeneratedDraft: (draft) => { fixture.recoveries.delete(fixture.scope + draft.sessionId); fixture.saved.push({draft, selection: {}}) },
          setAutomaticDraftStatus: (id, status, scope) => {
            if (scope !== fixture.scope) throw new Error("账号已切换")
            if (id === fixture.failStatus) throw new Error("测试状态保存失败")
            fixture.statuses ||= {}; fixture.statuses[id] = { ...fixture.statuses[id], ...status }; return { success: true }
          }
        }`,
        './snsService': 'export const snsService = {}', './social/weiboService': 'export const weiboService = {}',
        '../windows/notificationWindow': 'export const showNotification = () => {}', './insightProfileService': 'export const insightProfileService = {}', './insightRecordService': 'export const insightRecordService = {}'
      }
      return { contents: modules[args.path] }
    })
  } }] })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, fixture, console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, Date })
  const service = module.exports.insightService
  try {
    const wrongAccount = await service.generateRelationshipProfileDraft({ accountScope: 'wxid:other', sessionId: 'alice', displayName: 'Alice', taskId: 'wrong-account' })
    assert.equal(wrongAccount.success, false)
    assert.match(wrongAccount.message, /账号已切换/)
    assert.equal(fixture.offsets.length, 0)
    assert.equal(requests.length, 0)
    const first = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'full', onProgress: (item) => progress.push(item) })
    if (!first.success) console.error('DEBUG FIRST', first.message)
    assert.equal(first.success, true)
    assert.deepEqual(fixture.offsets, [0, 500])
    assert.equal(first.data.coverage.totalMessages, 1000)
    assert.ok(first.data.evidence.length <= 48)
    assert.equal(fixture.saved.length, 1)
    assert.equal(first.data.report.recommendation.confidence, 'low')
    assert.equal(first.data.object.hypotheses[0].confidence, 'low')
    assert.equal(first.data.object.hypotheses[0].evidenceIds.length, 0)
    assert.match(first.data.coverage.sourceFingerprint, /^[a-f0-9]{64}$/)
    const approvedInput = { sessionId: 'alice', draft: first.data, approvals: {}, decisions: { 'hypotheses:0': 'accept' } }
    const apiCallsBeforeReview = requests.length
    assert.equal((await service.applyRelationshipProfileDraft(approvedInput)).success, true)
    const oldMessages = fixture.messages.map((message) => ({ ...message }))
    fixture.messages.push({ ...oldMessages.at(-1), messageKey: 'new-at-boundary', localId: 2000, parsedContent: '正常新增，同一秒' },
      { ...oldMessages.at(-1), messageKey: 'new-after-boundary', localId: 2001, createTime: 2000, parsedContent: '正常新增，下一天' })
    assert.equal((await service.applyRelationshipProfileDraft(approvedInput)).success, true, 'new chat does not invalidate already covered history')
    fixture.messages.push({ ...oldMessages.at(-1), messageKey: 'new-same-second', localId: 2003, createTime: oldMessages.at(-1).createTime, parsedContent: '正常新增，同一边界秒' })
    assert.equal((await service.applyRelationshipProfileDraft(approvedInput)).success, true, 'new same-second chat does not invalidate covered boundary')
    const sourceMutations = [
      () => { fixture.messages[500].parsedContent = '未被抽样的原文修改' },
      () => { fixture.messages[500].senderUsername = 'me'; fixture.messages[500].isSend = 1 },
      () => { fixture.messages[500].localType = 3 },
      () => { fixture.messages[500].createTime++ },
      () => { fixture.messages.splice(500, 1) },
      () => { fixture.messages.unshift({ ...oldMessages[0], messageKey: 'old-backfill', localId: 2002, createTime: 50 }) }
    ]
    for (const mutate of sourceMutations) {
      fixture.messages = oldMessages.map((message) => ({ ...message }))
      mutate()
      const count = fixture.applied.length
      const stale = await service.applyRelationshipProfileDraft(approvedInput)
      assert.equal(stale.success, false)
      assert.match(stale.message, /聊天记录已修改、删除或补录/)
      assert.equal(fixture.applied.length, count, 'invalid source cannot reach memory application')
    }
    fixture.messages = oldMessages
    fixture.failPage = true
    assert.match((await service.applyRelationshipProfileDraft(approvedInput)).message, /校验分页失败/)
    fixture.failPage = false
    fixture.pageHook = () => { fixture.scope = 'wxid:other' }
    assert.match((await service.applyRelationshipProfileDraft(approvedInput)).message, /账号已切换/)
    fixture.pageHook = undefined; fixture.scope = 'wxid:me'
    fixture.pageHook = () => { fixture.profileVersion++ }
    assert.match((await service.applyRelationshipProfileDraft(approvedInput)).message, /档案或边界发生变化/)
    fixture.pageHook = undefined; fixture.profileVersion = 1
    fixture.pageHook = () => { service.invalidateRelationshipIndex('alice') }
    assert.match((await service.applyRelationshipProfileDraft(approvedInput)).message, /聊天原文校验已停止/)
    fixture.pageHook = undefined
    assert.equal(service.relationshipTasks.size, 0, 'failed source checks release the per-contact task')
    let reviewReadStarted, releaseReviewRead
    const reviewReadReady = new Promise((resolve) => { reviewReadStarted = resolve })
    fixture.pageHook = () => new Promise((resolve) => { releaseReviewRead = resolve; reviewReadStarted() })
    const activeReview = service.applyRelationshipProfileDraft(approvedInput)
    await reviewReadReady
    assert.match((await service.applyRelationshipProfileDraft(approvedInput)).message, /正在分析或校验/)
    const whileReviewing = await service.generateRelationshipProfileDraft({ sessionId: 'alice', taskId: 'while-reviewing' })
    assert.equal(whileReviewing.success, false)
    service.invalidateRelationshipIndex('alice')
    fixture.pageHook = undefined; releaseReviewRead()
    assert.equal((await activeReview).success, false)
    assert.equal(service.relationshipTasks.size, 0)
    fixture.paused = true
    assert.match((await service.applyRelationshipProfileDraft(approvedInput)).message, /恢复长期关系档案/)
    fixture.paused = false
    const legacyInput = { ...approvedInput, draft: { ...first.data, coverage: { ...first.data.coverage, sourceFingerprint: undefined } } }
    assert.match((await service.applyRelationshipProfileDraft(legacyInput)).message, /旧版草稿缺少聊天原文校验/)
    const readsBeforeRejection = fixture.offsets.length
    assert.equal((await service.applyRelationshipProfileDraft({ ...legacyInput, decisions: { 'hypotheses:0': 'reject' } })).success, true)
    assert.equal(fixture.offsets.length, readsBeforeRejection, 'reject-only decisions do not require source reads')
    assert.equal(requests.length, apiCallsBeforeReview, 'review validation is local and does not make paid model calls')
    phase = 'draft-invalid'
    const beforeRecovery = requests.length
    const failedDraft = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'failed-draft' })
    assert.equal(failedDraft.success, false)
    assert.match(failedDraft.message, /已暂存关系报告/)
    assert.equal(requests.length - beforeRecovery, 2)
    assert.equal(fixture.saved.length, 1)
    const beforeRetry = requests.length
    phase = 'report'
    const recovered = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'retry-draft' })
    assert.equal(recovered.success, true)
    assert.equal(requests.length - beforeRetry, 1)
    assert.match(requests.at(-1).messages[0].content, /字段整理器/)
    assert.equal(fixture.recoveries.size, 0)
    // Changed history (including unsampled rows), background, model or forced scan must not reuse a report.
    for (const change of [() => { fixture.messages[500].parsedContent += '历史修改' }, () => { fixture.memory += '；边界更新' }, () => { fixture.model = 'changed-model' }, () => { fixture.profileVersion++ }]) {
      phase = 'draft-invalid'
      await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'prepare-retry', forceFull: true })
      change()
      phase = 'report'
      const count = requests.length
      const fresh = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'changed-retry' })
      assert.equal(fresh.success, true)
      assert.equal(requests.length - count, 2)
    }
    phase = 'draft-invalid'
    await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'before-force' })
    phase = 'report'
    const beforeForce = requests.length
    await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'force-retry', forceFull: true })
    assert.equal(requests.length - beforeForce, 2)
    const sampledIds = new Set(fixture.saved.at(-1).draft.evidence.map((entry) => entry.localId))
    const missedMessage = fixture.messages.find((entry) => entry.localId > 500 && !sampledIds.has(entry.localId))
    assert.ok(missedMessage)
    missedMessage.parsedContent = '特殊约定：先不使用亲昵称呼'
    phase = 'query-draft-invalid'
    const beforeQuery = requests.length
    const queriedFailure = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'query-failed', forceFull: true, onProgress: (item) => progress.push(item) })
    assert.equal(queriedFailure.success, false)
    assert.equal(requests.length - beforeQuery, 3)
    const finalReportRequest = requests.at(-2).messages[1].content
    assert.match(finalReportRequest, /特殊约定：先不使用亲昵称呼/)
    assert.match(finalReportRequest, /"matchedMessages":0/)
    assert.doesNotMatch(finalReportRequest, /秘密|session_id/)
    assert.ok((finalReportRequest.match(/\n\[m-[a-f0-9]{24}\]/g) || []).length <= 48)
    const countBeforeQueryRetry = requests.length
    phase = 'query'
    const queryRecovered = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'query-recovered' })
    assert.equal(queryRecovered.success, true)
    assert.equal(requests.length - countBeforeQueryRetry, 1)
    assert.ok(queryRecovered.data.evidence.length <= 48)
    assert.ok(queryRecovered.data.evidence.some((item) => item.quote.includes('特殊约定')))
    assert.ok(queryRecovered.data.evidence.some((item) => item.reason.includes('历史查询')))
    assert.ok(queryRecovered.data.report.facts[0].evidenceIds.every((id) => queryRecovered.data.evidence.some((item) => item.id === id)))
    assert.match(requests.at(-1).messages[1].content, /特殊约定/)
    assert.ok(progress.some((item) => /历史证据/.test(item.message)))
    phase = 'query-blocked'
    const beforeQueryCancel = fixture.saved.length
    const queryArrived = requestArrived()
    const cancelledQuery = service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'query-cancel', forceFull: true })
    await queryArrived
    assert.equal(service.cancelRelationshipProfileDraft('query-cancel').success, true)
    const stoppedQuery = await cancelledQuery
    assert.equal(stoppedQuery.success, false)
    assert.match(stoppedQuery.message, /停止/)
    assert.equal(fixture.saved.length, beforeQueryCancel)
    assert.equal(fixture.recoveries.size, 0)
    phase = 'report'
    const reply = await service.generateReplyAssistant({ sessionId: 'alice', displayName: 'Alice', mode: 'boundary' })
    fixture.foreignLatest = [{ ...fixture.messages.at(-1), sessionId: 'bob', messageKey: 'foreign-latest', parsedContent: '不应进入模型的其他联系人风格样本', senderUsername: 'me', isSend: 1 }]
    const scopedReply = await service.generateReplyAssistant({ sessionId: 'alice', displayName: 'Alice' })
    assert.equal(scopedReply.success, true)
    assert.doesNotMatch(requests.at(-1).messages[1].content, /不应进入模型的其他联系人风格样本/)
    fixture.foreignLatest = []
    assert.equal(reply.success, true)
    assert.equal(reply.data.sessionId, 'alice')
    assert.equal(reply.data.accountScope, 'wxid:me')
    assert.equal(reply.data.mode, 'boundary')
    assert.ok(reply.data.suggestionId)
    assert.match(requests.at(-1).messages[1].content, /我方文本/)
    assert.equal(reply.data.proposedPreference, undefined)
    const validationInput = { accountScope: reply.data.accountScope, sessionId: reply.data.sessionId, suggestionId: reply.data.suggestionId }
    const validationCallsBefore = requests.length
    assert.equal((await service.validateReplyAssistant(validationInput)).success, true)
    assert.equal((await service.validateReplyAssistant({ ...validationInput, sessionId: 'bob' })).stale, true)
    assert.equal((await service.validateReplyAssistant({ ...validationInput, accountScope: 'wxid:other' })).stale, true)
    assert.equal((await service.validateReplyAssistant({ ...validationInput, suggestionId: 'forged' })).stale, true)
    fixture.failLatest = 'alice'
    const unreadableValidation = await service.validateReplyAssistant(validationInput)
    assert.equal(unreadableValidation.success, false)
    assert.equal(unreadableValidation.stale, undefined)
    fixture.failLatest = undefined
    assert.equal((await service.validateReplyAssistant(validationInput)).success, true)
    const indexesBeforeValidityTests = new Map(service.relationshipMessageIndexes)
    for (const mutate of [
      () => fixture.messages.push({ ...fixture.messages.at(-1), messageKey: 'shown-same-second', localId: 88888, parsedContent: '先不见了' }),
      () => { fixture.messages.at(-1).parsedContent = '展示后修改正文' },
      () => { fixture.messages.pop() },
      () => { fixture.profileVersion++ },
      () => { fixture.memory += '边界已经过期' },
      () => { service.invalidateRelationshipIndex('alice') }
    ]) {
      const shown = await service.generateReplyAssistant({ sessionId: 'alice' })
      assert.equal(shown.success, true)
      const previousMessages = fixture.messages.map((row) => ({ ...row })), previousVersion = fixture.profileVersion, previousMemory = fixture.memory
      mutate()
      const checked = await service.validateReplyAssistant({ accountScope: shown.data.accountScope, sessionId: 'alice', suggestionId: shown.data.suggestionId })
      assert.equal(checked.success, false)
      assert.equal(checked.stale, true)
      fixture.messages = previousMessages; fixture.profileVersion = previousVersion; fixture.memory = previousMemory
    }
    const racing = await service.generateReplyAssistant({ sessionId: 'alice' })
    let releaseValidation
    fixture.latestHook = () => new Promise((resolve) => { releaseValidation = resolve })
    const inFlightValidation = service.validateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', suggestionId: racing.data.suggestionId })
    fixture.scope = 'wxid:other'; releaseValidation()
    assert.equal((await inFlightValidation).stale, true)
    fixture.scope = 'wxid:me'; fixture.latestHook = undefined
    for (const [key, index] of indexesBeforeValidityTests) service.relationshipMessageIndexes.set(key, index)
    assert.equal(requests.length - validationCallsBefore, 7, 'validation never makes a paid model request')
    const historyMessage = fixture.messages.find((item) => item.parsedContent.includes('特殊约定'))
    assert.ok(historyMessage)
    historyMessage.isSend = 1; historyMessage.senderUsername = 'me'
    phase = 'reply-history'
    const writesBeforeHistoryReply = fixture.saved.length
    const requestsBeforeHistoryReply = requests.length
    const historyReply = await service.generateReplyAssistant({ sessionId: 'alice', mode: 'natural', intent: '核实旧称呼，但不改变朋友关系' })
    assert.equal(historyReply.success, true)
    assert.equal(requests.length - requestsBeforeHistoryReply, 2)
    assert.equal(fixture.searches.length, 2)
    assert.ok(fixture.searches.every((query) => query.id === 'alice' && query.limit === 8 && query.offset === 0))
    assert.ok(fixture.aroundReads.every((query) => query.id === 'alice' && query.count === 2))
    assert.ok(historyReply.data.historyEvidence.some((entry) => entry.quote.includes('特殊约定') && entry.sender === '我'))
    assert.ok(historyReply.data.historyEvidence.length <= 12)
    assert.match(requests.at(-1).messages[1].content, /特殊约定：先不使用亲昵称呼/)
    assert.match(requests.at(-1).messages[1].content, /"returnedMatches":0/)
    assert.doesNotMatch(requests.at(-1).messages[1].content, /秘密|来自Bob/)
    assert.equal(fixture.saved.length, writesBeforeHistoryReply)
    assert.equal(historyReply.data.proposedPreference, undefined, 'history evidence cannot create an approved preference')
    const historyValidationInput = { accountScope: 'wxid:me', sessionId: 'alice', suggestionId: historyReply.data.suggestionId }
    assert.equal((await service.validateReplyAssistant(historyValidationInput)).success, true)
    const beforeHistoryValidation = requests.length
    fixture.failPage = true
    assert.equal((await service.validateReplyAssistant(historyValidationInput)).success, false)
    fixture.failPage = false
    assert.equal((await service.validateReplyAssistant(historyValidationInput)).success, true)
    const originalHistoryContent = historyMessage.parsedContent
    historyMessage.parsedContent = '历史约定在回复展示后已修改'
    const modifiedHistory = await service.validateReplyAssistant(historyValidationInput)
    assert.equal(modifiedHistory.stale, true)
    assert.match(modifiedHistory.message, /历史聊天已修改或删除/)
    historyMessage.parsedContent = originalHistoryContent
    assert.equal(requests.length, beforeHistoryValidation)
    fixture.searchEmpty = true
    const emptyHistory = await service.generateReplyAssistant({ sessionId: 'alice' })
    assert.equal(emptyHistory.success, true)
    assert.equal(emptyHistory.data.historyEvidence.length, 0)
    assert.match(requests.at(-1).messages[1].content, /没有返回可用证据/)
    fixture.searchEmpty = false
    phase = 'reply-history-repeat'
    const beforeRepeated = requests.length
    const repeated = await service.generateReplyAssistant({ sessionId: 'alice' })
    assert.equal(repeated.success, false)
    assert.match(repeated.message, /重复请求历史查询/)
    assert.equal(requests.length - beforeRepeated, 2, 'only one retrieval round')
    phase = 'reply-history'
    for (const [flag, pattern] of [['searchFailure', /历史检索失败/], ['aroundFailure', /上下文读取失败/], ['searchSwitch', /账号已切换/], ['searchRevision', /档案或边界.*变化/]]) {
      fixture[flag] = true
      const count = requests.length
      const failure = await service.generateReplyAssistant({ sessionId: 'alice' })
      assert.equal(failure.success, false)
      assert.match(failure.message, pattern)
      assert.equal(failure.data, undefined)
      assert.equal(requests.length - count, 1, 'no final model call with failed or stale retrieval')
      fixture[flag] = false; fixture.scope = 'wxid:me'
    }
    const beforeHistoryChange = fixture.messages.slice()
    fixture.searchNewMessage = true
    const beforeStaleHistory = requests.length
    const staleHistoryContext = await service.generateReplyAssistant({ sessionId: 'alice' })
    assert.equal(staleHistoryContext.success, false)
    assert.match(staleHistoryContext.message, /聊天记录发生变化/)
    assert.equal(requests.length - beforeStaleHistory, 1, 'changed context must stop the second paid model request')
    fixture.searchNewMessage = false; fixture.messages = beforeHistoryChange
    let releaseSearch, searchArrived
    const pendingSearch = new Promise((resolve) => { searchArrived = resolve })
    fixture.searchBlocked = () => new Promise((resolve) => { releaseSearch = resolve; searchArrived() })
    const cancellingHistory = service.generateReplyAssistant({ sessionId: 'alice', taskId: 'history-cancel' })
    await pendingSearch
    service.cancelReplyAssistant('history-cancel')
    releaseSearch()
    const cancelledHistory = await cancellingHistory
    assert.equal(cancelledHistory.success, false)
    assert.match(cancelledHistory.message, /停止/)
    fixture.searchBlocked = undefined
    phase = 'report'
    const nameResolver = service.resolveInsightSessionDisplayName
    const latestReads = fixture.latestReads
    service.resolveInsightSessionDisplayName = async () => { fixture.scope = 'wxid:other'; return 'Alice' }
    const countBeforeSwitch = requests.length
    const earlySwitch = await service.generateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', taskId: 'early-switch' })
    assert.equal(earlySwitch.success, false)
    assert.match(earlySwitch.message, /账号已切换/)
    assert.equal(requests.length, countBeforeSwitch)
    assert.equal(fixture.latestReads, latestReads)
    fixture.scope = 'wxid:me'
    service.resolveInsightSessionDisplayName = nameResolver
    const profileWritesBeforeReply = fixture.saved.length
    phase = 'clarify'
    const clarification = await service.generateReplyAssistant({ sessionId: 'alice', displayName: 'Alice' })
    assert.equal(clarification.success, true)
    assert.equal(clarification.data.status, 'clarification')
    assert.equal(clarification.data.draft, '')
    phase = 'report'
    const revision = await service.generateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', displayName: 'Alice', mode: 'natural', intent: '愿意见面，但本周不方便',
      clarification: { question: clarification.data.clarificationQuestion, answer: '愿意，改下周' }, revision: { previousDraft: '亲爱的下周见', feedback: '少用亲昵称呼，简短直接' } })
    assert.equal(revision.success, true)
    assert.equal(revision.data.mode, 'natural')
    assert.equal(revision.data.suggestedMode, 'boundary')
    assert.equal(revision.data.proposedPreference, '少用亲昵称呼，简短直接')
    assert.equal(revision.data.previousDraft, '亲爱的下周见')
    assert.equal(revision.data.clarification.answer, '愿意，改下周')
    assert.equal(fixture.saved.length, profileWritesBeforeReply)
    assert.match(requests.at(-1).messages[1].content, /愿意见面，但本周不方便/)
    assert.match(requests.at(-1).messages[1].content, /少用亲昵称呼，简短直接/)
    fixture.historicalMemory = [{ id: 'old-expression', field: 'communicationPreferences', value: '过去认可的散步聊天表达', archivedAt: 1000, quotes: [] }]
    const withHistoricalMemory = await service.generateReplyAssistant({ sessionId: 'alice' })
    assert.equal(withHistoricalMemory.data.historicalMemory[0].id, 'old-expression')
    fixture.historicalMemory = undefined
    const quotes = requests[0].messages[1].content.match(/唯一消息-\d+/g) || []
    assert.ok(quotes.length <= 48)
    assert.match(requests[0].messages[1].content, /保持朋友关系/)
    fixture.checkpoint = { lastMessageId: first.data.coverage.lastMessageId, boundaryMessageIds: first.data.coverage.boundaryMessageIds, lastMessageAt: first.data.coverage.lastMessageAt, totalMessages: 1000 }
    fixture.messages.push({ ...fixture.messages[0], messageKey: 'new1', localId: 1001, createTime: 1200, parsedContent: '新消息：周六一起见面' })
    requests = []
    const incremental = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'incremental' })
    assert.equal(incremental.data.coverage.readMode, 'incremental')
    assert.equal(incremental.data.coverage.readMessages, 3)
    assert.equal(fixture.ranges.at(-1), 1098)
    assert.equal(incremental.data.coverage.newMessages, 1)
    assert.match(requests[0].messages[1].content, /新消息：周六一起见面/)
    fixture.ranges = []
    fixture.messages.push({ ...fixture.messages[0], messageKey: 'backfill', localId: 2001, createTime: 50, parsedContent: '历史补录' })
    const backfilled = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'backfill' })
    assert.equal(backfilled.success, true)
    assert.equal(backfilled.data.coverage.readMode, 'full')
    assert.ok(fixture.ranges.some((begin) => begin > 0))
    assert.ok(fixture.ranges.includes(0))
    assert.equal(backfilled.data.statistics.totalMessages, 1002)
    fixture.ranges = []
    fixture.messages = fixture.messages.filter((message) => message.messageKey !== 'key-5')
    const deleted = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'delete' })
    assert.equal(deleted.success, true)
    assert.equal(deleted.data.coverage.readMode, 'full')
    assert.equal(deleted.data.statistics.totalMessages, 1001)
    fixture.messages.at(-2).parsedContent = '修改边界历史消息'
    const changedBoundary = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'modified' })
    assert.equal(changedBoundary.success, true)
    assert.equal(changedBoundary.data.coverage.readMode, 'full')
    fixture.ranges = []
    const forced = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'forced', forceFull: true })
    assert.equal(forced.data.coverage.readMode, 'full')
    assert.ok(fixture.ranges.every((begin) => begin === 0))
    fixture.messages[0].parsedContent = '历史正文已修改，但消息数量不变'
    service.invalidateRelationshipIndex('alice')
    const afterInvalidation = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'invalidated' })
    assert.equal(afterInvalidation.data.coverage.readMode, 'full')
    assert.ok(afterInvalidation.data.evidence.some((entry) => entry.quote === '历史正文已修改，但消息数量不变'))
    phase = 'invalid'
    const invalid = await service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'invalid' })
    assert.equal(invalid.success, false)
    assert.match(invalid.message, /缺少/)
    const savedBefore = fixture.saved.length
    phase = 'blocked'
    const arrived = requestArrived()
    const running = service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'cancel', onProgress: (item) => progress.push(item) })
    await arrived
    assert.equal(service.cancelRelationshipProfileDraft('cancel').success, true)
    const cancelled = await running
    assert.equal(cancelled.success, false)
    assert.match(cancelled.message, /停止/)
    assert.equal(fixture.saved.length, savedBefore)
    assert.ok(progress.some((item) => item.taskId === 'cancel' && item.phase === 'cancelled'))
    assert.equal(service.cancelRelationshipProfileDraft('cancel').success, false)
    const editedArrived = requestArrived()
    const editedAnalysis = service.generateRelationshipProfileDraft({ sessionId: 'alice', taskId: 'edited-during-analysis' })
    await editedArrived
    service.invalidateRelationshipIndex('bob')
    service.invalidateRelationshipIndex('alice', 'wxid:other')
    assert.equal(service.relationshipTasks.get('edited-during-analysis').controller.signal.aborted, false)
    service.invalidateRelationshipIndex('alice')
    assert.equal((await editedAnalysis).success, false)
    assert.equal(fixture.saved.length, savedBefore)
    const beforeChangedProfile = fixture.saved.length
    const profileArrived = requestArrived()
    const staleAnalysis = service.generateRelationshipProfileDraft({ sessionId: 'alice', displayName: 'Alice', taskId: 'profile-race', forceFull: true })
    await profileArrived
    fixture.profileVersion++
    blockedRequest.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [], hypotheses: [], unknowns: [] }) }, finish_reason: 'stop' }] }))
    const changedDuringAnalysis = await staleAnalysis
    assert.equal(changedDuringAnalysis.success, false)
    assert.match(changedDuringAnalysis.message, /档案或关系策略发生变化/)
    assert.equal(fixture.saved.length, beforeChangedProfile)
    assert.equal(fixture.recoveries.size, 0)
    const cancelReplyArrived = requestArrived()
    const cancellableReply = service.generateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', taskId: 'reply-cancel' })
    await cancelReplyArrived
    const duplicateReply = await service.generateReplyAssistant({ sessionId: 'alice', taskId: 'reply-duplicate' })
    assert.equal(duplicateReply.success, false)
    assert.match(duplicateReply.message, /已有回复生成任务/)
    fixture.scope = 'wxid:other'
    assert.equal(service.cancelReplyAssistant('reply-cancel').success, false)
    fixture.scope = 'wxid:me'
    assert.equal(service.cancelReplyAssistant('reply-cancel').success, true)
    const cancelledReply = await cancellableReply
    assert.equal(cancelledReply.success, false)
    assert.match(cancelledReply.message, /停止/)
    assert.equal(cancelledReply.data, undefined)
    assert.equal(service.cancelReplyAssistant('reply-cancel').success, false)
    const editedReplyArrived = requestArrived()
    const editedReply = service.generateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', taskId: 'reply-edited' })
    await editedReplyArrived
    service.invalidateRelationshipIndex('bob')
    assert.equal(service.replyTasks.get('reply-edited').controller.signal.aborted, false)
    service.invalidateRelationshipIndex('alice')
    const invalidatedReply = await editedReply
    assert.equal(invalidatedReply.success, false)
    assert.equal(invalidatedReply.data, undefined, 'changed source text cannot produce a usable old reply')
    const finalReplyBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ draft: '周六见', reason: '尊重意愿', risk: '安排可能变化', positive_follow_up: '确认时间', ambiguous_follow_up: '先等回应', no_response_plan: '暂停推进' }) }, finish_reason: 'stop' }] })
    const contextMutations = [
      () => fixture.messages.push({ ...fixture.messages.at(-1), messageKey: 'same-second-reply', localId: 9999, parsedContent: '同一秒新增：先别联系我' }),
      () => { fixture.messages.at(-1).parsedContent = '新正文：今天不想见面' },
      () => { fixture.messages.at(-1).senderUsername = 'me'; fixture.messages.at(-1).isSend = 1 },
      () => { fixture.messages.at(-1).localType = 3 },
      () => fixture.messages.pop()
    ]
    for (const [index, mutate] of contextMutations.entries()) {
      const originalMessages = fixture.messages.map((message) => ({ ...message }))
      const contextArrived = requestArrived()
      const staleContext = service.generateReplyAssistant({ sessionId: 'alice', taskId: `reply-context-${index}` })
      await contextArrived
      mutate()
      blockedRequest.end(finalReplyBody)
      const rejected = await staleContext
      assert.equal(rejected.success, false)
      assert.match(rejected.message, /聊天记录发生变化.*原草稿已保留/)
      assert.equal(rejected.data, undefined)
      fixture.messages = originalMessages
    }
    const unreadableArrived = requestArrived()
    const unreadableContext = service.generateReplyAssistant({ sessionId: 'alice', taskId: 'reply-recheck-failure' })
    await unreadableArrived
    fixture.failLatest = 'alice'
    blockedRequest.end(finalReplyBody)
    const unreadableReply = await unreadableContext
    assert.equal(unreadableReply.success, false)
    assert.match(unreadableReply.message, /无法核对最新聊天/)
    fixture.failLatest = undefined
    phase = 'report'
    let releaseRecheck, recheckArrived, latestCalls = 0
    const recheckReady = new Promise((resolve) => { recheckArrived = resolve })
    fixture.latestHook = () => { if (++latestCalls === 2) return new Promise((resolve) => { releaseRecheck = resolve; recheckArrived() }) }
    const recheckingReply = service.generateReplyAssistant({ sessionId: 'alice', taskId: 'reply-recheck-cancel' })
    await recheckReady
    assert.equal(service.cancelReplyAssistant('reply-recheck-cancel').success, true)
    releaseRecheck()
    assert.equal((await recheckingReply).data, undefined, 'cancellation during final database validation cannot return a usable draft')
    fixture.latestHook = undefined
    phase = 'blocked'
    const memoryReplyArrived = requestArrived()
    const outdatedReply = service.generateReplyAssistant({ accountScope: 'wxid:me', sessionId: 'alice', taskId: 'reply-memory-race' })
    await memoryReplyArrived
    fixture.memory += '；新确认的边界'
    blockedRequest.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ draft: '周六见', reason: '尊重意愿', risk: '安排可能变化', positive_follow_up: '确认时间', ambiguous_follow_up: '先等回应', no_response_plan: '暂停推进' }) }, finish_reason: 'stop' }] }))
    const changedMemoryReply = await outdatedReply
    assert.equal(changedMemoryReply.success, false)
    assert.match(changedMemoryReply.message, /档案或边界.*变化/)
    assert.equal(changedMemoryReply.data, undefined)
    const replyArrived = requestArrived()
    const staleReply = service.generateReplyAssistant({ sessionId: 'alice', displayName: 'Alice' })
    await replyArrived
    fixture.scope = 'wxid:other'
    blockedRequest.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ draft: '周六见', reason: '尊重意愿', risk: '安排可能变化', positive_follow_up: '确认时间', ambiguous_follow_up: '先等回应', no_response_plan: '暂停推进' }) }, finish_reason: 'stop' }] }))
    const switchedReply = await staleReply
    assert.equal(switchedReply.success, false)
    assert.match(switchedReply.message, /账号已切换/)
    assert.equal(switchedReply.data, undefined)
    fixture.scope = 'wxid:me'
    phase = 'report'
    fixture.saved = []
    requests = []
    await service.refreshRelationshipDraftUpdates()
    assert.equal(requests.length, 0)
    fixture.automatic = true
    fixture.paused = true
    await service.refreshRelationshipDraftUpdates()
    assert.equal(requests.length, 0)
    fixture.paused = false
    await service.refreshRelationshipDraftUpdates()
    assert.equal(fixture.saved.length, 1)
    assert.equal(fixture.statuses.alice.state, 'waiting_review')
    assert.equal(fixture.statuses.alice.detectedNewMessages, fixture.saved[0].draft.coverage.newMessages)
    const requestCount = requests.length
    await service.refreshRelationshipDraftUpdates()
    assert.equal(requests.length, requestCount)
    assert.equal(fixture.statuses.alice.queuedNewMessages, 0)
    const pendingSnapshot = JSON.stringify(fixture.saved)
    const beforeBacklog = fixture.messages.map((message) => ({ ...message }))
    const pendingCoverage = fixture.saved.at(-1).draft.coverage
    fixture.messages.push({ ...beforeBacklog.at(-1), messageKey: 'queued-same-second', localId: 9000, createTime: pendingCoverage.lastMessageAt, parsedContent: '草稿后同一秒新增' })
    const pendingAttempt = fixture.statuses.alice.lastAttemptAt
    await service.refreshRelationshipDraftUpdates()
    assert.equal(fixture.statuses.alice.queuedNewMessages, 1)
    assert.equal(fixture.statuses.alice.pendingReviewTaskId, fixture.saved.at(-1).draft.taskId)
    assert.ok(fixture.statuses.alice.queuedCheckedAt)
    for (let i = 0; i < 35; i++) fixture.messages.push({ ...beforeBacklog.at(-1), messageKey: `queued-${i}`, localId: 9100 + i, createTime: pendingCoverage.lastMessageAt + 1 + i })
    await new service.constructor().refreshRelationshipDraftUpdates()
    assert.equal(fixture.statuses.alice.queuedNewMessages, 20, 'bounded sample is only a lower bound of 36 new messages')
    assert.equal(fixture.statuses.alice.lastAttemptAt, pendingAttempt, 'local probes do not advance paid attempt cooldown')
    assert.equal(requests.length, requestCount)
    assert.equal(JSON.stringify(fixture.saved), pendingSnapshot, 'local probes never overwrite a pending review')
    const lastSuccessfulProbe = fixture.statuses.alice.queuedCheckedAt
    fixture.failLatest = 'alice'
    await service.refreshRelationshipDraftUpdates()
    assert.equal(fixture.statuses.alice.state, 'waiting_review')
    assert.match(fixture.statuses.alice.lastError, /检查后续消息失败/)
    assert.equal(fixture.statuses.alice.queuedNewMessages, 20)
    assert.equal(fixture.statuses.alice.queuedCheckedAt, lastSuccessfulProbe)
    assert.equal(fixture.statuses.alice.lastAttemptAt, pendingAttempt)
    fixture.failLatest = undefined
    const beforeSwitchProbe = JSON.stringify(fixture.statuses)
    fixture.latestHook = () => { fixture.scope = 'wxid:other' }
    await service.refreshRelationshipDraftUpdates()
    assert.equal(JSON.stringify(fixture.statuses), beforeSwitchProbe)
    fixture.latestHook = undefined; fixture.scope = 'wxid:me'
    fixture.latestHook = () => { fixture.paused = true }
    await service.refreshRelationshipDraftUpdates()
    assert.equal(JSON.stringify(fixture.statuses), beforeSwitchProbe, 'pause during a read prevents status writes')
    fixture.latestHook = undefined; fixture.paused = false
    const savedPending = fixture.saved
    fixture.latestHook = () => { fixture.saved = [] }
    await service.refreshRelationshipDraftUpdates()
    assert.equal(JSON.stringify(fixture.statuses), beforeSwitchProbe, 'review completion during a read cannot receive stale backlog status')
    fixture.latestHook = undefined; fixture.saved = savedPending
    fixture.messages = beforeBacklog
    await service.refreshRelationshipDraftUpdates()
    assert.equal(fixture.statuses.alice.queuedNewMessages, 0)
    assert.equal(fixture.statuses.alice.lastError, undefined)
    const generatedAt = fixture.statuses.alice.lastGeneratedAt
    assert.ok(generatedAt)
    assert.equal(fixture.statuses.alice.lastGeneratedAt, generatedAt)
    const completed = fixture.saved.at(-1).draft.coverage
    fixture.completedCheckpoint = { ...completed, totalMessages: completed.totalMessages, analyzedAt: generatedAt }
    fixture.saved = [] // Discarded, not approved: keep the completed watermark, not a review.
    fixture.statuses = {}
    const beforeDiscardCheck = requests.length
    await new service.constructor().refreshRelationshipDraftUpdates()
    assert.equal(requests.length, beforeDiscardCheck, 'discarded messages are not analyzed again after restart or cooldown')
    assert.equal(fixture.statuses.alice.state, 'idle')
    fixture.messages.push({ ...fixture.messages[0], messageKey: 'after-discard', localId: 3000, createTime: completed.lastMessageAt, parsedContent: '丢弃后同一秒新增消息' })
    await new service.constructor().refreshRelationshipDraftUpdates()
    assert.ok(requests.length > beforeDiscardCheck, 'genuinely new messages still trigger automatic updates')
    assert.match(requests.at(-1).messages[1].content, /历史检查点覆盖 1000 条消息/, 'generation still uses the approved-memory watermark')
    fixture.completedCheckpoint = undefined
    // Exercise the real scheduler with one failing contact and one healthy contact.
    fixture.saved = []
    fixture.statuses = {}
    fixture.extraContact = true
    fixture.failLatest = 'alice'
    const isolated = new service.constructor()
    const generated = []
    isolated.generateRelationshipProfileDraft = async ({ sessionId }) => {
      generated.push(sessionId)
      return { success: true, data: { coverage: { newMessages: 7 } } }
    }
    await isolated.refreshRelationshipDraftUpdates()
    assert.deepEqual(generated, ['bob'])
    assert.equal(fixture.statuses.alice.state, 'failed')
    assert.match(fixture.statuses.alice.lastError, /读取失败/)
    assert.equal(fixture.statuses.bob.state, 'waiting_review')
    assert.equal(fixture.statuses.bob.detectedNewMessages, 7)
    const readsBeforeCooldown = fixture.latestReads
    await new service.constructor().refreshRelationshipDraftUpdates()
    assert.equal(fixture.latestReads, readsBeforeCooldown, 'persisted attempts prevent retries after restart')
    fixture.statuses = {}
    fixture.failStatus = 'alice'
    await new service.constructor().refreshRelationshipDraftUpdates()
    assert.equal(fixture.statuses.bob.state, 'waiting_review', 'status persistence failure must not stop the other contact')
    fixture.failStatus = undefined
    fixture.failLatest = undefined
    fixture.statuses = {}
    const switching = new service.constructor()
    switching.generateRelationshipProfileDraft = async () => { fixture.scope = 'wxid:switched'; return { success: true } }
    await switching.refreshRelationshipDraftUpdates()
    assert.equal(fixture.statuses.alice.state, 'analyzing')
    assert.equal(fixture.statuses.bob, undefined, 'account switch cannot write completion into the new scope')
  } finally {
    blockedRequest?.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('聊天修改和删除 IPC：仅成功时清除原账号索引，异步账号切换不误清新账号', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8')
  const registrations = source.slice(source.indexOf("  ipcMain.handle('chat:updateMessage'"), source.indexOf("  ipcMain.handle('chat:checkAntiRevokeTriggers'"))
  const handlers = new Map(), invalidations = [], calls = []
  let scope = 'wxid:original', succeeds = true, switchDuringWrite = false
  const write = async (...args) => { calls.push(args); if (switchDuringWrite) scope = 'wxid:new'; return { success: succeeds } }
  vm.runInNewContext(require('typescript').transpileModule(registrations, { compilerOptions: { target: 9, module: 1 } }).outputText, {
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    chatService: { updateMessage: write, deleteMessage: write },
    relationshipProfileService: { getAccountScope: () => scope },
    insightService: { invalidateRelationshipIndex: (...args) => invalidations.push(args) }
  })
  for (const name of ['updateMessage', 'deleteMessage']) {
    const args = name === 'updateMessage' ? ['alice', 1, 100, '新原文'] : ['alice', 1, 100, 'db-hint']
    succeeds = false
    assert.equal((await handlers.get(`chat:${name}`)({}, ...args)).success, false)
    assert.equal(invalidations.length, name === 'updateMessage' ? 0 : 1)
    scope = 'wxid:original'; succeeds = true; switchDuringWrite = true
    assert.equal((await handlers.get(`chat:${name}`)({}, ...args)).success, true)
    assert.deepEqual(invalidations.at(-1), ['alice', 'wxid:original'])
    assert.deepEqual(calls.at(-1), args)
    switchDuringWrite = false
  }
})
