import { useEffect, useMemo, useRef, useState } from 'react'
import { HeartHandshake, Lock, Search, Save, UserRound } from 'lucide-react'
import type { ChatSession } from '../types/models'
import type { RelationshipProfileDraft, RelationshipProfileState, RelationshipProposedField, RelationshipAnalysisHistoryEntry, RelationshipHypothesisStatus, RelationshipMemoryHistory, RelationshipDraftDecision } from '../types/electron'
import { displayNameOrFallback } from '../utils/displayName'
import './RelationshipProfilePage.scss'

const emptyState: RelationshipProfileState = {
  version: 1,
  memoryEnabled: false,
  memoryPaused: false,
  user: {},
  objects: {},
  relationships: {},
  updatedAt: 0
}

export default function RelationshipProfilePage() {
  const [state, setState] = useState<RelationshipProfileState>(emptyState)
  const [accountScope, setAccountScope] = useState('')
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [contactRemarks, setContactRemarks] = useState<Record<string, string>>({})
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [contactQuery, setContactQuery] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [userDisplayLabel, setUserDisplayLabel] = useState('')
  const [userMbti, setUserMbti] = useState('')
  const [userScore, setUserScore] = useState('')
  const [userStrengths, setUserStrengths] = useState('')
  const [userLimitations, setUserLimitations] = useState('')
  const [userPreferences, setUserPreferences] = useState('')
  const [userBoundaries, setUserBoundaries] = useState('')
  const [eventSummary, setEventSummary] = useState('')
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [draft, setDraft] = useState<RelationshipProfileDraft | null>(null)
  const [draftBusy, setDraftBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [analysisProgress, setAnalysisProgress] = useState<{ progress: number; message: string; loadedMessages?: number } | null>(null)
  const [draftSelection, setDraftSelection] = useState<Record<string, boolean>>({})
  const [draftDecisions, setDraftDecisions] = useState<Record<string, RelationshipDraftDecision>>({})
  const [analysisHistory, setAnalysisHistory] = useState<RelationshipAnalysisHistoryEntry[]>([])
  const [forceFullAnalysis, setForceFullAnalysis] = useState(false)
  const [memoryHistory, setMemoryHistory] = useState<RelationshipMemoryHistory | null>(null)
  const [archiveQuery, setArchiveQuery] = useState('')
  const activeTask = useRef('')
  const reviewSaveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const reviewSaveTimer = useRef<number | null>(null)
  const pendingReview = useRef<{ draft: RelationshipProfileDraft; selection: Record<string, boolean>; decisions?: Record<string, RelationshipDraftDecision> } | null>(null)
  const requestSequence = useRef(0)
  const clearReviewTimer = () => {
    if (reviewSaveTimer.current !== null) window.clearTimeout(reviewSaveTimer.current)
    reviewSaveTimer.current = null
    pendingReview.current = null
  }
  const enqueueReview = (review: { draft: RelationshipProfileDraft; selection: Record<string, boolean>; decisions?: Record<string, RelationshipDraftDecision> }) => {
    const sequence = requestSequence.current
    const save = reviewSaveQueue.current.catch(() => {}).then(async () => {
      const result = await window.electronAPI.relationshipProfile.savePendingReview(review)
      if (!result.success) throw new Error('草稿未保存，请重试；当前编辑仍保留在页面中')
      return result
    })
    reviewSaveQueue.current = save
    void save.catch((error) => { if (sequence === requestSequence.current) setStatus(`草稿保存失败：${(error as Error).message || String(error)}`) })
    return save
  }
  const flushReview = () => {
    clearReviewTimer()
    return draft ? enqueueReview({ draft, selection: draftSelection, decisions: draftDecisions }) : reviewSaveQueue.current
  }
  const resetAnalysis = () => {
    requestSequence.current++
    const taskId = activeTask.current
    activeTask.current = ''
    setDraftBusy(false)
    setStopping(false)
    setAnalysisProgress(null)
    if (taskId) void window.electronAPI.insight.cancelRelationshipProfileDraft(taskId).catch(() => {})
  }
  const runAction = (action: () => Promise<unknown>) => {
    if (saving) return
    setSaving(true)
    void action().catch((error) => setStatus(`操作失败：${(error as Error).message || String(error)}`)).finally(() => setSaving(false))
  }
  const selectContact = (sessionId: string) => {
    if (sessionId === selectedSessionId || saving) return
    const sequence = requestSequence.current
    setSaving(true)
    void flushReview().then(() => {
      if (sequence !== requestSequence.current) return
      resetAnalysis()
      setSelectedSessionId(sessionId)
      setDraft(null)
      setDraftSelection({})
      setDraftDecisions({})
      setDraftBusy(false)
      setAnalysisProgress(null)
      setStatus('')
    }).catch((error) => { if (sequence === requestSequence.current) setStatus(`草稿保存失败，未切换联系人：${(error as Error).message || String(error)}`) }).finally(() => setSaving(false))
  }

  const selectedSession = useMemo(
    () => sessions.find((session) => session.username === selectedSessionId),
    [selectedSessionId, sessions]
  )
  const objectProfile = state.objects[selectedSessionId]
  const hasDraft = draft !== null
  const strategy = state.relationships[selectedSessionId]
  const contactName = (sessionId: string, sessionName?: string) => displayNameOrFallback(sessionId, contactRemarks[sessionId], sessionName)
  const displayName = contactName(selectedSessionId, selectedSession?.displayName)
  const refreshHistory = async () => {
    const sequence = requestSequence.current
    const result = await window.electronAPI.relationshipProfile.getAnalysisHistory(selectedSessionId)
    if (sequence === requestSequence.current) setAnalysisHistory(result.entries.filter((entry) => entry.draft.accountScope === accountScope))
  }
  const filteredSessions = useMemo(() => {
    const query = contactQuery.trim().toLowerCase()
    if (!query) return sessions
    return sessions.filter((session) => {
      const name = contactName(session.username, session.displayName).toLowerCase()
      return name.includes(query) || String(session.displayName || '').toLowerCase().includes(query) || session.username.toLowerCase().includes(query)
    })
  }, [contactQuery, sessions, contactRemarks])
  const overviewRows = useMemo(() => {
    const ids = new Set([...Object.keys(state.objects), ...Object.keys(state.relationships)])
    return Array.from(ids).map((sessionId) => {
      const object = state.objects[sessionId]
      const relationship = state.relationships[sessionId]
      const latestEvent = object?.keyEvents[object.keyEvents.length - 1]
      return {
        sessionId,
        displayLabel: object?.displayLabel || contactName(sessionId, sessions.find((item) => item.username === sessionId)?.displayName),
        stage: relationship?.stage || '未设置',
        goal: relationship?.goal || '未设置',
        currentAction: relationship?.currentAction || '未设置',
        latestEvent: latestEvent ? `${latestEvent.occurredAt} ${latestEvent.summary}` : '暂无关键事件'
      }
    }).sort((a, b) => a.displayLabel.localeCompare(b.displayLabel, 'zh-CN'))
  }, [sessions, contactRemarks, state.objects, state.relationships])

  useEffect(() => {
    void Promise.all([window.electronAPI.relationshipProfile.getState(), window.electronAPI.chat.getSessions(), window.electronAPI.chat.getContacts({ lite: true }).catch(() => ({ success: false as const }))])
      .then(([profileResult, sessionResult, contactResult]) => {
        if (profileResult.success) {
          setAccountScope(profileResult.accountScope || '')
          setState(profileResult.state)
          setUserDisplayLabel(profileResult.state.user.displayLabel || '')
          setUserMbti(profileResult.state.user.mbti || '')
          setUserScore(profileResult.state.user.subjectiveScore === undefined ? '' : String(profileResult.state.user.subjectiveScore))
          setUserStrengths((profileResult.state.user.strengths || []).join('\n'))
          setUserLimitations((profileResult.state.user.limitations || []).join('\n'))
          setUserPreferences((profileResult.state.user.communicationPreferences || []).join('\n'))
          setUserBoundaries((profileResult.state.user.boundaries || []).join('\n'))
        }
        if (sessionResult.success) {
          const privateSessions = (sessionResult.sessions || []).filter((session) => !session.username.endsWith('@chatroom'))
          setSessions(privateSessions)
          if (!selectedSessionId && privateSessions[0]) setSelectedSessionId(privateSessions[0].username)
        }
        if (contactResult.success && contactResult.contacts) {
          setContactRemarks(Object.fromEntries(contactResult.contacts.filter((contact) => contact.remark?.trim()).map((contact) => [contact.username, contact.remark!.trim()])))
        }
      })
      .catch((error) => setStatus(`加载失败：${(error as Error).message || String(error)}`))
  }, [])

  useEffect(() => {
    requestSequence.current++
    activeTask.current = ''
    setDraft(null)
    setDraftSelection({})
    setDraftDecisions({})
    setAnalysisHistory([])
    setForceFullAnalysis(false)
    setDraftBusy(false)
    setAnalysisProgress(null)
    const remove = window.electronAPI.insight.onRelationshipProfileProgress?.((payload) => {
      if (payload.sessionId === selectedSessionId && payload.taskId === activeTask.current) setAnalysisProgress(payload)
    })
    const sequence = requestSequence.current
    if (selectedSessionId) void refreshHistory().catch((error) => { if (sequence === requestSequence.current) setStatus(`读取分析历史失败：${(error as Error).message || String(error)}`) })
    if (selectedSessionId) void reviewSaveQueue.current.catch(() => {}).then(() => window.electronAPI.relationshipProfile.getPendingReview(selectedSessionId)).then((result) => {
      if (sequence !== requestSequence.current || !result.review || result.review.draft.accountScope !== accountScope) return
      setDraft(result.review.draft)
      setDraftSelection(result.review.selection || {})
      setDraftDecisions(result.review.decisions || {})
    }).catch((error) => { if (sequence === requestSequence.current) setStatus(`恢复草稿失败：${(error as Error).message || String(error)}`) })
    return () => {
      requestSequence.current++
      if (activeTask.current) void window.electronAPI.insight.cancelRelationshipProfileDraft(activeTask.current).catch(() => {})
      remove?.()
    }
  }, [selectedSessionId, accountScope])

  useEffect(() => {
    if (!draft || draft.sessionId !== selectedSessionId || saving) return
    const review = { draft, selection: draftSelection, decisions: draftDecisions }
    pendingReview.current = review
    reviewSaveTimer.current = window.setTimeout(() => {
      reviewSaveTimer.current = null
      pendingReview.current = null
      void enqueueReview(review).catch(() => {})
    }, 400)
    return () => { if (reviewSaveTimer.current !== null) window.clearTimeout(reviewSaveTimer.current); reviewSaveTimer.current = null }
  }, [draft, draftSelection, draftDecisions, selectedSessionId, saving])

  useEffect(() => () => {
    const review = pendingReview.current
    if (review) reviewSaveQueue.current = reviewSaveQueue.current.catch(() => {}).then(() => window.electronAPI.relationshipProfile.savePendingReview(review)).catch(() => {})
  }, [])

  const discardDraft = async () => {
    if (saving) return
    clearReviewTimer()
    const sessionId = selectedSessionId
    const sequence = requestSequence.current
    setSaving(true)
    try {
      await reviewSaveQueue.current.catch(() => {})
      await window.electronAPI.relationshipProfile.discardPendingReview(sessionId, accountScope)
      if (sequence === requestSequence.current) { setDraft(null); setDraftSelection({}) }
      await refreshHistory()
    } finally { setSaving(false) }
  }

  const enableMemory = async () => {
    const result = await window.electronAPI.relationshipProfile.enableMemory(accountScope)
    setState(result.state)
    setStatus(result.message || '')
  }

  useEffect(() => {
    if (!draftBusy) return
    const startedAt = Date.now()
    setElapsedSeconds(0)
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [draftBusy])

  const stopAnalysis = async () => {
    if (!activeTask.current || stopping) return
    const sequence = requestSequence.current
    setStopping(true)
    try {
      const result = await window.electronAPI.insight.cancelRelationshipProfileDraft(activeTask.current)
      if (sequence !== requestSequence.current) return
      if (!result.success) {
        resetAnalysis()
        const stoppedSequence = requestSequence.current
        const previous = await window.electronAPI.relationshipProfile.getPendingReview(selectedSessionId)
        if (stoppedSequence !== requestSequence.current) return
        if (previous.review?.draft.accountScope === accountScope) { setDraft(previous.review.draft); setDraftSelection(previous.review.selection || {}); setDraftDecisions(previous.review.decisions || {}) }
        setStatus('分析已停止')
        return
      }
      setStatus(result.message)
    } catch (error) {
      setStatus(`停止失败：${(error as Error).message || String(error)}`)
    } finally { if (sequence === requestSequence.current) setStopping(false) }
  }

  const togglePaused = async () => {
    const result = await window.electronAPI.relationshipProfile.setPaused(!state.memoryPaused, accountScope)
    if (!state.memoryPaused) resetAnalysis()
    setState(result.state)
    setStatus(result.message || '')
  }

  const toggleAutomaticUpdates = async (enabled: boolean) => {
    const sessionId = selectedSessionId
    const result = await window.electronAPI.relationshipProfile.update({ accountScope, sessionId, object: { automaticDraftUpdates: enabled } })
    setState(result.state)
    setStatus(result.success ? enabled ? '已开启此联系人的自动更新草稿，生成后仍需审核' : '已关闭此联系人的自动更新草稿' : result.message || '')
    if (result.success && enabled) void window.electronAPI.relationshipProfile.refreshDraftUpdates().catch((error) => setStatus(`自动更新失败：${(error as Error).message || String(error)}`))
  }

  const reviewHypothesis = async (value: string, hypothesisStatus: RelationshipHypothesisStatus) => {
    const result = await window.electronAPI.relationshipProfile.reviewHypothesis({ accountScope, sessionId: selectedSessionId, value, status: hypothesisStatus })
    setState(result.state)
    setStatus(result.message || '')
  }

  const refreshMemoryHistory = async () => {
    const sequence = requestSequence.current
    const result = await window.electronAPI.relationshipProfile.getMemoryHistory(selectedSessionId, accountScope)
    if (sequence === requestSequence.current) setMemoryHistory(result)
  }

  useEffect(() => {
    setMemoryHistory(null)
    setArchiveQuery('')
  }, [selectedSessionId, accountScope])

  const restoreMemory = async (kind: 'version' | 'archive', id: string) => {
    if (!memoryHistory || !window.confirm(kind === 'version' ? '恢复此联系人旧版本？当前画像、事实、推测与策略将被替换，当前版本会保留以便再次恢复。通用画像、回复反馈和分析进度不变。' : '将这条归档重新确认到当前关系档案？旧信息可能已过时，请先核对。')) return
    await flushReview()
    resetAnalysis()
    const sequence = requestSequence.current
    const result = await window.electronAPI.relationshipProfile.restoreMemory({ accountScope, sessionId: selectedSessionId, revision: memoryHistory.revision, kind, id })
    if (sequence !== requestSequence.current) return
    setState(result.state)
    setStatus(result.message || '')
    await refreshMemoryHistory()
  }

  const hypothesisStatus = (item: NonNullable<typeof objectProfile>['hypotheses'][number]): RelationshipHypothesisStatus => {
    if (item.status && item.status !== 'active') return item.status
    const expiration = item.expiresAt ?? (item.updatedAt ? item.updatedAt + 30 * 24 * 3600 * 1000 : undefined)
    return expiration && expiration <= Date.now() ? 'expired' : 'active'
  }

  useEffect(() => {
    if (!selectedSessionId || draftBusy || saving || !objectProfile?.automaticDraftUpdates || !state.memoryEnabled || state.memoryPaused) return
    let cancelled = false
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const [reviewResult, stateResult] = await Promise.all([
          hasDraft ? Promise.resolve(null) : window.electronAPI.relationshipProfile.getPendingReview(selectedSessionId),
          window.electronAPI.relationshipProfile.getState()
        ])
        if (cancelled) return
        if (stateResult.success && stateResult.accountScope === accountScope) setState(stateResult.state)
        if (reviewResult?.review?.draft.accountScope === accountScope) { setDraft(reviewResult.review.draft); setDraftSelection(reviewResult.review.selection || {}); setDraftDecisions(reviewResult.review.decisions || {}) }
      } finally { polling = false }
    }
    const timer = window.setInterval(() => { void poll().catch(() => {}) }, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [selectedSessionId, hasDraft, draftBusy, saving, objectProfile?.automaticDraftUpdates, accountScope, state.memoryEnabled, state.memoryPaused])

  const revokeMemory = async (deleteData: boolean) => {
    const prompt = deleteData
      ? '撤销并删除全部关系档案？此操作不可恢复。'
      : '撤销长期档案但保留现有资料？'
    if (!window.confirm(prompt)) return
    resetAnalysis()
    if (deleteData) {
      clearReviewTimer()
      await reviewSaveQueue.current.catch(() => {})
    }
    const result = await window.electronAPI.relationshipProfile.revoke(deleteData, accountScope)
    if (result.success && deleteData) { setDraft(null); setDraftSelection({}) }
    if (result.success && deleteData) { setAnalysisHistory([]); setMemoryHistory(null) }
    setState(result.state)
    setStatus(result.message || '')
  }

  const forgetSelectedObject = async () => {
    if (!selectedSessionId || !window.confirm(`删除“${displayName}”的关系档案？`)) return
    resetAnalysis()
    clearReviewTimer()
    await reviewSaveQueue.current.catch(() => {})
    const result = await window.electronAPI.relationshipProfile.forgetObject(selectedSessionId, accountScope)
    if (result.success) { setDraft(null); setDraftSelection({}) }
    if (result.success) { setAnalysisHistory([]); setMemoryHistory(null) }
    setState(result.state)
    setStatus(result.message || '')
  }

  const saveProfile = async (form: HTMLFormElement) => {
    if (!selectedSessionId || !state.memoryEnabled) return
    const values = new FormData(form)
    setSaving(true)
    try {
      const result = await window.electronAPI.relationshipProfile.update({
        accountScope,
        sessionId: selectedSessionId,
        object: {
          displayLabel: String(values.get('displayLabel') || '').trim(),
          mbti: String(values.get('mbti') || '').trim() || undefined,
          subjectiveScore: values.get('subjectiveScore') === '' ? undefined : Number(values.get('subjectiveScore')),
          confirmedFacts: String(values.get('confirmedFacts') || '').split('\n').map((item) => item.trim()).filter(Boolean),
          selfProfile: {
            communicationPreferences: String(values.get('selfPreferences') || '').split('\n').map((item) => item.trim()).filter(Boolean),
            strengths: String(values.get('selfStrengths') || '').split('\n').map((item) => item.trim()).filter(Boolean),
            limitations: String(values.get('selfLimitations') || '').split('\n').map((item) => item.trim()).filter(Boolean),
            boundaries: String(values.get('selfBoundaries') || '').split('\n').map((item) => item.trim()).filter(Boolean), updatedAt: Date.now()
          }
        },
        relationship: {
          role: String(values.get('role') || '').trim() || undefined,
          stage: String(values.get('stage') || '').trim() || undefined,
          goal: String(values.get('goal') || '').trim() || undefined,
          replyAttitude: String(values.get('replyAttitude') || '').trim() || undefined,
          currentAction: String(values.get('currentAction') || '').trim() || undefined,
          observationWindow: String(values.get('observationWindow') || '').trim() || undefined,
          stopCondition: String(values.get('stopCondition') || '').trim() || undefined,
          expiresAt: values.get('expiresAt') ? new Date(`${values.get('expiresAt')}T23:59:59`).getTime() : undefined
        }
      })
      setState(result.state)
      setStatus(result.message || '')
    } finally {
      setSaving(false)
    }
  }

  const saveUserProfile = async () => {
    if (!state.memoryEnabled) return
    const result = await window.electronAPI.relationshipProfile.update({
      accountScope,
      user: {
        displayLabel: userDisplayLabel.trim() || undefined,
        mbti: userMbti.trim() || undefined,
        subjectiveScore: userScore === '' ? undefined : Number(userScore),
        strengths: userStrengths.split('\n').map((item) => item.trim()).filter(Boolean),
        limitations: userLimitations.split('\n').map((item) => item.trim()).filter(Boolean),
        communicationPreferences: userPreferences.split('\n').map((item) => item.trim()).filter(Boolean),
        boundaries: userBoundaries.split('\n').map((item) => item.trim()).filter(Boolean)
      }
    })
    setState(result.state)
    setStatus(result.message || '')
  }

  const saveEvent = async () => {
    if (!state.memoryEnabled || !selectedSessionId || !eventSummary.trim()) return
    const result = await window.electronAPI.relationshipProfile.addEvent({
      accountScope,
      sessionId: selectedSessionId,
      id: `event-${Date.now()}`,
      summary: eventSummary.trim(),
      occurredAt: eventDate || new Date().toISOString().slice(0, 10),
      source: 'user'
    })
    setState(result.state)
    setEventSummary('')
    setStatus(result.message || '')
  }

  const analyzeDraft = async () => {
    if (!selectedSessionId || draftBusy || saving) return
    const previousReview = draft ? { draft, selection: draftSelection, decisions: draftDecisions } : null
    const savedReview = flushReview()
    const sequence = ++requestSequence.current
    const taskId = crypto.randomUUID()
    activeTask.current = taskId
    setDraftBusy(true)
    setStopping(false)
    setDraft(null)
    setStatus('')
    setAnalysisProgress({ progress: 0, message: '准备分析当前会话' })
    try {
      await savedReview
      if (sequence !== requestSequence.current) return
      const initialAccount = await window.electronAPI.relationshipProfile.getState()
      if (sequence !== requestSequence.current) return
      if (initialAccount.accountScope !== accountScope) throw new Error('账号已切换，请重新打开关系档案')
      const result = await window.electronAPI.insight.generateRelationshipProfileDraft({ accountScope, sessionId: selectedSessionId, displayName, taskId, forceFull: forceFullAnalysis })
      if (sequence !== requestSequence.current) return
      if (result.data && (result.data.sessionId !== selectedSessionId || result.data.taskId !== taskId)) throw new Error('分析结果与当前联系人不一致')
      if (result.data) {
        const current = await window.electronAPI.relationshipProfile.getState()
        if (sequence !== requestSequence.current) return
        if (result.data.accountScope !== current.accountScope) throw new Error('账号已切换，请重新分析')
      }
      if (result.success && result.data) { setDraft(result.data); setDraftSelection({}); setDraftDecisions({}); setAnalysisProgress({ progress: 100, message: '分析完成', loadedMessages: result.data.coverage.analyzedMessages }) }
      else {
        const previous = await window.electronAPI.relationshipProfile.getPendingReview(selectedSessionId)
        if (sequence !== requestSequence.current) return
        if (previous.review) { setDraft(previous.review.draft); setDraftSelection(previous.review.selection || {}); setDraftDecisions(previous.review.decisions || {}) }
      }
      setStatus(result.message || '')
      await refreshHistory()
    } catch (error) {
      if (sequence !== requestSequence.current) return
      if (previousReview) { setDraft(previousReview.draft); setDraftSelection(previousReview.selection); setDraftDecisions(previousReview.decisions) }
      const message = (error as Error)?.message || String(error)
      setStatus(/No handler registered|generateRelationshipProfileDraft/i.test(message) ? '当前桌面进程版本不支持该分析功能，请完全退出并重启 TalkGate。' : `分析失败：${message}`)
    } finally { if (sequence === requestSequence.current) { setDraftBusy(false); activeTask.current = '' } }
  }

  const applyDraft = async () => {
    if (!draft || draft.sessionId !== selectedSessionId || !state.memoryEnabled || state.memoryPaused || saving) return
    const sequence = requestSequence.current
    if (reviewSaveTimer.current !== null) window.clearTimeout(reviewSaveTimer.current)
    reviewSaveTimer.current = null
    pendingReview.current = null
    const indexes = (key: string, items: RelationshipProposedField[]) => items.map((_, index) => index).filter((index) => draftSelection[`${key}:${index}`])
    const approvals = {
      user: { communicationPreferences: indexes('communicationPreferences', draft.user.communicationPreferences), strengths: indexes('strengths', draft.user.strengths), limitations: indexes('limitations', draft.user.limitations), boundaries: indexes('boundaries', draft.user.boundaries) },
      object: { displayLabel: Boolean(draftSelection.displayLabel), confirmedFacts: indexes('confirmedFacts', draft.object.confirmedFacts), hypotheses: indexes('hypotheses', draft.object.hypotheses), keyEvents: indexes('keyEvents', draft.object.keyEvents) },
      relationship: Object.fromEntries(Object.entries(draft.relationship).filter(([key, value]) => Boolean(value) && draftSelection[`relationship:${key}`]).map(([key]) => [key, true]))
    }
    setSaving(true)
    try {
      await reviewSaveQueue.current.catch(() => {})
      const result = await window.electronAPI.relationshipProfile.applyDraft({ sessionId: selectedSessionId, draft, approvals, decisions: draftDecisions })
      if (sequence !== requestSequence.current) return
      setState(result.state)
      if (result.success) {
        const remaining = await window.electronAPI.relationshipProfile.getPendingReview(selectedSessionId)
        if (sequence !== requestSequence.current) return
        setDraft(remaining.review?.draft || null)
        setDraftSelection(remaining.review?.selection || {})
        setDraftDecisions(remaining.review?.decisions || {})
      }
      setStatus(result.message || '')
      await refreshHistory()
    } catch (error) {
      if (sequence === requestSequence.current) setStatus(`保存失败：${(error as Error).message || String(error)}`)
    } finally { setSaving(false) }
  }

  const updateDraftItem = (current: RelationshipProfileDraft, key: string, index: number, value: string): RelationshipProfileDraft => {
    const updateList = (items: RelationshipProposedField[]) => items.map((item, itemIndex) => itemIndex === index ? { ...item, value } : item)
    if (key === 'communicationPreferences' || key === 'strengths' || key === 'limitations' || key === 'boundaries') return { ...current, user: { ...current.user, [key]: updateList(current.user[key]) } }
    if (key === 'keyEvents') return { ...current, object: { ...current.object, keyEvents: current.object.keyEvents.map((item, i) => i === index ? { ...item, value, summary: value } : item) } }
    if (key === 'confirmedFacts' || key === 'hypotheses') return { ...current, object: { ...current.object, [key]: updateList(current.object[key]) } }
    return current
  }
  const renderReplacement = (item: RelationshipProposedField) => item.replacesValue ? <span>审核通过将替换旧内容：“{item.replacesValue}”</span> : null
  const fieldLabels: Record<string, string> = { displayLabel: '对象称呼', role: '我的角色', stage: '关系阶段建议', goal: '当前目标建议', replyAttitude: '回复态度建议', currentAction: '下一步行动建议', observationWindow: '观察窗口建议', stopCondition: '停止条件建议' }
  const decisionOf = (key: string): RelationshipDraftDecision => draftDecisions[key] || (draftSelection[key] ? 'accept' : 'pending')
  const settledDecision = (key: string) => decisionOf(key) === 'accepted' || decisionOf(key) === 'rejected'
  const renderDecision = (key: string) => <select aria-label={`审核决定 ${key}`} disabled={saving || settledDecision(key)} value={decisionOf(key)} onChange={(event) => {
    const value = event.target.value as RelationshipDraftDecision
    setDraftDecisions((current) => ({ ...current, [key]: value }))
    setDraftSelection((current) => ({ ...current, [key]: value === 'accept' }))
  }}><option value="pending">待定</option><option value="accept">接受</option><option value="reject">拒绝</option>{settledDecision(key) && <option value={decisionOf(key)}>{decisionOf(key) === 'accepted' ? '已保存' : '已拒绝'}</option>}</select>
  const renderDraftList = (key: string, items: RelationshipProposedField[]) => items.length ? items.map((item, index) => <div className="relationship-draft-item" key={`${key}-${index}`}>
    {renderDecision(`${key}:${index}`)}<span><input aria-label="编辑建议" disabled={saving || settledDecision(`${key}:${index}`)} value={item.value} onChange={(event) => setDraft((current) => current ? updateDraftItem(current, key, index, event.target.value) : current)} /></span>
    <small>{renderReplacement(item)}{item.confidence} · {item.evidenceIds.length ? `证据 ${item.evidenceIds.join(', ')}` : '无直接证据'}{item.quotes[0] ? ` · “${item.quotes[0]}”` : ''}</small>
  </div>) : <small>暂无建议</small>
  const renderDraftField = (key: string, item?: RelationshipProposedField) => item ? <div className="relationship-draft-item">{renderDecision(key)}<span><small>{fieldLabels[key.replace('relationship:', '')] || '建议'}{key.startsWith('relationship:') && strategy?.[key.replace('relationship:', '') as keyof typeof strategy] ? ` · 当前：${String(strategy[key.replace('relationship:', '') as keyof typeof strategy])}` : ''}</small><input aria-label="编辑建议" disabled={saving || settledDecision(key)} value={item.value} onChange={(event) => setDraft((current) => current ? key === 'displayLabel' ? { ...current, object: { ...current.object, displayLabel: item && { ...item, value: event.target.value } } } : { ...current, relationship: { ...current.relationship, [key.replace('relationship:', '')]: { ...item, value: event.target.value } } } : current)} /></span><small>{renderReplacement(item)}{item.confidence} · {item.evidenceIds.length ? `证据 ${item.evidenceIds.join(', ')}` : '无直接证据'}</small></div> : null

  return (
    <div className="relationship-profile-page">
      <header className="relationship-profile-header">
        <div>
          <div className="relationship-profile-title"><HeartHandshake size={22} /><h2>关系档案</h2></div>
          <p>为每段关系单独保存角色、目标和沟通态度。默认不启用长期记忆。</p>
        </div>
        {!state.memoryEnabled ? (
          <button className="relationship-primary-btn" type="button" onClick={() => runAction(enableMemory)}>
            <Lock size={16} /> 启用长期档案
          </button>
        ) : (
          <div className="relationship-memory-actions">
            <span className="relationship-memory-state">{state.memoryPaused ? '已暂停更新' : '长期档案已启用'}</span>
            <button type="button" onClick={() => runAction(togglePaused)}>{state.memoryPaused ? '恢复更新' : '暂停更新'}</button>
            <button type="button" onClick={() => runAction(() => revokeMemory(false))}>撤销但保留</button>
            <button type="button" onClick={() => runAction(() => revokeMemory(true))}>撤销并删除</button>
          </div>
        )}
      </header>

      {!state.memoryEnabled && (
        <div className="relationship-consent-card">
          <Lock size={20} />
          <div><strong>长期记忆尚未启用</strong><span>只有你确认或手动填写的内容才进入长期档案；你可以随时暂停、撤销或删除。</span></div>
        </div>
      )}

      <div className="relationship-profile-body">
        <aside className="relationship-contact-list">
          <div className="relationship-contact-heading"><div><h3>私聊对象</h3><span>{sessions.length} 个联系人</span></div></div>
          <label className="relationship-contact-search"><Search size={15} /><span className="sr-only">搜索联系人</span><input value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} placeholder="搜索联系人" aria-label="搜索联系人" /></label>
          <div className="relationship-contact-items">
          {filteredSessions.map((session) => (
            <button type="button" key={session.username} className={selectedSessionId === session.username ? 'active' : ''} onClick={() => selectContact(session.username)}>
              <span className="relationship-contact-avatar"><UserRound size={16} /></span>
              <span className="relationship-contact-name">{contactName(session.username, session.displayName)}</span>
              {selectedSessionId === session.username && <span className="relationship-contact-current">当前</span>}
            </button>
          ))}
          {sessions.length === 0 && <div className="relationship-empty-contact"><UserRound size={18} /><span>暂无可用私聊会话</span></div>}
          {sessions.length > 0 && filteredSessions.length === 0 && <div className="relationship-empty-contact"><Search size={18} /><span>没有匹配的联系人</span></div>}
          </div>
        </aside>

        <main className="relationship-profile-editor">
          <section className="relationship-summary" aria-label="当前关系摘要">
            <details className="relationship-analysis-module" open={draftBusy || !!draft}>
              <summary>分析设置与隐私说明</summary>
              <div className="relationship-analysis-module-body">
                <p className="relationship-analysis-disclosure">分析仅针对选中联系人：全量消息在本地统计，统计摘要、有限证据摘录及已授权背景将发送至你配置的 AI 服务。报告、待审核草稿与摘录会在本机保存以便恢复，未审核内容不会作为长期记忆注入；失败阶段的报告恢复数据最多复用24小时。不会另存完整聊天原文，也不会自动发送回复。</p>
                <label className="relationship-auto-update"><input type="checkbox" checked={forceFullAnalysis} disabled={draftBusy || saving} onChange={(event) => setForceFullAnalysis(event.target.checked)} /><span>本次强制全量重新校验（历史补录或修改后使用；默认复用运行期间索引）</span></label>
                <label className="relationship-auto-update"><input type="checkbox" checked={objectProfile?.automaticDraftUpdates === true} disabled={!state.memoryEnabled || state.memoryPaused || !selectedSessionId} onChange={(event) => runAction(() => toggleAutomaticUpdates(event.target.checked))} /><span>新聊天出现后自动生成此联系人的更新草稿，逐项审核后保存</span></label>
                {objectProfile?.automaticDraftUpdates && <div className="relationship-auto-update-status"><strong>自动更新：{{ idle: '待检查', checking: '检查新消息', analyzing: '正在分析', waiting_review: '等待审核', failed: '上次失败' }[objectProfile.automaticDraftStatus?.state || 'idle']}</strong>{objectProfile.automaticDraftStatus?.lastCheckedAt && <span>最近检查：{new Date(objectProfile.automaticDraftStatus.lastCheckedAt).toLocaleString()}</span>}{objectProfile.automaticDraftStatus?.lastError && <span className="relationship-auto-update-error">{objectProfile.automaticDraftStatus.lastError}</span>}</div>}
                {objectProfile?.automaticDraftUpdates && objectProfile.automaticDraftStatus?.state === 'waiting_review'
                  && objectProfile.automaticDraftStatus.pendingReviewTaskId === draft?.taskId && (objectProfile.automaticDraftStatus.queuedNewMessages || 0) > 0 ?
                  <div className="relationship-auto-update-status" role="status"><span>当前草稿之后至少新增 {objectProfile.automaticDraftStatus.queuedNewMessages} 条消息，等待本次审核完成。</span>
                    {objectProfile.automaticDraftStatus.queuedCheckedAt ? <small>后续消息检查：{new Date(objectProfile.automaticDraftStatus.queuedCheckedAt).toLocaleString()}</small> : null}</div> : null}
              </div>
            </details>
            <div className="relationship-summary-top"><div><span className="relationship-eyebrow">当前关系</span><h2>{displayName || '选择一个联系人'}</h2><p>{strategy?.role || '尚未设置角色'} <span>·</span> {strategy?.replyAttitude || '尚未设置回复态度'}</p></div><div className="relationship-analysis-actions"><button type="button" className="relationship-primary-btn" onClick={() => void analyzeDraft()} disabled={!selectedSessionId || draftBusy}>{draftBusy ? '分析中…' : `分析 ${displayName || '当前联系人'} 的全部记录`}</button><span className="relationship-stage-badge">{strategy?.stage || '未设置阶段'}</span></div></div>
            {draftBusy && analysisProgress && <div className="relationship-analysis-progress" role="status"><div className="relationship-analysis-progress-top"><span>{analysisProgress.message}</span><strong>{analysisProgress.progress}% · {elapsedSeconds}s</strong><button type="button" onClick={() => void stopAnalysis()} disabled={stopping}>{stopping ? '正在停止…' : '停止分析'}</button></div><div className="relationship-analysis-progress-track"><div style={{ width: `${analysisProgress.progress}%` }} /></div>{analysisProgress.loadedMessages !== undefined && <small>已读取 {analysisProgress.loadedMessages.toLocaleString()} 条消息</small>}</div>}
            {draft?.changes && <div className="relationship-report relationship-draft-changes"><h4>相对当前档案的变化（本地比对）</h4><div>新增 {draft.changes.added.length} 项{draft.changes.added.slice(0, 12).map((item) => <div key={`added-${item.key}`}>新增：{item.value}</div>)}</div><div>替换 {draft.changes.replacements.length} 项{draft.changes.replacements.slice(0, 12).map((item) => <div key={`replace-${item.key}`}>替换：{item.previousValue} → {item.value}</div>)}</div>{!draft.changes.added.length && !draft.changes.replacements.length && <small>没有相对当前档案的新字段；可以只审核关系报告或丢弃本次草稿。</small>}</div>}
            <div className="relationship-summary-metrics"><div><span>当前目标</span><strong>{strategy?.goal || '尚未设置'}</strong></div><div><span>当前行动</span><strong>{strategy?.currentAction || '尚未设置'}</strong></div><div><span>观察窗口</span><strong>{strategy?.observationWindow || '尚未设置'}</strong></div></div>
          </section>
            {draft && <section className="relationship-draft-card"><div className="relationship-editor-heading"><div><h3>待审核的 AI 画像建议</h3><small>逐项选择接受、拒绝或待定；仅接受项写入长期档案，待定项保留，丢弃草稿不等于否定</small></div><div className="relationship-editor-actions"><button type="button" disabled={saving} onClick={() => runAction(discardDraft)}>丢弃</button><button type="button" onClick={() => void applyDraft()} disabled={!state.memoryEnabled || state.memoryPaused || saving}>提交审核决定</button></div></div><div className="relationship-coverage"><strong>已覆盖 {draft.coverage.analyzedMessages.toLocaleString()} 条消息</strong><span>{draft.coverage.firstMessageAt ? new Date(draft.coverage.firstMessageAt * (draft.coverage.firstMessageAt < 10000000000 ? 1000 : 1)).toLocaleDateString() : '-'} 至 {draft.coverage.lastMessageAt ? new Date(draft.coverage.lastMessageAt * (draft.coverage.lastMessageAt < 10000000000 ? 1000 : 1)).toLocaleDateString() : '-'}</span><span>统计基于全部消息，原文证据为分段抽样；本次新增 {draft.coverage.newMessages ?? draft.coverage.totalMessages} 条消息</span><span>{draft.coverage.readMode === 'incremental' ? '复用运行期间索引，增量读取' : '本次全量读取'} {draft.coverage.readMessages ?? draft.coverage.totalMessages} 条；历史统计仍覆盖全部消息</span>{draft.coverage.profileRevision && <span>本草稿基于生成时的关系档案版本；期间手动修改档案后需要重新分析。</span>}{draft.statistics.unknownMessages > 0 && <span className="relationship-coverage-warning">有 {draft.statistics.unknownMessages.toLocaleString()} 条消息身份未确认，未用于判断双方主动与回复行为。</span>}</div><div className="relationship-stat-grid"><div><b>{draft.statistics.totalMessages.toLocaleString()}</b><small>消息总数</small></div><div><b>{draft.statistics.myMessages.toLocaleString()}</b><small>我发送</small></div><div><b>{draft.statistics.objectMessages.toLocaleString()}</b><small>对方发送</small></div><div><b>{draft.statistics.conversationSegments.toLocaleString()}</b><small>对话段</small></div><div><b>{draft.statistics.myInitiations + draft.statistics.objectInitiations}</b><small>主动开启</small></div><div><b>{draft.statistics.longestSilence ? `${Math.round(draft.statistics.longestSilence / 3600)}h` : '-'}</b><small>最长沉默</small></div></div><div className="relationship-report"><h4>关系分析报告</h4>{draft.report.facts.map((item, index) => <div key={`fact-${index}`}>事实：{item.value}</div>)}{draft.report.hypotheses.map((item, index) => <div key={`hypothesis-${index}`}>推测：{item.value}</div>)}{draft.report.unknowns.map((item, index) => <div key={`unknown-${index}`}>未知：{item.value}</div>)}{draft.report.recommendation && <div>建议：{draft.report.recommendation.value}</div>}{draft.report.nextAction && <div>下一步：{draft.report.nextAction.value}</div>}{draft.report.stopCondition && <div>停止条件：{draft.report.stopCondition.value}</div>}</div><div className="relationship-draft-grid"><div><h4>对象称呼</h4>{renderDraftField('displayLabel', draft.object.displayLabel)}<h4>对方已确认事实</h4>{renderDraftList('confirmedFacts', draft.object.confirmedFacts)}</div><div><h4>对方暂定推测</h4>{renderDraftList('hypotheses', draft.object.hypotheses)}</div><div><h4>关键事件</h4>{renderDraftList('keyEvents', draft.object.keyEvents)}</div><div><h4>我在这段关系中的画像</h4>{renderDraftList('communicationPreferences', draft.user.communicationPreferences)}{renderDraftList('strengths', draft.user.strengths)}{renderDraftList('limitations', draft.user.limitations)}{renderDraftList('boundaries', draft.user.boundaries)}</div><div><h4>关系策略建议</h4>{Object.entries(draft.relationship).map(([key, item]) => <div key={key}>{renderDraftField(`relationship:${key}`, item)}</div>)}</div><div><h4>证据摘录</h4>{draft.evidence.map((item) => <div className="relationship-evidence-item" key={item.id}><small>[{item.id}] {item.sender}</small><span>{item.quote}</span></div>)}</div></div></section>}
          <form key={`${selectedSessionId}:${objectProfile?.updatedAt || 0}`} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; runAction(() => saveProfile(form)) }}>
            <div className="relationship-editor-heading"><div><h3>{displayName || '选择一个联系人'}</h3><small>{selectedSessionId}</small></div><div className="relationship-editor-actions"><button type="button" onClick={() => runAction(forgetSelectedObject)} disabled={!state.memoryEnabled || !selectedSessionId}>删除此档案</button><button type="submit" disabled={!state.memoryEnabled || state.memoryPaused || !selectedSessionId || saving}><Save size={16} />{saving ? '保存中' : '保存档案'}</button></div></div>
            <fieldset disabled={!state.memoryEnabled || state.memoryPaused || !selectedSessionId}>
              <details className="relationship-module" open>
                <summary>当前关系档案</summary>
              <section><h4>我在这段关系中的画像</h4>
                {Object.entries(objectProfile?.selfProfile?.communicationPreferenceModes || {}).map(([value, mode]) => <small key={value}>场景限定：{value}（{{ natural: '自然聊天', caring: '温和关心', flirty: '轻松调情', direct: '直接表达', repair: '冲突修复', boundary: '边界回应', deescalate: '降低投入', end_contact: '结束联系' }[mode] || mode}）</small>)}
                <div className="relationship-form-grid">
                <label>沟通偏好（一行一条）<textarea name="selfPreferences" defaultValue={objectProfile?.selfProfile?.communicationPreferences?.join('\n') || ''} /></label>
                <label>我的优势（一行一条）<textarea name="selfStrengths" defaultValue={objectProfile?.selfProfile?.strengths?.join('\n') || ''} /></label>
                <label>我的限制（一行一条）<textarea name="selfLimitations" defaultValue={objectProfile?.selfProfile?.limitations?.join('\n') || ''} /></label>
                <label>这段关系中的边界（一行一条）<textarea name="selfBoundaries" defaultValue={objectProfile?.selfProfile?.boundaries?.join('\n') || ''} /></label>
              </div></section>
              <section><h4>对方画像</h4><div className="relationship-form-grid">
                <label>称呼<input name="displayLabel" placeholder={displayName} defaultValue={objectProfile?.displayLabel || ''} /></label>
                <label>MBTI（可留空）<input name="mbti" defaultValue={objectProfile?.mbti || ''} /></label>
                <label>主观评分 0–100<input name="subjectiveScore" type="number" min="0" max="100" defaultValue={objectProfile?.subjectiveScore ?? ''} /></label>
              </div><label>已确认事实（一行一条）<textarea name="confirmedFacts" defaultValue={objectProfile?.confirmedFacts.join('\n') || ''} /></label><div className="relationship-memory-list">{(objectProfile?.hypotheses || []).map((item) => {
                const currentStatus = hypothesisStatus(item)
                return <div key={item.value}><span>{{ active: '暂定推测', confirmed: '用户已确认', refuted: '已否定', expired: '已过期' }[currentStatus]}：{item.value}<small> · {item.confidence} · {item.expiresAt ? `有效至 ${new Date(item.expiresAt).toLocaleDateString()}` : '旧记录未设有效期'}</small></span>
                  {currentStatus === 'active' && <><button type="button" disabled={saving} onClick={() => runAction(() => reviewHypothesis(item.value, 'confirmed'))}>确认为事实</button><button type="button" disabled={saving} onClick={() => runAction(() => reviewHypothesis(item.value, 'refuted'))}>否定</button><button type="button" disabled={saving} onClick={() => runAction(() => reviewHypothesis(item.value, 'expired'))}>标记过期</button></>}
                  {currentStatus !== 'active' && <button type="button" disabled={saving} onClick={() => runAction(() => reviewHypothesis(item.value, 'active'))}>重新观察 30 天</button>}
                  <button type="button" disabled={saving} onClick={() => runAction(async () => { const result = await window.electronAPI.relationshipProfile.removeHypothesis(selectedSessionId, item.value, accountScope); setState(result.state); setStatus(result.message || '') })}>删除</button>
                </div>
              })}</div></section>
              <section><h4>这段关系</h4><div className="relationship-form-grid">
                <label>策略有效期（可留空）<input name="expiresAt" type="date" defaultValue={strategy?.expiresAt ? new Date(strategy.expiresAt).toLocaleDateString('en-CA') : ''} /></label>
                <label>我的角色<input name="role" placeholder="如：朋友、暧昧对象、同事" defaultValue={strategy?.role || ''} /></label>
                <label>当前阶段<input name="stage" placeholder="如：刚认识、稳定联系" defaultValue={strategy?.stage || ''} /></label>
                <label>当前目标<input name="goal" placeholder="如：自然推进、修复、退出" defaultValue={strategy?.goal || ''} /></label>
                <label>我的回复态度<input name="replyAttitude" placeholder="如：轻松、真诚、不过度暴露需求" defaultValue={strategy?.replyAttitude || ''} /></label>
                <label>当前行动<input name="currentAction" placeholder="如：提出一个具体邀约" defaultValue={strategy?.currentAction || ''} /></label>
                <label>观察窗口<input name="observationWindow" placeholder="如：未来 7 天观察是否主动" defaultValue={strategy?.observationWindow || ''} /></label>
              </div><label>停止条件<textarea name="stopCondition" placeholder="什么情况下停止推进或降低投入" defaultValue={strategy?.stopCondition || ''} /></label></section>
              </details>
              <details className="relationship-module">
                <summary>互动记录</summary>
              <section><h4>关键事件时间线</h4>
                <div className="relationship-event-list">
                  {(objectProfile?.keyEvents || []).slice().reverse().map((event) => <div className="relationship-event-item" key={event.id}><time>{event.occurredAt}</time><span>{event.summary}</span><small>{event.source === 'user' ? '我确认' : event.source === 'chat' ? '聊天证据' : '暂定推测'}</small></div>)}
                  {!objectProfile?.keyEvents.length && <small>还没有记录关键事件</small>}
                </div>
                <div className="relationship-event-form"><input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused || !selectedSessionId} /><input value={eventSummary} onChange={(event) => setEventSummary(event.target.value)} placeholder="如：对方主动提出周末见面" disabled={!state.memoryEnabled || state.memoryPaused || !selectedSessionId} /><button type="button" onClick={() => runAction(saveEvent)} disabled={!state.memoryEnabled || state.memoryPaused || !selectedSessionId || !eventSummary.trim()}>记录事件</button></div>
              </section>
              <section><h4>最近回复反馈</h4>
                {(objectProfile?.replyOutcomes || []).slice().reverse().map((item) => <details className="relationship-event-item" key={item.id}><summary><time>{new Date(item.createdAt).toLocaleDateString()}</time><span>「{item.draft}」</span><small>{item.outcome}{item.history && item.history.length > 1 ? ` · ${item.history.length} 个状态节点` : ''}</small></summary>{item.history && item.history.length > 1 && <div className="relationship-reply-history">{item.history.map((event, index) => <div key={`${event.createdAt}-${index}`}><time>{new Date(event.createdAt).toLocaleString()}</time><span>{event.outcome}</span></div>)}</div>}</details>)}
                {!objectProfile?.replyOutcomes?.length && <small>使用回复助手后，可记录发送情况和对方回应。</small>}
              </section>
              </details>
              <details className="relationship-module">
                <summary>依据与历史</summary>
              <section><h4>已审核字段的来源</h4>
                {(objectProfile?.fieldSources || []).slice().reverse().map((item, index) => <details key={`${item.field}:${item.value}:${index}`}><summary>{item.value} · {new Date(item.reviewedAt).toLocaleDateString()}</summary><p>{item.quotes.length ? item.quotes.map((quote) => `“${quote}”`).join('；') : '无直接聊天证据，来自审核确认'}</p>{item.expressionExample && <div><p>修改前：{item.expressionExample.previous}</p><p>你认可的表达：{item.expressionExample.approved}</p><p>修改依据：{item.expressionExample.feedback}</p><small>仅参考当前关系的措辞，不代表已发送或持续有效的承诺。</small></div>}<small>{item.evidenceIds.join(' · ')}</small></details>)}
                {!objectProfile?.fieldSources?.length && <small>审核 AI 建议后，可在这里回看依据。</small>}
              </section>
              <section><h4>分析与审核历史</h4><small>分析进度独立于审核进度；丢弃草稿不会确认任何字段。最多保留最近 20 次，不保存完整聊天原文。</small>
{analysisHistory.map((entry) => <details key={entry.draft.taskId}><summary>{new Date(entry.draft.generatedAt).toLocaleString()} · {{ pending: '待审核', accepted: '已提交审核', discarded: '已丢弃', superseded: '已被新分析替代' }[entry.status]} · 覆盖 {entry.draft.coverage.totalMessages.toLocaleString()} 条</summary><p>{entry.draft.report.recommendation?.value || '无总体建议'}</p><small>统计基于全部消息；引用 {entry.draft.evidence.length} 条原文样本</small><p>{entry.draft.report.facts.map((item) => item.value).join('；')}</p></details>)}
                {!analysisHistory.length && <small>暂无已完成分析</small>}
              </section>
              </details>
            </fieldset>
          </form>
          <details className="relationship-module relationship-global-module">
            <summary>我的通用画像</summary>
            <section className="relationship-user-editor"><h4>适用于所有联系人</h4><div className="relationship-form-grid"><label>我的称呼<input value={userDisplayLabel} onChange={(event) => setUserDisplayLabel(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused} /></label><label>我的 MBTI（可留空）<input value={userMbti} onChange={(event) => setUserMbti(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused} /></label><label>我的主观评分 0–100<input type="number" min="0" max="100" value={userScore} onChange={(event) => setUserScore(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused} /></label></div><div className="relationship-form-grid"><label>我的优势（一行一条）<textarea value={userStrengths} onChange={(event) => setUserStrengths(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused} /></label><label>我的短板（一行一条）<textarea value={userLimitations} onChange={(event) => setUserLimitations(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused} /></label></div><label>沟通偏好（一行一条）<textarea value={userPreferences} onChange={(event) => setUserPreferences(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused} placeholder="如：少用表情；不连续发多条消息" /></label><label>我的边界（一行一条）<textarea value={userBoundaries} onChange={(event) => setUserBoundaries(event.target.value)} disabled={!state.memoryEnabled || state.memoryPaused} placeholder="如：不接受持续冷处理；不在工作时间讨论私事" /></label><button type="button" onClick={() => runAction(saveUserProfile)} disabled={!state.memoryEnabled || state.memoryPaused}><Save size={16} />保存我的画像</button></section>
          </details>
          <details className="relationship-module relationship-global-module">
            <summary>记忆版本与归档</summary>
          <section className="relationship-memory-history"><h4>可恢复的历史</h4><small>最近50个修改前版本可恢复；移出的事实、事件和关系专属偏好单独归档，不自动作为当前事实使用。删除此档案会一并清除历史。</small>
            <button type="button" disabled={saving || !selectedSessionId} onClick={() => runAction(refreshMemoryHistory)}>读取记忆历史</button>
            {memoryHistory && <>
              <h5>历史版本（修改前快照）</h5>
              {memoryHistory.versions.map((entry) => <details key={entry.id}><summary>{new Date(entry.createdAt).toLocaleString()} · {entry.reason}</summary><p>旧目标：{entry.relationship?.goal || '未设置'} · 旧态度：{entry.relationship?.replyAttitude || '未设置'}</p><p>旧事实：{entry.object.confirmedFacts.join('；') || '无'}</p><p>旧推测：{entry.object.hypotheses.map((item) => `${item.value}（${item.status || 'active'}）`).join('；') || '无'}</p><p>旧事件：{entry.object.keyEvents.map((item) => `${item.occurredAt} ${item.summary}`).join('；') || '无'}</p><p>旧沟通偏好：{entry.object.selfProfile?.communicationPreferences?.join('；') || '无'}</p><p>旧边界：{entry.object.selfProfile?.boundaries?.join('；') || '无'}</p><button type="button" disabled={saving || !state.memoryEnabled || state.memoryPaused} onClick={() => runAction(() => restoreMemory('version', entry.id))}>确认恢复此版本</button></details>)}
              {!memoryHistory.versions.length && <p>暂无可恢复版本</p>}
              <h5>归档条目</h5><input aria-label="搜索归档" value={archiveQuery} onChange={(event) => setArchiveQuery(event.target.value)} placeholder="搜索旧事实、事件或偏好" />
              {memoryHistory.archives.filter((entry) => entry.value.toLowerCase().includes(archiveQuery.toLowerCase())).slice(0, 100).map((entry) => <details key={entry.id}><summary>{entry.value} · 已归档</summary><p>{entry.event?.occurredAt || new Date(entry.archivedAt).toLocaleString()}</p><p>{entry.source?.quotes.join('；') || '无直接证据摘录；请核对旧信息是否仍有效'}</p><button type="button" disabled={saving || !state.memoryEnabled || state.memoryPaused} onClick={() => runAction(() => restoreMemory('archive', entry.id))}>重新确认此条目</button></details>)}
              <small>共{memoryHistory.archives.length}条归档，最多显示100条匹配结果；可搜索缩小范围。</small>
            </>}
          </section>
          </details>
          {status && <div className="relationship-status">{status}</div>}
        </main>
      </div>
      <section className="relationship-overview"><h3>关系总览</h3><div className="relationship-overview-grid">{overviewRows.map((row) => <button type="button" key={row.sessionId} onClick={() => selectContact(row.sessionId)}><strong>{row.displayLabel}</strong><span>{row.stage} · 目标：{row.goal}</span><span>当前动作：{row.currentAction}</span><small>{row.latestEvent}</small></button>)}{overviewRows.length === 0 && <small>保存联系人档案后，这里会显示关系总览。</small>}</div></section>
    </div>
  )
}

