import { useEffect, useMemo, useState } from 'react'
import { MAGIC_ITEM_INFO, MAGIC_ITEM_TYPES, computeHostileMultiplier, hasAnyMagicItem } from '../lib/magic'
import { friendlyError } from '../services'
import { hasShownMagicPopup, markMagicPopupShown } from '../services/sessionStorage'
import type { MagicEvent, MagicItemType, RoomStatus, TeamMagicState, TeamMeta } from '../types/game'

interface MagicToast {
  key: string
  icon: string
  tone: 'seal' | 'surge' | 'shield'
  message: string
}

interface MagicPanelProps {
  magic: TeamMagicState | null
  magicLoading: boolean
  teams: TeamMeta[]
  isHolder: boolean
  // Milestone 2.2: selecting a starting item (lobby) and activating it (in-mission) are
  // separate actions — roomStatus is what distinguishes "chosen, stored for later" (waiting)
  // from "chosen, but no eligible question left to affect" (playing, canActivateNow false).
  roomStatus: RoomStatus
  // Milestone 4: needed for the one-time popup dedup key (sessionStorage is keyed per room) and
  // to filter the shared magicEvents log down to the current round.
  roomCode: string
  currentRound: number
  events: MagicEvent[]
  canActivateNow: boolean
  affectedQuestionIndex: number | null
  onChoose: (itemType: MagicItemType) => Promise<void>
  onActivate: (itemType: 'power_surge' | 'score_seal', targetTeamId?: string) => Promise<void>
}

const ACTIVATABLE_TYPES: Array<'power_surge' | 'score_seal'> = ['power_surge', 'score_seal']

const formatPercent = (multiplier: number): string => {
  const percent = multiplier * 100
  return Number.isInteger(percent) ? `${percent}` : percent.toFixed(1)
}

// Shared by LobbyPage (selection only — always canActivateNow=false, roomStatus='waiting') and
// GamePage (selection already done; activation live throughout the current question) so the
// magic UI is built once, not twice.
export const MagicPanel = ({
  magic,
  magicLoading,
  teams,
  isHolder,
  roomStatus,
  roomCode,
  currentRound,
  events,
  canActivateNow,
  affectedQuestionIndex,
  onChoose,
  onActivate,
}: MagicPanelProps) => {
  const [selectedStartingItem, setSelectedStartingItem] = useState<MagicItemType | ''>('')
  const [selectedActivationItem, setSelectedActivationItem] = useState<'power_surge' | 'score_seal' | ''>('')
  const [selectedTargetTeamId, setSelectedTargetTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [toastQueue, setToastQueue] = useState<MagicToast[]>([])
  const [activeToast, setActiveToast] = useState<MagicToast | null>(null)

  const teamId = magic?.teamId ?? ''

  const roundEvents = useMemo(
    () => events.filter((event) => event.round === currentRound),
    [events, currentRound],
  )

  // Milestone 4 section 3: incoming seal count/question is a persistent status, visible to
  // every team member at all times — distinct from the one-time popup below, which only fires
  // the moment a NEW seal event is first observed.
  const incomingSealSummaries = useMemo(() => {
    if (!teamId) return []
    const byQuestion = new Map<number, number>()
    roundEvents.forEach((event) => {
      if (event.status !== 'queued' || event.itemType !== 'score_seal') return
      if (event.targetTeamId !== teamId || event.affectedQuestionIndex == null) return
      byQuestion.set(event.affectedQuestionIndex, (byQuestion.get(event.affectedQuestionIndex) ?? 0) + 1)
    })
    return Array.from(byQuestion.entries())
      .map(([questionIndex, count]) => ({ questionIndex, count }))
      .sort((a, b) => a.questionIndex - b.questionIndex)
  }, [roundEvents, teamId])

  // Milestone 4: watch the room's magic event log for events concerning this team and queue the
  // exact-text popups required once per event — sessionStorage (not just React state) is what
  // makes "shown once per event, survives a refresh in this tab" true; see
  // services/sessionStorage.ts for the per-tab rationale this mirrors.
  useEffect(() => {
    if (!teamId || roundEvents.length === 0) return
    const queuedSealCountByKey = new Map<string, number>()
    roundEvents.forEach((event) => {
      if (event.itemType !== 'score_seal' || event.status !== 'queued' || event.targetTeamId == null) return
      const key = `${event.targetTeamId}:${event.affectedQuestionIndex}`
      queuedSealCountByKey.set(key, (queuedSealCountByKey.get(key) ?? 0) + 1)
    })

    const newToasts: MagicToast[] = []
    const sorted = [...roundEvents].sort((a, b) => a.createdAt - b.createdAt)
    for (const event of sorted) {
      if (event.status === 'queued' && event.itemType === 'score_seal' && event.targetTeamId === teamId && event.affectedQuestionIndex != null) {
        const popupKey = `${event.id}:incoming-seal`
        if (!hasShownMagicPopup(roomCode, popupKey)) {
          const key = `${teamId}:${event.affectedQuestionIndex}`
          const count = queuedSealCountByKey.get(key) ?? 1
          const questionNumber = event.affectedQuestionIndex + 1
          const message = count >= 2
            ? `ถูกผนึกคะแนน ${count} ครั้ง — คะแนนแข่งขันจะเหลือ ${formatPercent(computeHostileMultiplier(count))}%`
            : `🔒 ทีมของคุณถูกผนึกคะแนน!\nคะแนนแข่งขันจากคำถามข้อ ${questionNumber} จะถูกลดลงเหลือครึ่งหนึ่ง`
          newToasts.push({ key: popupKey, icon: '🔒', tone: 'seal', message })
          markMagicPopupShown(roomCode, popupKey)
        }
      }
      if (event.status === 'queued' && event.itemType === 'power_surge' && event.sourceTeamId === teamId && event.affectedQuestionIndex != null) {
        const popupKey = `${event.id}:power-surge`
        if (!hasShownMagicPopup(roomCode, popupKey)) {
          const questionNumber = event.affectedQuestionIndex + 1
          newToasts.push({
            key: popupKey,
            icon: '⚡',
            tone: 'surge',
            message: `⚡ มนตร์ทวีคะแนนทำงาน!\nคะแนนแข่งขันจากคำถามข้อ ${questionNumber} จะเพิ่มขึ้นเป็น 2 เท่า`,
          })
          markMagicPopupShown(roomCode, popupKey)
        }
      }
      if (event.status === 'blocked' && event.itemType === 'score_seal' && event.targetTeamId === teamId) {
        const popupKey = `${event.id}:shield-block`
        if (!hasShownMagicPopup(roomCode, popupKey)) {
          newToasts.push({
            key: popupKey,
            icon: '🛡️',
            tone: 'shield',
            message: '🛡️ เกราะกุหลาบป้องกันสำเร็จ!\nทีมของคุณไม่ถูกลดคะแนน และเกราะถูกใช้ไปแล้ว',
          })
          markMagicPopupShown(roomCode, popupKey)
        }
      }
    }
    if (newToasts.length > 0) setToastQueue((current) => [...current, ...newToasts])
  }, [roundEvents, teamId, roomCode])

  // One toast visible at a time; auto-dismiss after 5s, then the queue advances.
  useEffect(() => {
    if (activeToast || toastQueue.length === 0) return
    setActiveToast(toastQueue[0])
    setToastQueue((current) => current.slice(1))
  }, [activeToast, toastQueue])

  useEffect(() => {
    if (!activeToast) return
    const timeoutId = window.setTimeout(() => setActiveToast(null), 5_000)
    return () => window.clearTimeout(timeoutId)
  }, [activeToast])

  if (magicLoading) {
    return (
      <section className="glass-panel mt-5 p-5" aria-live="polite">
        <p className="eyebrow">มนตรา</p>
        <p className="mt-2 text-sm text-[#c0b7ab]">กำลังโหลดข้อมูลมนตรา...</p>
      </section>
    )
  }
  if (!magic) return null

  const hasChosenStartingItem = hasAnyMagicItem(magic.inventory)
  const heldTypes = MAGIC_ITEM_TYPES.filter((itemType) => magic.inventory[itemType].available > 0 || magic.inventory[itemType].consumed > 0)
  const activatableTypes = ACTIVATABLE_TYPES.filter((itemType) => magic.inventory[itemType].available > 0)
  const effectiveActivationItem = activatableTypes.length === 1 ? activatableTypes[0] : (selectedActivationItem || null)
  const opponentTeams = teams.filter((team) => team.id !== magic.teamId)

  const submitChoice = async (): Promise<void> => {
    if (!selectedStartingItem) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onChoose(selectedStartingItem)
      setNotice('เลือกไอเทมเริ่มต้นเรียบร้อยแล้ว')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  const submitActivation = async (): Promise<void> => {
    if (!effectiveActivationItem) return
    if (effectiveActivationItem === 'score_seal' && !selectedTargetTeamId) {
      setError('กรุณาเลือกทีมเป้าหมาย')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onActivate(effectiveActivationItem, effectiveActivationItem === 'score_seal' ? selectedTargetTeamId : undefined)
      setNotice(affectedQuestionIndex != null ? `ใช้ไอเทมแล้ว จะมีผลกับคำถามข้อที่ ${affectedQuestionIndex + 1}` : 'ใช้ไอเทมแล้ว')
      setSelectedActivationItem('')
      setSelectedTargetTeamId('')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="glass-panel mt-5 p-5" aria-label="สถานะมนตรา">
      {activeToast ? (
        <div className="magic-toast-stack" aria-live="assertive">
          <div className={`magic-toast magic-toast-${activeToast.tone}`}>
            <span className="magic-toast-icon" aria-hidden="true">{activeToast.icon}</span>
            <p>{activeToast.message}</p>
          </div>
        </div>
      ) : null}

      <p className="eyebrow">มนตรา</p>
      <p className="mt-1 text-sm text-[#c0b7ab]">
        {magic.magicHolderPlayerId
          ? (isHolder ? 'คุณคือผู้ถือคทาเวทมนตร์ของทีมนี้' : 'ผู้ถือคทาเวทมนตร์ของทีมนี้เท่านั้นที่ใช้ไอเทมได้')
          : 'ยังไม่มีผู้ถือคทาเวทมนตร์'}
      </p>

      {!hasChosenStartingItem ? (
        <p className="mt-2 text-sm text-[#8b8377]">ทีมนี้ยังไม่ได้เลือกไอเทมเริ่มต้น</p>
      ) : (
        <>
          {/* Milestone 4: inventory is now a count per item type (starting choice + boss
              rewards can both add to the same type), not a list of one-off instances — every
              team member sees available vs. used counts here, not just the holder. */}
          <ul className="mt-3 space-y-1 text-sm">
            {heldTypes.map((itemType) => {
              const entry = magic.inventory[itemType]
              return (
                <li key={itemType} className="text-[#fff7df]">
                  {MAGIC_ITEM_INFO[itemType].label} — พร้อมใช้ {entry.available} ชิ้น
                  {entry.consumed > 0 ? <span className="text-[#8b8377]">{` · ใช้ไปแล้ว ${entry.consumed} ชิ้น`}</span> : null}
                </li>
              )
            })}
          </ul>
          {/* Milestone 2.2: choosing a starting item never implies immediate use — this line
              makes that explicit to the whole team, not just the holder, for as long as the
              room hasn't started playing yet (once playing, the holder-only section below takes
              over with either activation controls or an ineligibility explanation). */}
          {activatableTypes.length > 0 && !magic.queuedEffect && roomStatus === 'waiting' ? (
            <p className="mt-2 text-sm text-[#d8d1c5]">ทีมเลือกไอเทมแล้ว ไอเทมจะถูกเก็บไว้ใช้ระหว่างภารกิจ</p>
          ) : null}
        </>
      )}

      {magic.queuedEffect ? (
        <p className="mt-3 text-sm text-[#f2d58d]">
          {magic.queuedEffect.itemType === 'power_surge'
            ? `⚡ มนตร์ทวีพลังของทีมกำลังรอผลในคำถามข้อที่ ${magic.queuedEffect.affectedQuestionIndex + 1}`
            : `🔒 มนตร์ผนึกคะแนนของทีมกำลังรอผลกับ ${teams.find((team) => team.id === magic.queuedEffect?.targetTeamId)?.name ?? 'ทีมเป้าหมาย'} ในคำถามข้อที่ ${magic.queuedEffect.affectedQuestionIndex + 1}`}
        </p>
      ) : null}

      {incomingSealSummaries.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-[#f3aaa7]">
          {incomingSealSummaries.map((summary) => (
            <li key={summary.questionIndex}>
              ⚠️ ถูกผนึกคะแนน {summary.count} ครั้งในคำถามข้อที่ {summary.questionIndex + 1} (คะแนนแข่งขันจะเหลือ {formatPercent(computeHostileMultiplier(summary.count))}%)
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-sm text-[#c0b7ab]">
        🛡️ เกราะกุหลาบ: พร้อมใช้ {magic.inventory.rose_shield.available} ชิ้น
        {magic.inventory.rose_shield.consumed > 0 ? ` · ใช้ไปแล้ว ${magic.inventory.rose_shield.consumed} ชิ้น` : ''}
      </p>

      {isHolder && !hasChosenStartingItem ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-[#d8d1c5]">เลือกไอเทมเริ่มต้นของทีม (เลือกได้ครั้งเดียว)</p>
          <div className="grid gap-2">
            {MAGIC_ITEM_TYPES.map((itemType) => (
              <button
                key={itemType}
                type="button"
                className={`choice-button ${selectedStartingItem === itemType ? 'choice-selected' : ''}`}
                onClick={() => setSelectedStartingItem(itemType)}
                disabled={busy}
              >
                <span aria-hidden="true">✦</span>
                <strong>{MAGIC_ITEM_INFO[itemType].label}<small className="block text-xs font-normal text-[#c0b7ab]">{MAGIC_ITEM_INFO[itemType].description}</small></strong>
              </button>
            ))}
          </div>
          <button className="primary-button w-full" type="button" onClick={() => void submitChoice()} disabled={!selectedStartingItem || busy}>
            {busy ? 'กำลังยืนยัน...' : 'ยืนยันไอเทมเริ่มต้น'}
          </button>
        </div>
      ) : null}

      {isHolder && activatableTypes.length > 0 && !magic.queuedEffect ? (
        canActivateNow ? (
          <div className="mt-4 space-y-3">
            {activatableTypes.length > 1 ? (
              <div className="grid gap-2">
                {activatableTypes.map((itemType) => (
                  <button
                    key={itemType}
                    type="button"
                    className={`choice-button ${selectedActivationItem === itemType ? 'choice-selected' : ''}`}
                    onClick={() => setSelectedActivationItem(itemType)}
                    disabled={busy}
                  >
                    <span aria-hidden="true">✦</span>
                    <strong>{MAGIC_ITEM_INFO[itemType].label} ({magic.inventory[itemType].available})</strong>
                  </button>
                ))}
              </div>
            ) : null}
            <p className="text-sm text-[#d8d1c5]">
              {effectiveActivationItem ? `ใช้ ${MAGIC_ITEM_INFO[effectiveActivationItem].label}` : 'เลือกไอเทมที่จะใช้'}
              {affectedQuestionIndex != null ? ` — จะมีผลกับคำถามข้อที่ ${affectedQuestionIndex + 1}` : ''}
            </p>
            {effectiveActivationItem === 'score_seal' ? (
              <select value={selectedTargetTeamId} onChange={(event) => setSelectedTargetTeamId(event.target.value)} disabled={busy} aria-label="เลือกทีมเป้าหมาย">
                <option value="">เลือกทีมเป้าหมาย</option>
                {opponentTeams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            ) : null}
            <button className="primary-button w-full" type="button" onClick={() => void submitActivation()} disabled={busy || !effectiveActivationItem}>
              {busy ? 'กำลังใช้ไอเทม...' : 'ใช้ไอเทมนี้'}
            </button>
          </div>
        ) : roomStatus === 'playing' ? (
          // Milestone 2.2: activation is available for the ENTIRE lifecycle of the current
          // question once playing (no timer gate) — the only way canActivateNow is false while
          // playing is that no eligible future question is left (currently on, or one away
          // from, the final question), which is permanent for the rest of this round.
          <p className="mt-3 text-sm text-[#8b8377]">ไม่สามารถใช้ไอเทมได้แล้ว เนื่องจากไม่มีคำถามข้อถัดไปที่ไอเทมมีผลได้ในภารกิจนี้</p>
        ) : null
      ) : null}

      {error ? <p className="error-message mt-3" role="alert">{error}</p> : null}
      {notice && !error ? <p className="success-message mt-3" role="status">{notice}</p> : null}
    </section>
  )
}
