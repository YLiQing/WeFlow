import { useEffect, useState } from 'react'
import type { ReplyAssistantRequest, ReplyAssistantResult } from '../types/electron'

const modes: Record<string, string> = { natural: '自然聊天', caring: '温和关心', flirty: '轻松调情', direct: '直接表达', repair: '冲突修复', boundary: '边界回应', deescalate: '降低投入', end_contact: '结束联系' }

interface Props {
  result: ReplyAssistantResult
  busy: boolean
  onChange: (draft: string) => void
  onGenerate: (options: Partial<ReplyAssistantRequest>) => Promise<void>
  onCopy: () => Promise<void>
  onOutcome: (outcome: string) => Promise<void>
  onClose: () => void
  onStop: () => Promise<void>
}

export default function ReplyAssistantPanel({ result, busy, onChange, onGenerate, onCopy, onOutcome, onClose, onStop }: Props) {
  const [mode, setMode] = useState(result.mode)
  const [intent, setIntent] = useState(result.intent || '')
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState('')
  const [preference, setPreference] = useState(result.proposedPreference || '')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [rememberExample, setRememberExample] = useState(false)
  const [preferenceScope, setPreferenceScope] = useState('all')
  const [validity, setValidity] = useState<{ success: boolean; stale?: boolean; message: string } | null>(null)
  useEffect(() => {
    let cancelled = false, checking = false, stale = false
    setValidity(null)
    if (busy) return
    const validate = async () => {
      if (checking || stale) return
      checking = true
      try {
        if (!window.electronAPI.insight.validateReplyAssistant) throw new Error('当前桌面进程版本不支持回复校验，请重启 TalkGate。')
        const response = await window.electronAPI.insight.validateReplyAssistant({ accountScope: result.accountScope, sessionId: result.sessionId, suggestionId: result.suggestionId })
        if (!cancelled) { stale = response.stale === true; setValidity(response) }
      } catch (error) {
        if (!cancelled) setValidity({ success: false, message: /No handler registered/.test(String(error)) ? '当前桌面进程版本不支持回复校验，请重启 TalkGate。' : `暂时无法核对建议：${(error as Error).message || String(error)}` })
      } finally { checking = false }
    }
    void validate()
    const timer = window.setInterval(() => { void validate() }, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [result.accountScope, result.sessionId, result.suggestionId, busy])
  useEffect(() => {
    setMode(result.mode)
    setIntent(result.intent || '')
    setPreference(result.proposedPreference || '')
    setAnswer('')
    setFeedback('')
    setStatus('')
    setRememberExample(false)
    setPreferenceScope('all')
  }, [result.suggestionId])
  const run = (action: () => Promise<unknown>) => {
    if (busy || saving) return
    setSaving(true)
    void action().catch((error) => setStatus((error as Error).message || String(error))).finally(() => setSaving(false))
  }
  const generate = (extra: Partial<ReplyAssistantRequest> = {}) => onGenerate({ mode, intent, clarification: result.clarification, ...extra })
  const savePreference = async () => {
    if (!preference.trim() || !result.revisionFeedback || !window.confirm(`仅为当前联系人保存这条沟通偏好？\n${preference.trim()}\n适用范围：${preferenceScope === 'all' ? '当前联系人的所有回复模式' : modes[preferenceScope]}${rememberExample ? '\n同时保存展示的表达范例，仅作措辞参考，不表示已发送。' : ''}`)) return
    const response = await window.electronAPI.relationshipProfile.confirmReplyPreference({ accountScope: result.accountScope, sessionId: result.sessionId,
      suggestionId: result.suggestionId, value: preference.trim(), feedback: result.revisionFeedback,
      replyMode: preferenceScope === 'all' ? undefined : preferenceScope,
      expressionExample: rememberExample && result.previousDraft ? { previous: result.previousDraft, approved: result.draft } : undefined })
    setStatus(response.message || '')
  }
  const disabled = busy || saving
  return <div className="session-insight-hint success reply-assistant-result" role="region" aria-label="回复助手结果">
    <div className="reply-assistant-toolbar">
      <strong>{result.status === 'clarification' ? '先确认你的想法' : '回复草稿'}</strong>
      <select aria-label="回复模式" value={mode} onChange={(event) => setMode(event.target.value)} disabled={disabled}>
        {Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {result.status !== 'clarification' && <button type="button" disabled={disabled || !result.draft.trim() || !validity?.success} onClick={() => run(onCopy)}>复制</button>}
      {busy && <button type="button" onClick={() => void onStop().catch((error) => setStatus((error as Error).message || String(error)))}>停止生成</button>}
      <button type="button" disabled={saving && !busy} onClick={onClose} aria-label="关闭回复助手">关闭</button>
    </div>
    {!busy && (!validity || !validity.success) ? <div className="reply-assistant-validity" role="status">{validity?.message || '正在核对最新聊天与关系档案…'}</div> : null}
    <label className="reply-assistant-input">这次想怎样回应？（可留空，仅用于本次）<input maxLength={300} value={intent} onChange={(event) => setIntent(event.target.value)} disabled={disabled} placeholder="例如：愿意见面，但这周不方便；想礼貌拒绝" /></label>
    {result.suggestedMode && result.suggestedMode !== result.mode && <div className="reply-assistant-suggestion">
      <span>AI 建议：{modes[result.suggestedMode] || result.suggestedMode}。{result.suggestedModeReason} 当前草稿仍按你选择的模式生成。</span>
      <button type="button" disabled={disabled} onClick={() => run(() => generate({ mode: result.suggestedMode }))}>确认采用建议并重新生成</button>
    </div>}
    {result.status === 'clarification' ? <div className="reply-assistant-clarification">
      <p>{result.clarificationQuestion}</p>
      <label className="reply-assistant-input">补充你的答案<textarea maxLength={500} value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={disabled} /></label>
      <button type="button" disabled={disabled || !answer.trim()} onClick={() => run(() => generate({ clarification: { question: result.clarificationQuestion || '', answer } }))}>补充后生成回复</button>
    </div> : <>
      <textarea className="reply-assistant-draft" aria-label="编辑回复草稿" maxLength={240} value={result.draft} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
      <button type="button" disabled={disabled} onClick={() => run(() => generate())}>按当前意图和模式重新生成</button>
      <details><summary>这不像我：修改表达</summary>
        <label className="reply-assistant-input">明确告诉 AI 哪里不像你<input maxLength={300} value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={disabled} placeholder="例如：对她我不说宝贝，少用感叹号，更简短" /></label>
        <button type="button" disabled={disabled || !feedback.trim()} onClick={() => run(() => generate({ revision: { previousDraft: result.draft, feedback } }))}>按修改意见重写（不自动记忆）</button>
      </details>
      {result.proposedPreference && result.revisionFeedback && <div className="reply-assistant-preference">
        <label className="reply-assistant-input">待审核的当前关系沟通偏好<input aria-label="审核沟通偏好" maxLength={200} value={preference} onChange={(event) => setPreference(event.target.value)} disabled={disabled} /></label>
        <small>依据你的修改意见：“{result.revisionFeedback}”。只有确认保存才写入，不改变通用画像。</small>
        <label className="reply-assistant-input">适用场景<select aria-label="沟通偏好适用场景" value={preferenceScope} disabled={disabled} onChange={(event) => setPreferenceScope(event.target.value)}><option value="all">当前联系人的所有回复模式</option>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {result.previousDraft && <><label><input type="checkbox" aria-label="同时记住表达范例" checked={rememberExample} disabled={disabled || !result.draft.trim()} onChange={(event) => setRememberExample(event.target.checked)} />同时记住我认可的表达范例（仅用于这个联系人）</label>{rememberExample && <div><p>修改前：{result.previousDraft}</p><p>我认可的表达：{result.draft}</p><small>只参考措辞，不视为已发送消息，也不复用当次承诺。</small></div>}</>}
        <button type="button" disabled={disabled || !preference.trim()} onClick={() => run(savePreference)}>确认保存到这段关系</button>
      </div>}
      <div className="reply-assistant-outcomes"><span>记录实际结果：</span>{['已复制', '已发送', '积极回应', '含糊回应', '未回应', '未发送'].map((outcome) => <button key={outcome} type="button" disabled={disabled || !result.draft.trim()} onClick={() => run(() => onOutcome(outcome))}>{outcome}</button>)}</div>
      <details><summary>后续分支</summary><div>积极回应：{result.positiveFollowUp}</div><div>含糊回应：{result.ambiguousFollowUp}</div><div>不回应：{result.noResponsePlan}</div></details>
    </>}
    <div><strong>依据：</strong>{result.reason}</div><div><strong>不确定性：</strong>{result.risk}</div>
    {result.historyEvidence && <details className="reply-assistant-history"><summary>历史取证 · {result.historyEvidence.length} 条摘录</summary>
      {result.historyEvidence.map((item) => <div key={item.id}><small>{new Date(item.createTime * 1000).toLocaleString()} · {item.sender} · [{item.id}]</small><p>{item.quote}</p></div>)}
      {result.historyEvidence.length === 0 && <p>本次有限查询没有返回可用证据。</p>}
    </details>}
    {result.historicalMemory?.length ? <details className="reply-assistant-history"><summary>参考的历史记忆 · {result.historicalMemory.length} 条</summary>
      {result.historicalMemory.map((item) => <div key={item.id}><small>{item.occurredAt || new Date(item.archivedAt).toLocaleDateString()} · 已归档</small><p>{item.value}</p>{item.expressionExample ? <p>过去认可的表达：{item.expressionExample.approved}</p> : null}</div>)}
      <small>仅作历史背景，不代表当前事实、意愿或表达偏好。</small>
    </details> : null}
    {status && <div role="status">{status}</div>}
    {disabled && <div role="status">正在处理，请稍候…</div>}
  </div>
}

