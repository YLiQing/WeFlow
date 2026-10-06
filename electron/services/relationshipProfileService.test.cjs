const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')

test('真实文件保存：草稿重启恢复、账号隔离、审核事务回滚及撤销删除', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-relationship-test-'))
  let account = 'me-a'
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'relationshipProfileService.ts')], bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'desktop-fixture', setup(build) {
      build.onResolve({ filter: /^(electron|\.\/config)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: args.path === 'electron'
        ? 'export const app = { getPath: () => globalThis.fixture.directory }'
        : 'export const ConfigService = { getInstance: () => ({ getMyWxidCleaned: () => globalThis.fixture.account(), get: () => undefined }) }' }))
    } }]
  })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, process: { env: {}, cwd: () => directory }, fixture: { directory, account: () => account }, Date, console })
  const { RelationshipProfileService } = module.exports
  const service = new RelationshipProfileService()
  service.enableMemory()
  const report = { facts: [], hypotheses: [], unknowns: [], recommendation: { value: '待审核报告', confidence: 'low', evidenceIds: [], quotes: [] } }
  service.saveReportRecovery('wxid:me-a', 'alice', 'input1', report)
  assert.equal(new RelationshipProfileService().getReportRecovery('alice', 'input1').recommendation.value, '待审核报告')
  assert.equal(service.getReportRecovery('alice', 'input2'), undefined)
  assert.equal(service.getReportRecovery('bob', 'input1'), undefined)
  assert.equal(service.getProcessedCheckpoint('alice'), undefined)
  assert.equal(service.getCompletedAnalysisCheckpoint('alice'), undefined, 'a report without a completed draft cannot advance scheduling')
  const recoveryEvidence = [{ id: 'm1', localId: 1, createTime: 1, sender: '我', quote: '恢复摘录' }]
  service.saveReportRecovery('wxid:me-a', 'alice', 'input1', report, recoveryEvidence)
  assert.equal(new RelationshipProfileService().getReportRecoveryEvidence('alice', 'input1')[0].quote, '恢复摘录')
  assert.equal(service.getReportRecoveryEvidence('alice', 'different').length, 0)
  assert.equal(service.hasReportRecovery('alice'), true)
  const initialTime = Date.now
  Date.now = () => initialTime() + 25 * 3600 * 1000
  try {
    assert.equal(service.hasReportRecovery('alice'), false)
    assert.equal(service.getReportRecovery('alice', 'input1'), undefined)
  } finally { Date.now = initialTime }
  account = 'me-b'
  assert.equal(service.getReportRecovery('alice', 'input1'), undefined)
  assert.throws(() => service.saveReportRecovery('wxid:me-a', 'alice', 'input1', report), /账号已切换/)
  account = 'me-a'
  const recoveryRename = fs.renameSync
  fs.renameSync = () => { throw new Error('模拟报告暂存故障') }
  try { assert.throws(() => service.saveReportRecovery('wxid:me-a', 'alice', 'input2', report), /暂存故障/) }
  finally { fs.renameSync = recoveryRename }
  assert.ok(service.getReportRecovery('alice', 'input1'))
  assert.equal(service.getReportRecovery('alice', 'input2'), undefined)
  for (let i = 0; i < 9; i++) service.saveReportRecovery('wxid:me-a', `contact-${i}`, `input-${i}`, report)
  const recoveryDisk = JSON.parse(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'))
  assert.equal(Object.keys(recoveryDisk.recoveries['wxid:me-a']).length, 8)
  assert.equal(service.hasReportRecovery('alice'), false)
  service.saveReportRecovery('wxid:me-a', 'alice', 'input1', report)
  const draft = {
    sessionId: 'alice', accountScope: 'wxid:me-a', taskId: 'task1', generatedAt: 10,
    coverage: { totalMessages: 2, analyzedMessages: 2, lastMessageId: 'm2', lastMessageAt: 2, truncated: false },
    statistics: {}, report: { facts: [], hypotheses: [], unknowns: [] }, evidence: [],
    user: { communicationPreferences: [], strengths: [], limitations: [], boundaries: [] },
    object: { confirmedFacts: [{ value: '已审核事实', confidence: 'high', evidenceIds: [], quotes: [] }], hypotheses: [], keyEvents: [] }, relationship: {}
  }
  service.savePendingReview({ draft, selection: { 'confirmedFacts:0': true } })
  const restarted = new RelationshipProfileService()
  assert.equal(restarted.getPendingReview('alice').review.selection['confirmedFacts:0'], true)
  assert.equal(restarted.getPendingReview('bob').review, undefined)
  const draftRevision = service.getMemoryRevision('alice')
  const guardedDraft = { ...draft, coverage: { ...draft.coverage, profileRevision: draftRevision, sourceFingerprint: 'a'.repeat(64) }, taskId: 'guarded' }
  service.saveGeneratedDraft(guardedDraft)
  const sourceRestart = new RelationshipProfileService()
  assert.equal(sourceRestart.getPendingReview('alice').review.draft.coverage.sourceFingerprint, 'a'.repeat(64))
  assert.equal(sourceRestart.hasNewDraftAcceptances({ sessionId: 'alice', draft: guardedDraft, approvals: { object: { confirmedFacts: [0] } } }), true)
  assert.equal(sourceRestart.hasNewDraftAcceptances({ sessionId: 'alice', draft: guardedDraft, approvals: { object: { confirmedFacts: [0] } }, decisions: { 'confirmedFacts:0': 'reject' } }), false)
  const sourceDiskBefore = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  for (const tampered of [
    { ...guardedDraft, coverage: { ...guardedDraft.coverage, sourceFingerprint: 'b'.repeat(64) } },
    { ...guardedDraft, coverage: { ...guardedDraft.coverage, lastMessageAt: 999 } },
    { ...guardedDraft, evidence: [{ id: 'fake', localId: 1, createTime: 1, sender: '我', quote: '伪造证据' }] }
  ]) {
    assert.throws(() => sourceRestart.savePendingReview({ draft: tampered, selection: {} }), /分析范围或证据已变化/)
    assert.throws(() => sourceRestart.applyDraft({ sessionId: 'alice', draft: tampered, approvals: { object: { confirmedFacts: [0] } } }), /分析范围或证据已变化/)
  }
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), sourceDiskBefore)
  const editedSourceDraft = { ...guardedDraft, object: { ...guardedDraft.object, confirmedFacts: [{ ...guardedDraft.object.confirmedFacts[0], value: '人工修改建议文字' }] } }
  assert.equal(sourceRestart.savePendingReview({ draft: editedSourceDraft, selection: {} }).success, true)
  sourceRestart.savePendingReview({ draft: guardedDraft, selection: {} })
  service.confirmFact('alice', '后来确认的事实')
  const staleApply = service.applyDraft({ sessionId: 'alice', draft: guardedDraft, approvals: { object: { confirmedFacts: [0] } } })
  assert.equal(staleApply.success, false)
  assert.match(staleApply.message, /草稿已过时/)
  service.removeFact('alice', '后来确认的事实')
  service.saveGeneratedDraft(draft)
  assert.equal(service.getReportRecovery('alice', 'input1'), undefined)
  const analysisRestart = new RelationshipProfileService()
  assert.equal(analysisRestart.getProcessedCheckpoint('alice'), undefined)
  assert.equal(analysisRestart.getCompletedAnalysisCheckpoint('alice').lastMessageId, 'm2')
  assert.equal(analysisRestart.getCompletedAnalysisCheckpoint('bob'), undefined)
  assert.equal(analysisRestart.getState().state.objects.alice?.confirmedFacts.length, 0)
  assert.equal(analysisRestart.getAnalysisHistory('alice').entries.find((entry) => entry.draft.taskId === 'task1').status, 'pending')
  assert.equal(analysisRestart.getAnalysisHistory('alice').entries.find((entry) => entry.draft.taskId === 'guarded').status, 'superseded')
  analysisRestart.discardPendingReview('alice')
  assert.equal(analysisRestart.getAnalysisHistory('alice').entries.find((entry) => entry.draft.taskId === 'task1').status, 'discarded')
  assert.ok(!analysisRestart.getRejectedSuggestions('alice').includes('已审核事实'))
  assert.equal(analysisRestart.getProcessedCheckpoint('alice'), undefined)
  assert.equal(new RelationshipProfileService().getCompletedAnalysisCheckpoint('alice').lastMessageId, 'm2', 'discarded analysis remains completed after restart')
  assert.equal(analysisRestart.getState().state.objects.alice?.confirmedFacts.length, 0)
  account = 'me-b'
  assert.equal(analysisRestart.getAnalysisHistory('alice').entries.length, 0)
  assert.equal(analysisRestart.getProcessedCheckpoint('alice'), undefined)
  assert.equal(analysisRestart.getCompletedAnalysisCheckpoint('alice'), undefined, 'completed progress is account scoped')
  account = 'me-a'
  analysisRestart.saveGeneratedDraft({ ...draft, taskId: 'newer', generatedAt: 20 })
  analysisRestart.saveGeneratedDraft({ ...draft, taskId: 'latest', generatedAt: 30, coverage: { ...draft.coverage, totalMessages: 3, analyzedMessages: 3, lastMessageAt: 3, lastMessageId: 'm3', boundaryMessageIds: ['m3', 'm3-same-second'] } })
  assert.equal(analysisRestart.getCompletedAnalysisCheckpoint('alice').lastMessageId, 'm3')
  assert.equal(analysisRestart.getCompletedAnalysisCheckpoint('alice').boundaryMessageIds.length, 2)
  assert.equal(analysisRestart.getProcessedCheckpoint('alice'), undefined, 'newly completed progress must not become approved-memory progress')
  assert.equal(analysisRestart.getAnalysisHistory('alice').entries.find((entry) => entry.draft.taskId === 'newer').status, 'superseded')
  const historyBeforeFailure = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  const initialRename = fs.renameSync
  fs.renameSync = () => { throw new Error('模拟分析历史保存故障') }
  try { assert.throws(() => analysisRestart.saveGeneratedDraft({ ...draft, taskId: 'failed', generatedAt: 40 }), /保存故障/) }
  finally { fs.renameSync = initialRename }
  assert.equal(analysisRestart.getAnalysisHistory('alice').entries.length, 4)
  assert.equal(analysisRestart.getPendingReview('alice').review.draft.taskId, 'latest')
  assert.equal(analysisRestart.getCompletedAnalysisCheckpoint('alice').analyzedAt, 30, 'failed persistence cannot advance completed progress')
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), historyBeforeFailure)
  // Restore the persisted original review for the following transaction checks.
  restarted.saveGeneratedDraft(draft)
  restarted.savePendingReview({ draft, selection: { 'confirmedFacts:0': true } })
  account = 'me-b'
  assert.equal(restarted.getPendingReview('alice').review, undefined)
  assert.throws(() => restarted.update({ accountScope: 'wxid:me-a', sessionId: 'alice', object: { confirmedFacts: ['错误账号写入'] } }), /账号已切换/)
  assert.throws(() => restarted.assertAccountScope(''), /账号已切换/)
  assert.equal(restarted.getState().state.objects.alice, undefined)
  assert.equal(restarted.applyDraft({ sessionId: 'alice', draft, approvals: { object: { confirmedFacts: [0] } } }).success, false)
  account = 'me-a'
  // Execute the actual main-process registration block, not a replica of its guards.
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8')
  const registrations = source.slice(source.indexOf("  ipcMain.handle('relationshipProfile:getState'"), source.indexOf("  ipcMain.handle('insight:analyzeRelationship'"))
  assert.ok(registrations.includes('withRelationshipAccount'))
  const handlers = new Map()
  vm.runInNewContext(require('typescript').transpileModule(registrations, { compilerOptions: { target: 9, module: 1 } }).outputText,
    { ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, relationshipProfileService: restarted, insightService: {} })
  const mutations = [
    ['enableMemory', []], ['setPaused', [true]], ['update', [{ accountScope: 'wxid:me-b', sessionId: 'alice', object: {} }]],
    ['addEvent', [{ accountScope: 'wxid:me-b', sessionId: 'alice' }]], ['confirmFact', ['alice', '错误事实']],
    ['removeFact', ['alice', '错误事实']], ['confirmHypothesis', [{ accountScope: 'wxid:me-b', sessionId: 'alice' }]],
    ['removeHypothesis', ['alice', '错误推测']], ['forgetObject', ['alice']], ['revoke', [true]], ['discardPendingReview', ['alice']],
    ['recordReplyOutcome', [{ accountScope: 'wxid:me-b', sessionId: 'alice', draft: '错误账号反馈', outcome: '已发送' }]]
  ]
  const beforeGuards = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  for (const [name, args] of mutations) {
    await assert.rejects(handlers.get(`relationshipProfile:${name}`)({}, ...args, 'wxid:me-b'), /账号已切换/, name)
  }
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), beforeGuards)
  await assert.rejects(handlers.get('relationshipProfile:getMemoryHistory')({}, 'alice', 'wxid:me-b'), /账号已切换/)
  await assert.rejects(handlers.get('relationshipProfile:restoreMemory')({}, { accountScope: 'wxid:me-b', sessionId: 'alice', revision: 'bad', kind: 'version', id: 'bad' }), /账号已切换/)
  const validUpdate = await handlers.get('relationshipProfile:update')({}, { accountScope: 'wxid:me-a', user: { displayLabel: '本人' } })
  assert.equal(validUpdate.success, true)
  assert.equal(restarted.getState().state.user.displayLabel, '本人')
  const diskBefore = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('模拟磁盘故障') }
  try {
    assert.throws(() => restarted.applyDraft({ sessionId: 'alice', draft, approvals: { object: { confirmedFacts: [0] } } }), /磁盘故障/)
  } finally { fs.renameSync = rename }
  assert.equal(restarted.getState().state.objects.alice, undefined)
  assert.ok(restarted.getPendingReview('alice').review)
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), diskBefore)
  assert.equal(restarted.applyDraft({ sessionId: 'alice', draft, approvals: { object: { confirmedFacts: [0] } } }).success, true)
  const reloaded = new RelationshipProfileService()
  assert.equal(reloaded.getState().state.objects.alice.confirmedFacts[0], '已审核事实')
  assert.equal(reloaded.getState().state.objects.alice.analysisCheckpoint.lastMessageId, 'm2')
  assert.equal(reloaded.getPendingReview('alice').review, undefined)
  assert.equal(reloaded.getAnalysisHistory('alice').entries[0].status, 'accepted')
  const statusRevision = reloaded.getMemoryRevision('alice')
  const statusProfileTimestamp = reloaded.getState().state.objects.alice.updatedAt
  const statusVersions = reloaded.getMemoryHistory('alice', 'wxid:me-a').versions.length
  reloaded.setAutomaticDraftStatus('alice', { state: 'waiting_review', lastGeneratedAt: 123, lastAttemptAt: 120, queuedNewMessages: 20, queuedCheckedAt: 121, pendingReviewTaskId: 'pending-task', updatedAt: 123 }, 'wxid:me-a')
  reloaded.setAutomaticDraftStatus('alice', { state: 'checking', lastCheckedAt: 456, updatedAt: 456 }, 'wxid:me-a')
  const persistedStatus = new RelationshipProfileService()
  assert.equal(persistedStatus.getState().state.objects.alice.automaticDraftStatus.lastGeneratedAt, 123)
  assert.equal(persistedStatus.getState().state.objects.alice.automaticDraftStatus.lastAttemptAt, 120)
  assert.equal(persistedStatus.getState().state.objects.alice.automaticDraftStatus.queuedNewMessages, 20)
  assert.equal(persistedStatus.getState().state.objects.alice.automaticDraftStatus.queuedCheckedAt, 121)
  assert.equal(persistedStatus.getState().state.objects.alice.automaticDraftStatus.pendingReviewTaskId, 'pending-task')
  assert.equal(persistedStatus.getState().state.objects.alice.updatedAt, statusProfileTimestamp)
  assert.equal(persistedStatus.getMemoryRevision('alice'), statusRevision)
  assert.equal(persistedStatus.getMemoryHistory('alice', 'wxid:me-a').versions.length, statusVersions)
  assert.throws(() => reloaded.setAutomaticDraftStatus('alice', { state: 'failed', updatedAt: 1 }, 'wxid:me-b'), /账号已切换/)
  const feedbackBefore = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  const feedbackInput = { accountScope: 'wxid:me-a', sessionId: 'alice', suggestionId: 'lifecycle', draft: '周末见', outcome: '任意标签' }
  assert.equal(reloaded.recordReplyOutcome(feedbackInput).success, false)
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), feedbackBefore)
  assert.equal(reloaded.recordReplyOutcome({ ...feedbackInput, outcome: '已复制' }).success, true)
  assert.equal(reloaded.recordReplyOutcome({ ...feedbackInput, draft: '下周见', outcome: '已发送' }).success, true)
  const feedbackReloaded = new RelationshipProfileService().getState().state.objects.alice.replyOutcomes.find((entry) => entry.id === 'lifecycle')
  assert.equal(feedbackReloaded.history[0].outcome, '已复制')
  assert.equal(feedbackReloaded.history[0].draft, '周末见')
  assert.equal(feedbackReloaded.history.at(-1).draft, '下周见')
  assert.equal(reloaded.getMemoryRevision('alice'), statusRevision)
  reloaded.update({ accountScope: 'wxid:me-a', sessionId: 'revision-test', object: { displayLabel: 'Version test' } })
  const userGuardDraft = { ...draft, sessionId: 'revision-test', taskId: 'user-revision', coverage: { ...draft.coverage, profileRevision: reloaded.getMemoryRevision('revision-test') } }
  reloaded.saveGeneratedDraft(userGuardDraft)
  reloaded.update({ accountScope: 'wxid:me-a', user: { boundaries: ['不接受威胁'] } })
  const changedUser = reloaded.applyDraft({ sessionId: 'revision-test', draft: userGuardDraft, approvals: { object: { confirmedFacts: [0] } } })
  assert.equal(changedUser.success, false)
  assert.match(changedUser.message, /草稿已过时/)
  reloaded.forgetObject('revision-test')
  const preferenceInput = { accountScope: 'wxid:me-a', sessionId: 'alice', suggestionId: 'reply1', value: '不用亲昵称呼，简短直接', feedback: '这不像我，不要叫宝贝' }
  const profileBefore = reloaded.getState().state
  assert.equal(profileBefore.objects.alice.selfProfile, undefined)
  assert.equal(reloaded.confirmReplyPreference(preferenceInput).success, true)
  const withPreference = reloaded.getState().state
  assert.equal(withPreference.objects.alice.selfProfile.communicationPreferences[0], preferenceInput.value)
  assert.equal(withPreference.user.communicationPreferences.length, 0)
  assert.equal(withPreference.objects.bob, undefined)
  assert.match(reloaded.getMemoryContext('alice'), /不用亲昵称呼/)
  assert.doesNotMatch(reloaded.getMemoryContext('bob'), /不用亲昵称呼/)
  assert.throws(() => reloaded.confirmReplyPreference({ ...preferenceInput, accountScope: 'wxid:other' }), /账号已切换/)
  reloaded.setPaused(true)
  assert.equal(reloaded.confirmReplyPreference({ ...preferenceInput, value: '不能保存' }).success, false)
  reloaded.setPaused(false)
    assert.equal(reloaded.confirmReplyPreference({ ...preferenceInput, feedback: '' }).success, false)
    const exampleInput = { ...preferenceInput, expressionExample: { previous: '宝贝下周见！', approved: '下周见' } }
    assert.equal(reloaded.confirmReplyPreference(exampleInput).success, true)
    const exampleReloaded = new RelationshipProfileService()
    assert.equal(exampleReloaded.getState().state.objects.alice.fieldSources.find((item) => item.value === preferenceInput.value).expressionExample.approved, '下周见')
    assert.match(exampleReloaded.getMemoryContext('alice'), /不认可的表达：「宝贝下周见！」/)
    assert.match(exampleReloaded.getMemoryContext('alice'), /认可的表达：「下周见」/)
    assert.doesNotMatch(exampleReloaded.getMemoryContext('bob'), /宝贝下周见/)
    const beforeEmptyExample = JSON.stringify(reloaded.getState().state)
    assert.equal(reloaded.confirmReplyPreference({ ...exampleInput, expressionExample: { previous: '', approved: '不能保存' } }).success, false)
    assert.equal(JSON.stringify(reloaded.getState().state), beforeEmptyExample)
  assert.ok(!reloaded.getRejectedSuggestions('alice').includes('已审核事实'))
  const field = (value) => ({ value, confidence: 'low', evidenceIds: [], quotes: [] })
  const threeWay = { ...draft, taskId: 'three-way', generatedAt: Date.now(), object: { ...draft.object, confirmedFacts: [field('接受事实'), field('待定事实')], hypotheses: [field('明确拒绝推测')] } }
  reloaded.saveGeneratedDraft(threeWay)
  reloaded.savePendingReview({ draft: threeWay, selection: {}, decisions: { 'confirmedFacts:0': 'accept', 'confirmedFacts:1': 'pending', 'hypotheses:0': 'reject' } })
  const restoredDecision = new RelationshipProfileService().getPendingReview('alice').review
  assert.equal(restoredDecision.decisions['hypotheses:0'], 'reject')
  assert.equal(restoredDecision.decisions['confirmedFacts:1'], 'pending')
  assert.equal(reloaded.applyDraft({ sessionId: 'alice', draft: threeWay, approvals: {}, decisions: restoredDecision.decisions }).success, true)
  assert.ok(reloaded.getState().state.objects.alice.confirmedFacts.includes('接受事实'))
  assert.ok(!reloaded.getState().state.objects.alice.confirmedFacts.includes('待定事实'))
  assert.ok(!reloaded.getState().state.objects.alice.hypotheses.some((entry) => entry.value === '明确拒绝推测'))
  assert.ok(reloaded.getRejectedSuggestions('alice').includes('明确拒绝推测'))
  assert.ok(!reloaded.getRejectedSuggestions('alice').includes('待定事实'))
  const remainingDecision = reloaded.getPendingReview('alice').review
  assert.equal(remainingDecision.decisions['confirmedFacts:0'], 'accepted')
  assert.equal(remainingDecision.decisions['hypotheses:0'], 'rejected')
  assert.equal(reloaded.hasNewDraftAcceptances({ sessionId: 'alice', draft: threeWay, approvals: { object: { confirmedFacts: [0] } } }), false, 'settled fields do not trigger source validation again')
  assert.equal(reloaded.hasNewDraftAcceptances({ sessionId: 'alice', draft: threeWay, approvals: {}, decisions: { 'confirmedFacts:1': 'accept' } }), true)
  assert.equal(reloaded.applyDraft({ sessionId: 'alice', draft: threeWay, approvals: {}, decisions: remainingDecision.decisions }).success, false)
  const partialDisk = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  fs.renameSync = () => { throw new Error('模拟逐项审核保存故障') }
  try { assert.throws(() => reloaded.applyDraft({ sessionId: 'alice', draft: threeWay, approvals: {}, decisions: { 'confirmedFacts:1': 'accept' } }), /逐项审核保存故障/) }
  finally { fs.renameSync = rename }
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), partialDisk)
  assert.equal(reloaded.getPendingReview('alice').review.decisions['confirmedFacts:1'], 'pending')
  assert.ok(!reloaded.getState().state.objects.alice.confirmedFacts.includes('待定事实'))
  assert.throws(() => reloaded.savePendingReview({ ...remainingDecision, draft: { ...threeWay, object: { ...threeWay.object, confirmedFacts: [field('篡改已接受事实'), field('待定事实')] } } }), /已提交/)
  reloaded.discardPendingReview('alice')
  assert.ok(reloaded.getRejectedSuggestions('alice').includes('明确拒绝推测'))
  assert.ok(!reloaded.getRejectedSuggestions('alice').includes('待定事实'))
  const onlyRejected = { ...draft, taskId: 'only-reject', generatedAt: Date.now() + 1, object: { confirmedFacts: [], keyEvents: [], hypotheses: [field('仅拒绝推测')] } }
  reloaded.saveGeneratedDraft(onlyRejected)
  const stateBeforeOnlyReject = JSON.stringify(reloaded.getState().state)
  assert.equal(reloaded.applyDraft({ sessionId: 'alice', draft: onlyRejected, approvals: {}, decisions: { 'hypotheses:0': 'reject' } }).success, true)
  assert.equal(JSON.stringify(reloaded.getState().state), stateBeforeOnlyReject)
  assert.equal(reloaded.getPendingReview('alice').review, undefined)
  assert.ok(reloaded.getRejectedSuggestions('alice').includes('仅拒绝推测'))
  assert.equal(reloaded.applyDraft({ sessionId: 'alice', draft: onlyRejected, approvals: {}, decisions: { 'hypotheses:0': 'reject' } }).success, false)
  reloaded.setAutomaticDraftStatus('alice', { state: 'waiting_review', updatedAt: Date.now() }, 'wxid:me-a')
  const rejectStatusRevision = reloaded.getMemoryRevision('alice')
  const rejectStatusVersions = reloaded.getMemoryHistory('alice', 'wxid:me-a').versions.length
  const statusRejected = { ...onlyRejected, taskId: 'reject-waiting-status', generatedAt: Date.now() + 1 }
  reloaded.saveGeneratedDraft(statusRejected)
  assert.equal(reloaded.applyDraft({ sessionId: 'alice', draft: statusRejected, approvals: {}, decisions: { 'hypotheses:0': 'reject' } }).success, true)
  assert.equal(reloaded.getState().state.objects.alice.automaticDraftStatus.state, 'idle')
  assert.equal(reloaded.getMemoryRevision('alice'), rejectStatusRevision)
  assert.equal(reloaded.getMemoryHistory('alice', 'wxid:me-a').versions.length, rejectStatusVersions)
  const acceptPreviousReject = { ...onlyRejected, taskId: 'accept-previous-reject', generatedAt: Date.now() + 2 }
  reloaded.saveGeneratedDraft(acceptPreviousReject)
  reloaded.applyDraft({ sessionId: 'alice', draft: acceptPreviousReject, approvals: {}, decisions: { 'hypotheses:0': 'accept' } })
  assert.ok(!reloaded.getRejectedSuggestions('alice').includes('仅拒绝推测'))
  const cumulativeDraft = { ...threeWay, taskId: 'cumulative-review', generatedAt: Date.now() + 3 }
  reloaded.saveGeneratedDraft(cumulativeDraft)
  reloaded.applyDraft({ sessionId: 'alice', draft: cumulativeDraft, approvals: {}, decisions: { 'confirmedFacts:0': 'accept' } })
  reloaded.applyDraft({ sessionId: 'alice', draft: cumulativeDraft, approvals: {}, decisions: { 'confirmedFacts:1': 'accept', 'hypotheses:0': 'reject' } })
  const cumulativeHistory = reloaded.getAnalysisHistory('alice').entries.find((entry) => entry.draft.taskId === 'cumulative-review')
  assert.deepEqual(Array.from(cumulativeHistory.approvals.object.confirmedFacts), [0, 1])
  assert.equal(reloaded.getPendingReview('alice').review, undefined)
  assert.throws(() => reloaded.savePendingReview({ draft: cumulativeDraft, selection: {} }), /已处理/)
  reloaded.confirmHypothesis({ sessionId: 'alice', value: '需要观察', confidence: 'low' })
  assert.equal(reloaded.reviewHypothesis({ accountScope: 'wxid:me-a', sessionId: 'alice', value: '需要观察', status: 'refuted' }).success, true)
  assert.equal(new RelationshipProfileService().getState().state.objects.alice.hypotheses[0].status, 'refuted')
  assert.throws(() => reloaded.reviewHypothesis({ accountScope: 'wxid:me-b', sessionId: 'alice', value: '需要观察', status: 'confirmed' }), /账号已切换/)
  const snapshotBeforeGrowth = reloaded.getState().state.objects.alice
  const checkpointBeforeGrowth = snapshotBeforeGrowth.analysisCheckpoint
  const globalBeforeGrowth = JSON.stringify(reloaded.getState().state.user)
  const oversizeBefore = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  assert.equal(reloaded.update({ accountScope: 'wxid:me-a', sessionId: 'alice', object: { confirmedFacts: Array.from({ length: 21 }, (_, i) => `太多-${i}`) } }).success, false)
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), oversizeBefore)
  reloaded.update({ accountScope: 'wxid:me-a', sessionId: 'bob', object: { confirmedFacts: ['其他对象事实'], automaticDraftUpdates: true } })
  reloaded.confirmFact('bob', '其他对象第二事实')
  assert.ok(reloaded.getMemoryHistory('bob', 'wxid:me-a').versions.length > 0)
  reloaded.forgetObject('bob')
  assert.equal(reloaded.getMemoryHistory('bob', 'wxid:me-a').versions.length, 0)
  for (let i = 0; i < 55; i++) reloaded.confirmFact('alice', `归档事实-${i}`)
  for (let i = 0; i < 25; i++) reloaded.addEvent({ sessionId: 'alice', id: `event-${i}`, summary: `归档事件-${i}`, occurredAt: '2026-10-05' })
  const memory = new RelationshipProfileService().getMemoryHistory('alice', 'wxid:me-a')
  assert.equal(memory.versions.length, 50)
  assert.ok(memory.archives.some((entry) => entry.value === '归档事实-0'))
  assert.ok(memory.archives.some((entry) => entry.value === '归档事件-0' && entry.event.id === 'event-0'))
  assert.ok(memory.archives.length > 20)
  assert.equal(memory.archives.find((entry) => entry.value === '归档事实-0').reason, 'capacity')
  assert.equal(memory.archives.find((entry) => entry.value === '归档事件-0').reason, 'capacity')
  const replyMemory = reloaded.getReplyMemoryContext('alice', '归档事实-0')
  assert.ok(replyMemory.historicalMemory.some((entry) => entry.value === '归档事实-0'))
  assert.match(replyMemory.context, /仅作历史回顾，不是当前事实/)
  assert.equal(replyMemory.historicalMemory.length <= 4, true)
  assert.equal(replyMemory.context.length <= 6000, true)
  const fileBeforeMemoryRead = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  reloaded.getReplyMemoryContext('alice', '归档事实-0')
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), fileBeforeMemoryRead, 'historical recall never promotes archives or updates memory')
  assert.equal(reloaded.getReplyMemoryContext('alice', '').historicalMemory.length, 0)
  assert.equal(reloaded.getReplyMemoryContext('bob', '归档事实-0').historicalMemory.length, 0)
  account = 'me-b'
  assert.equal(reloaded.getReplyMemoryContext('alice', '归档事实-0').historicalMemory.length, 0)
  account = 'me-a'
  assert.equal(reloaded.getState().state.objects.alice.confirmedFacts.length, 20)
  assert.equal(reloaded.getState().state.objects.alice.keyEvents.length, 20)
  assert.doesNotMatch(reloaded.getMemoryContext('alice'), /归档事实-0(?:；|\n|$)/)
  assert.equal(reloaded.getMemoryHistory('bob', 'wxid:me-a').versions.length, 0)
  assert.throws(() => reloaded.getMemoryHistory('alice', 'wxid:me-b'), /账号已切换/)
  const archived = memory.archives.find((entry) => entry.value === '归档事实-0')
  const restoreInput = { accountScope: 'wxid:me-a', sessionId: 'alice', revision: memory.revision, kind: 'archive', id: archived.id }
  assert.throws(() => reloaded.restoreMemory({ ...restoreInput, accountScope: 'wxid:me-b' }), /账号已切换/)
  assert.equal(reloaded.restoreMemory({ ...restoreInput, sessionId: 'bob' }).success, false)
  assert.equal(reloaded.restoreMemory({ ...restoreInput, id: 'missing' }).success, false)
  const beforeRestoreFailure = fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8')
  fs.renameSync = () => { throw new Error('模拟历史恢复失败') }
  try { assert.throws(() => reloaded.restoreMemory(restoreInput), /历史恢复失败/) }
  finally { fs.renameSync = rename }
  assert.equal(fs.readFileSync(path.join(directory, 'weflow-relationship-profiles.json'), 'utf8'), beforeRestoreFailure)
  assert.equal(reloaded.getMemoryHistory('alice', 'wxid:me-a').revision, memory.revision)
  assert.equal(reloaded.restoreMemory(restoreInput).success, true)
  assert.ok(reloaded.getState().state.objects.alice.confirmedFacts.includes('归档事实-0'))
  assert.ok(!reloaded.getReplyMemoryContext('alice', '归档事实-0').historicalMemory.some((entry) => entry.value === '归档事实-0'), 'restored active records cannot also be injected as historical memory')
  assert.equal(reloaded.restoreMemory(restoreInput).success, false)
  const eventHistory = reloaded.getMemoryHistory('alice', 'wxid:me-a')
  const eventArchive = eventHistory.archives.find((entry) => entry.field === 'keyEvents' && entry.event.id === 'event-0')
  assert.equal(reloaded.restoreMemory({ ...restoreInput, revision: eventHistory.revision, id: eventArchive.id }).success, true)
  assert.ok(reloaded.getState().state.objects.alice.keyEvents.some((entry) => entry.id === 'event-0'))
  assert.equal(reloaded.getState().state.objects.bob, undefined)
  const versionHistory = reloaded.getMemoryHistory('alice', 'wxid:me-a')
  const factsBeforeVersion = reloaded.getState().state.objects.alice.confirmedFacts.join(';')
  const differentVersion = versionHistory.versions.find((entry) => entry.object.confirmedFacts.join(';') !== factsBeforeVersion)
  assert.ok(differentVersion)
  const versionInput = { ...restoreInput, revision: versionHistory.revision, kind: 'version', id: differentVersion.id }
  assert.equal(reloaded.restoreMemory(versionInput).success, true)
  assert.notEqual(reloaded.getState().state.objects.alice.confirmedFacts.join(';'), factsBeforeVersion)
  assert.equal(JSON.stringify(reloaded.getState().state.user), globalBeforeGrowth)
  assert.deepEqual(reloaded.getState().state.objects.alice.analysisCheckpoint, checkpointBeforeGrowth)
  const undoHistory = reloaded.getMemoryHistory('alice', 'wxid:me-a')
  assert.equal(reloaded.restoreMemory({ ...versionInput, revision: undoHistory.revision, id: undoHistory.versions[0].id }).success, true)
  assert.equal(reloaded.getState().state.objects.alice.confirmedFacts.join(';'), factsBeforeVersion)
  reloaded.update({ sessionId: 'charlie', object: { confirmedFacts: ['主动移除的旧地点'] } })
  reloaded.removeFact('charlie', '主动移除的旧地点')
  assert.equal(reloaded.getMemoryHistory('charlie', 'wxid:me-a').archives[0].reason, 'removed')
  assert.equal(reloaded.getReplyMemoryContext('charlie', '旧地点').historicalMemory.length, 0)
  for (let i = 0; i < 21; i++) reloaded.confirmReplyPreference({ accountScope: 'wxid:me-a', sessionId: 'charlie', suggestionId: `expression-${i}`, value: `散步聊天偏好-${i}`, feedback: '散步聊天少用感叹号', expressionExample: { previous: '散步去吧！！！', approved: '一起散步吗' } })
  const expressionArchive = reloaded.getMemoryHistory('charlie', 'wxid:me-a').archives.find((entry) => entry.value === '散步聊天偏好-0')
  assert.equal(expressionArchive.reason, 'capacity')
  const historicalStyle = new RelationshipProfileService().getReplyMemoryContext('charlie', '散步聊天偏好-0')
  assert.equal(historicalStyle.historicalMemory[0].expressionExample.approved, '一起散步吗')
  assert.match(historicalStyle.context, /不是当前事实、偏好或意愿/)
  assert.equal(reloaded.getState().state.objects.charlie.selfProfile.communicationPreferences.includes('散步聊天偏好-0'), false)
  reloaded.revoke(false)
  assert.equal(reloaded.getReplyMemoryContext('charlie', '散步聊天偏好-0').historicalMemory.length, 0)
  reloaded.enableMemory()
  const scopedPreference = { accountScope: 'wxid:me-a', sessionId: 'charlie', suggestionId: 'scoped-repair', value: '修复误会时不说反话', feedback: '这次是修复误会，别讽刺', replyMode: 'repair', expressionExample: { previous: '你开心就好', approved: '刚才我的语气不好' } }
  assert.equal(reloaded.confirmReplyPreference(scopedPreference).success, true)
  const scopedRestart = new RelationshipProfileService()
  assert.match(scopedRestart.getReplyMemoryContext('charlie', '误会', 'repair').context, /修复误会时不说反话|刚才我的语气不好/)
  assert.doesNotMatch(scopedRestart.getReplyMemoryContext('charlie', '误会', 'natural').context, /修复误会时不说反话|刚才我的语气不好/)
  const self = scopedRestart.getState().state.objects.charlie.selfProfile
  scopedRestart.update({ sessionId: 'charlie', object: { selfProfile: { communicationPreferences: self.communicationPreferences, strengths: ['善于倾听'] } } })
  assert.doesNotMatch(scopedRestart.getReplyMemoryContext('charlie', '误会', 'natural').context, /修复误会时不说反话/)
  assert.equal(scopedRestart.confirmReplyPreference({ ...scopedPreference, replyMode: 'fake' }).success, false)
  assert.equal(scopedRestart.confirmReplyPreference({ ...scopedPreference, replyMode: undefined }).success, true)
  assert.match(scopedRestart.getReplyMemoryContext('charlie', '误会', 'natural').context, /修复误会时不说反话/)
  reloaded.setPaused(true)
  const pausedHistory = reloaded.getMemoryHistory('alice', 'wxid:me-a')
  assert.equal(reloaded.restoreMemory({ ...versionInput, revision: pausedHistory.revision }).success, false)
  reloaded.setPaused(false)
  const revokeDraft = { ...draft, taskId: 'before-revoke', generatedAt: Date.now() }
  reloaded.saveGeneratedDraft(revokeDraft)
  reloaded.savePendingReview({ draft: revokeDraft, selection: {} })
  reloaded.saveReportRecovery('wxid:me-a', 'alice', 'new-input', report)
  reloaded.saveReportRecovery('wxid:me-a', 'bob', 'bob-input', report)
  reloaded.forgetObject('bob')
  assert.equal(reloaded.getReportRecovery('bob', 'bob-input'), undefined)
  reloaded.revoke(true)
  const revoked = new RelationshipProfileService()
  assert.equal(revoked.getState().state.memoryEnabled, false)
  assert.equal(revoked.getState().state.objects.alice, undefined)
  assert.equal(revoked.getPendingReview('alice').review, undefined)
  assert.equal(revoked.getAnalysisHistory('alice').entries.length, 0)
  assert.equal(revoked.getCompletedAnalysisCheckpoint('alice'), undefined)
  assert.equal(revoked.getReportRecovery('alice', 'new-input'), undefined)
  assert.equal(revoked.getMemoryHistory('alice', 'wxid:me-a').versions.length, 0)
  assert.equal(revoked.getMemoryHistory('alice', 'wxid:me-a').archives.length, 0)
  // Only this test's explicitly created directory is removed.
  fs.rmSync(directory, { recursive: true, force: true })
})
