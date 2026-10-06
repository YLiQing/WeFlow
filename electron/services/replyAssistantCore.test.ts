import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReplyAssistantPrompt, buildRelationshipUserStyleHint, normalizeReplyMode, parseReplyAssistant, parseReplyAssistantHistoryQueries } from './replyAssistantCore.ts'

test('未知回复模式回退为自然聊天并生成安全约束', () => {
  assert.equal(normalizeReplyMode('unknown'), 'natural')
  const prompt = buildReplyAssistantPrompt({ displayName: 'Alice', mode: 'unknown', context: '我：在忙吗？' })
  assert.match(prompt.systemPrompt, /不自动发送/)
  assert.match(prompt.userPrompt, /自然聊天/)
})

test('回复提示词只注入当前对象上下文和授权档案', () => {
  const prompt = buildReplyAssistantPrompt({
    displayName: 'Alice',
    mode: 'boundary',
    context: '我：这周见面吗？\nAlice：最近不太方便',
    memoryContext: '【用户已授权的关系档案】\n当前回复态度：尊重边界'
  })
  assert.match(prompt.userPrompt, /Alice：最近不太方便/)
  assert.match(prompt.userPrompt, /尊重边界/)
  assert.match(prompt.systemPrompt, /明确拒绝、不适或要求停止联系/)
  assert.match(prompt.systemPrompt, /已复制、已发送和回应状态都是用户手动记录/)
  assert.match(prompt.systemPrompt, /不能把早期草稿的回应归因于后来修改的草稿/)
  assert.match(prompt.systemPrompt, /未发送的草稿不是我说过的话/)
  assert.match(prompt.systemPrompt, /历史归档背景只包含因容量移出/)
  assert.match(prompt.systemPrompt, /用户主动移除或替换的条目不得恢复/)
})

test('回复结果解析支持思考内容、代码块和 JSON 外层杂讯，但拒绝缺字段和非字符串', () => {
  const result = parseReplyAssistant(`<think>内部推理</think>说明如下：\n\`\`\`json
{"draft":"收到，等你方便时再约。","reason":"尊重对方当前安排","risk":"推进速度会变慢","positiveFollowUp":"再约具体时间","ambiguousFollowUp":"先不追问","noResponsePlan":"暂停主动联系"}
\`\`\``)
  assert.equal(result.draft, '收到，等你方便时再约。')
  assert.throws(() => parseReplyAssistant('{"draft":"只有一句"}'), /缺少必要字段/)
  assert.throws(() => parseReplyAssistant('{"draft":[],"reason":"a","risk":"b","positive_follow_up":"c","ambiguous_follow_up":"d","no_response_plan":"e"}'), /缺少必要字段/)
})

test('回复提示词会使用当前关系中的我方表达风格', () => {
  const prompt = buildReplyAssistantPrompt({
    displayName: 'Alice',
    context: '我：你这周哪天方便？',
    userStyleHint: '平均每条约 12 字；较常通过提问推进对话'
  })
  assert.match(prompt.userPrompt, /当前关系沟通风格/)
  assert.match(prompt.userPrompt, /较常通过提问推进对话/)
})

test('说话风格排除对方、未知身份和附件；上下文限长保留最新消息', () => {
  const style = buildRelationshipUserStyleHint([
    { participant: 'theirs', messageType: '文本', content: '对方特征绝不混入' },
    { participant: 'unknown', messageType: '文本', content: '未知特征绝不混入' },
    { participant: 'mine', messageType: '图片', content: '<xml>图片信息</xml>' },
    { participant: 'mine', messageType: '文本', content: '你周六有空吗？' }
  ])
  assert.match(style, /你周六有空吗/)
  assert.doesNotMatch(style, /对方特征|未知特征|xml/)
  assert.equal(buildRelationshipUserStyleHint([]), '')
  const prompt = buildReplyAssistantPrompt({ displayName: 'Alice', context: '旧消息'.repeat(8000) + '\nAlice：最新一条需要回复', userStyleHint: style })
  assert.match(prompt.userPrompt, /最新一条需要回复/)
})

test('本次意图、澄清和修改意见进入提示词，模式建议必须用户确认', () => {
  const prompt = buildReplyAssistantPrompt({ displayName: 'Alice', mode: 'natural', context: 'Alice：周末见吗？', intent: '这周不方便，但愿意见面',
    clarification: { question: '你愿意见面吗？', answer: '愿意，改下周' }, revision: { previousDraft: '亲爱的下周见', feedback: '不使用亲昵称呼，简短直接' } })
  assert.match(prompt.userPrompt, /这周不方便，但愿意见面/)
  assert.match(prompt.userPrompt, /愿意，改下周/)
  assert.match(prompt.userPrompt, /不使用亲昵称呼，简短直接/)
  assert.match(prompt.systemPrompt, /不得擅自采用/)
  assert.match(prompt.systemPrompt, /不能自动改变长期目标或画像/)
})

test('澄清分支没有可发送草稿；非法建议模式不被采用，旧格式仍兼容', () => {
  const clarification = parseReplyAssistant(JSON.stringify({ status: 'clarification', clarification_question: '你愿意见面还是想婉拒？', draft: '不应出现的回复', reason: '意图会改变回复方向', risk: '不能替用户决定', suggested_mode: 'invalid' }))
  assert.equal(clarification.status, 'clarification')
  assert.equal(clarification.draft, '')
  assert.equal(clarification.suggestedMode, undefined)
  assert.throws(() => parseReplyAssistant('{"status":"clarification","reason":"a","risk":"b"}'), /澄清缺少/)
  const draft = parseReplyAssistant(JSON.stringify({ status: 'draft', draft: '下周再约吧', reason: '当前意图', risk: '时间待确认', positive_follow_up: '约具体日期', ambiguous_follow_up: '先等回应', no_response_plan: '不追问', suggested_mode: 'boundary', suggested_mode_reason: '明确界限', proposed_preference: '简短直接' }))
  assert.equal(draft.suggestedMode, 'boundary')
  assert.equal(draft.mode, 'natural')
  assert.equal(draft.proposedPreference, '简短直接')
})

test('回复历史查询支持清洗 JSON，但不能把查询或模型伪造证据当成最终回复', () => {
  const raw = '<think>推理</think>```json\n{"status":"history_query","evidence_queries":[{"keywords":["称呼"]}]}\n```'
  assert.deepEqual(parseReplyAssistantHistoryQueries(raw), [{ keywords: ['称呼'] }])
  assert.throws(() => parseReplyAssistant(raw), /重复请求历史查询/)
  assert.throws(() => parseReplyAssistantHistoryQueries('{"status":"history_query","evidence_queries":[]}'), /缺少查询条件/)
  assert.equal(parseReplyAssistantHistoryQueries('{"status":"clarification"}'), undefined)
  const reply = parseReplyAssistant('{"draft":"收到","reason":"a","risk":"b","positive_follow_up":"c","ambiguous_follow_up":"d","no_response_plan":"e","historyEvidence":[{"quote":"伪造历史"}]}')
  assert.equal(reply.historyEvidence, undefined)
  assert.match(buildReplyAssistantPrompt({ displayName: 'Alice', context: '还记得上次约定吗' }).systemPrompt, /只在历史信息会改变当前回复时取证/)
})
