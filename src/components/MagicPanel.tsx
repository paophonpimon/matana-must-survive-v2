import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { GrimoireModal } from './GrimoireModal'
import { MagicItemIcon } from './MagicItemIcon'
import {
  MAGIC_ITEM_INFO,
  MAGIC_ITEM_TYPES,
  buildIllusionCopy,
  buildIncomingSealCopy,
  buildPowerSurgeCopy,
  buildShieldBlockCopy,
  computeHostileMultiplier,
  getMagicEffectPhase,
  hasAnyMagicItem,
  type MagicEventCopy,
} from '../lib/magic'
import { friendlyError } from '../services'
import { hasShownMagicPopup, markMagicPopupShown } from '../services/sessionStorage'
import type { MagicEvent, MagicItemType, RoomStatus, TeamMagicState, TeamMeta } from '../types/game'

interface MagicToast extends MagicEventCopy {
  key: string
}

// Icon shown on the toast/badge for each tone — a 1:1 mapping since every tone corresponds to
// exactly one item type (the "shield" tone always means rose_shield, whether it's the passive
// availability badge or a shield-block toast).
const ICON_ITEM_BY_TONE: Record<MagicEventCopy['tone'], MagicItemType> = {
  surge: 'power_surge',
  seal: 'score_seal',
  shield: 'rose_shield',
  illusion: 'illusion',
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
  // Grimoire follow-up: the room's actual live question position — distinct from
  // affectedQuestionIndex below (which is only "what a FRESH activation would target," and is
  // null whenever activation isn't currently possible). Needed to tell whether an ALREADY-queued
  // effect is still upcoming ("ข้อต่อไป") or is now the question in progress ("กำลังมีผลในข้อนี้").
  currentQuestionIndex: number
  events: MagicEvent[]
  canActivateNow: boolean
  affectedQuestionIndex: number | null
  onChoose: (itemType: MagicItemType) => Promise<void>
  onActivate: (itemType: 'power_surge' | 'score_seal' | 'illusion', targetTeamId?: string) => Promise<void>
}

const ACTIVATABLE_TYPES: Array<'power_surge' | 'score_seal' | 'illusion'> = ['power_surge', 'score_seal', 'illusion']

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
  currentQuestionIndex,
  events,
  canActivateNow,
  affectedQuestionIndex,
  onChoose,
  onActivate,
}: MagicPanelProps) => {
  const [selectedStartingItem, setSelectedStartingItem] = useState<MagicItemType | ''>('')
  const [selectedActivationItem, setSelectedActivationItem] = useState<'power_surge' | 'score_seal' | 'illusion' | ''>('')
  const [selectedTargetTeamId, setSelectedTargetTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [toastQueue, setToastQueue] = useState<MagicToast[]>([])
  const [activeToast, setActiveToast] = useState<MagicToast | null>(null)
  // Grimoire access point: covers both "Lobby / starting-item selection" (via LobbyPage) and
  // "student game/inventory area" (via GamePage) in one place, since both render MagicPanel.
  // Purely local UI state — never touches room/service state, so opening it can't pause the
  // timer or alter game state.
  const [grimoireOpen, setGrimoireOpen] = useState(false)

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
          newToasts.push({ key: popupKey, ...buildIncomingSealCopy(count, event.affectedQuestionIndex + 1) })
          markMagicPopupShown(roomCode, popupKey)
        }
      }
      if (event.status === 'queued' && event.itemType === 'power_surge' && event.sourceTeamId === teamId && event.affectedQuestionIndex != null) {
        const popupKey = `${event.id}:power-surge`
        if (!hasShownMagicPopup(roomCode, popupKey)) {
          newToasts.push({ key: popupKey, ...buildPowerSurgeCopy(event.affectedQuestionIndex + 1) })
          markMagicPopupShown(roomCode, popupKey)
        }
      }
      if (event.status === 'queued' && event.itemType === 'illusion' && event.sourceTeamId === teamId && event.affectedQuestionIndex != null) {
        const popupKey = `${event.id}:illusion`
        if (!hasShownMagicPopup(roomCode, popupKey)) {
          newToasts.push({ key: popupKey, ...buildIllusionCopy(event.affectedQuestionIndex + 1) })
          markMagicPopupShown(roomCode, popupKey)
        }
      }
      if (event.status === 'blocked' && event.itemType === 'score_seal' && event.targetTeamId === teamId) {
        const popupKey = `${event.id}:shield-block`
        if (!hasShownMagicPopup(roomCode, popupKey)) {
          newToasts.push({ key: popupKey, ...buildShieldBlockCopy() })
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
  // Milestone: while the room is still 'waiting', the current pick (if any) is always exactly
  // one type — this is what the picker below pre-selects, and what a re-submit without touching
  // any button (re-confirm) would resubmit unchanged.
  const currentStartingItemType = heldTypes.length === 1 ? heldTypes[0] : null
  const effectiveStartingItem = selectedStartingItem || currentStartingItemType || ''

  const submitChoice = async (): Promise<void> => {
    if (!effectiveStartingItem) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onChoose(effectiveStartingItem)
      setNotice(hasChosenStartingItem ? 'เปลี่ยนไอเทมเริ่มต้นเรียบร้อยแล้ว' : 'เลือกไอเทมเริ่มต้นเรียบร้อยแล้ว')
      setSelectedStartingItem('')
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

  // Bug fix: this toast is purely informational (no click handler, nothing to dismiss by hand —
  // it auto-clears itself above) and used to be mounted as a normal child of this section, whose
  // `.glass-panel` class carries `backdrop-filter`. Per the CSS spec, a `backdrop-filter` (like
  // `transform`/`filter`/`perspective`) on an ancestor makes THAT ancestor the containing block
  // for any `position: fixed` descendant — so instead of staying pinned to the viewport, the
  // toast was being positioned relative to this panel's own (scrolled-down, mid-page) box,
  // landing on top of this panel's own controls (the item-activation buttons, grimoire trigger)
  // for as long as it was visible. Portaling it to `document.body` escapes every such ancestor so
  // it is always genuinely viewport-fixed, and `pointer-events: none` (added in CSS) means it can
  // never intercept a tap even while visible, on top of whatever it happens to render over.
  const toastOverlay = activeToast ? createPortal(
    <div className="magic-toast-stack" aria-live="assertive">
      <div className={`magic-toast magic-toast-${activeToast.tone}`}>
        <span className="magic-toast-icon-wrap" aria-hidden="true">
          <span className="magic-toast-glow" />
          <MagicItemIcon itemType={ICON_ITEM_BY_TONE[activeToast.tone]} size="lg" />
        </span>
        <div className="magic-toast-copy">
          <strong className="magic-toast-headline">{activeToast.headline}</strong>
          <p>{activeToast.body}</p>
        </div>
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <section className="glass-panel mt-5 p-5" aria-label="สถานะมนตรา">
      {toastOverlay}

      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">มนตรา</p>
        <div className="flex items-center gap-2">
          {magic.magicHolderPlayerId ? <span className="magic-badge magic-badge-captain">👑 {isHolder ? 'คุณคือผู้ถือคทา' : 'มีผู้ถือคทาแล้ว'}</span> : null}
          <button type="button" className="grimoire-trigger-button" onClick={() => setGrimoireOpen(true)}>
            📜 คัมภีร์มนตรา
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm text-[#c0b7ab]">
        {magic.magicHolderPlayerId
          ? (isHolder ? 'คุณคือผู้ถือคทาเวทมนตร์ของทีมนี้' : 'ผู้ถือคทาเวทมนตร์ของทีมนี้เท่านั้นที่ใช้ไอเทมได้')
          : 'ยังไม่มีผู้ถือคทาเวทมนตร์'}
      </p>

      {/* Item 7: compact "active effect" badges — icon + short Thai label, remain visible for as
          long as the underlying state is true, distinct from the transient toast above.
          Grimoire follow-up: wording now distinguishes queued ("ข้อต่อไป") from active
          ("กำลังมีผลในข้อนี้") via getMagicEffectPhase, instead of always saying "ข้อต่อไป" even
          once the target question is actually the one in progress. */}
      {magic.queuedEffect || incomingSealSummaries.length > 0 || magic.inventory.rose_shield.available > 0 ? (
        <div className="magic-status-badges" role="list" aria-label="สถานะมนตราปัจจุบัน">
          {magic.queuedEffect ? (() => {
            const phase = getMagicEffectPhase(magic.queuedEffect.affectedQuestionIndex, currentQuestionIndex)
            const phaseLabel = phase === 'active' ? 'กำลังมีผลในข้อนี้' : 'ข้อต่อไป'
            const itemLabel = magic.queuedEffect.itemType === 'power_surge' ? 'x2' : magic.queuedEffect.itemType === 'illusion' ? 'มายา' : 'ผนึก'
            return (
              <span className={`magic-badge magic-badge-${magic.queuedEffect.itemType === 'power_surge' ? 'surge' : magic.queuedEffect.itemType === 'illusion' ? 'illusion' : 'seal'}`} role="listitem">
                <MagicItemIcon itemType={magic.queuedEffect.itemType} size="sm" />
                {itemLabel} {phaseLabel}
              </span>
            )
          })() : null}
          {incomingSealSummaries.length > 0 ? (
            <span className="magic-badge magic-badge-seal" role="listitem">
              <MagicItemIcon itemType="score_seal" size="sm" /> ถูกผนึก {getMagicEffectPhase(incomingSealSummaries[0].questionIndex, currentQuestionIndex) === 'active' ? 'กำลังมีผลในข้อนี้' : 'ข้อต่อไป'}
            </span>
          ) : null}
          {magic.inventory.rose_shield.available > 0 ? (
            <span className="magic-badge magic-badge-shield" role="listitem">
              <MagicItemIcon itemType="rose_shield" size="sm" /> ป้องกันอัตโนมัติได้อีก {magic.inventory.rose_shield.available} ครั้ง
            </span>
          ) : null}
        </div>
      ) : null}

      {!hasChosenStartingItem ? (
        <p className="mt-2 text-sm text-[#8b8377]">ทีมนี้ยังไม่ได้เลือกไอเทมเริ่มต้น</p>
      ) : (
        <>
          {/* Milestone 4: inventory is now a count per item type (starting choice + boss
              rewards can both add to the same type), not a list of one-off instances — every
              team member sees available vs. used counts here, not just the holder. */}
          <div className="magic-inventory-row" role="list" aria-label="ไอเทมของทีม">
            {heldTypes.map((itemType) => {
              const entry = magic.inventory[itemType]
              return (
                <div key={itemType} className="magic-inventory-chip" role="listitem">
                  <MagicItemIcon itemType={itemType} />
                  <span className="magic-inventory-chip-label">{MAGIC_ITEM_INFO[itemType].label}</span>
                  <span className="magic-inventory-chip-count">
                    ×{entry.available}
                    {entry.consumed > 0 ? <small> (ใช้แล้ว {entry.consumed})</small> : null}
                  </span>
                </div>
              )
            })}
          </div>
          {/* Milestone 2.2: choosing a starting item never implies immediate use — this line
              makes that explicit to the whole team, not just the holder, for as long as the
              room hasn't started playing yet (once playing, the holder-only section below takes
              over with either activation controls or an ineligibility explanation). */}
          {activatableTypes.length > 0 && !magic.queuedEffect && roomStatus === 'waiting' ? (
            <p className="mt-2 text-sm text-[#d8d1c5]">ทีมเลือกไอเทมแล้ว ไอเทมจะถูกเก็บไว้ใช้ระหว่างภารกิจ</p>
          ) : null}
        </>
      )}

      {(magic.queuedEffect || incomingSealSummaries.length > 0) ? (
        <div className="mt-3 space-y-1.5 text-xs text-[#c0b7ab]">
          {/* Grimoire follow-up: "จะมีผล...ข้อต่อไป" while queued vs "กำลังมีผลในข้อนี้" once the
              target question is the one actually in progress — never "กำลังรอผล" (ambiguous
              about which question) for both states like before. */}
          {magic.queuedEffect ? (() => {
            const phase = getMagicEffectPhase(magic.queuedEffect.affectedQuestionIndex, currentQuestionIndex)
            const timing = phase === 'active'
              ? `กำลังมีผลในคำถามข้อนี้ (ข้อ ${magic.queuedEffect.affectedQuestionIndex + 1})`
              : `จะมีผลในคำถามข้อต่อไป (ข้อ ${magic.queuedEffect.affectedQuestionIndex + 1})`
            return (
              <p className="flex items-center gap-1.5">
                <MagicItemIcon itemType={magic.queuedEffect.itemType} size="sm" />
                {magic.queuedEffect.itemType === 'power_surge'
                  ? `มนตร์ทวีพลังของทีม ${timing} — คะแนนที่ทำได้ในข้อนั้น ×2`
                  : magic.queuedEffect.itemType === 'illusion'
                    ? `มนตร์ลวงตา ${timing} — ตัดตัวเลือกผิด 1 ข้อให้ทั้งทีม`
                    : `มนตร์ผนึกคะแนนของทีมกำลังส่งผลกับ ${teams.find((team) => team.id === magic.queuedEffect?.targetTeamId)?.name ?? 'ทีมเป้าหมาย'} — ${timing}`}
              </p>
            )
          })() : null}
          {incomingSealSummaries.map((summary) => {
            const phase = getMagicEffectPhase(summary.questionIndex, currentQuestionIndex)
            const timing = phase === 'active' ? `กำลังมีผลในข้อนี้ (ข้อ ${summary.questionIndex + 1})` : `จะมีผลในข้อต่อไป (ข้อ ${summary.questionIndex + 1})`
            return (
              <p key={summary.questionIndex} className="flex items-center gap-1.5 text-[#f3aaa7]">
                <MagicItemIcon itemType="score_seal" size="sm" />
                ถูกผนึกคะแนน {summary.count} ครั้ง — {timing} (คะแนนแข่งขันจะเหลือ {formatPercent(computeHostileMultiplier(summary.count))}%)
              </p>
            )
          })}
        </div>
      ) : null}

      {/* Milestone: the picker stays available (not just before the first pick) for as long as
          roomStatus === 'waiting' — this is what lets the captain change their mind any number
          of times before the mission starts, and what makes it disappear the moment roomStatus
          becomes 'playing' (this section simply doesn't render then), locking the choice in
          permanently. The current pick (if any) is pre-selected via effectiveStartingItem. */}
      {isHolder && roomStatus === 'waiting' ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-[#d8d1c5]">
            {hasChosenStartingItem ? 'ไอเทมเริ่มต้นของทีม (เปลี่ยนได้จนกว่าจะเริ่มภารกิจ)' : 'เลือกไอเทมเริ่มต้นของทีม'}
          </p>
          <div className="grid gap-2">
            {MAGIC_ITEM_TYPES.map((itemType) => (
              <button
                key={itemType}
                type="button"
                className={`choice-button ${effectiveStartingItem === itemType ? 'choice-selected' : ''}`}
                onClick={() => setSelectedStartingItem(itemType)}
                disabled={busy}
              >
                <MagicItemIcon itemType={itemType} />
                <strong>{MAGIC_ITEM_INFO[itemType].label}<small className="block text-xs font-normal text-[#c0b7ab]">{MAGIC_ITEM_INFO[itemType].description}</small></strong>
              </button>
            ))}
          </div>
          <button className="primary-button w-full" type="button" onClick={() => void submitChoice()} disabled={!effectiveStartingItem || busy}>
            {busy ? 'กำลังยืนยัน...' : hasChosenStartingItem ? 'ยืนยันการเปลี่ยนไอเทม' : 'ยืนยันไอเทมเริ่มต้น'}
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
                    <MagicItemIcon itemType={itemType} />
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
          <p className="mt-3 text-sm text-[#8b8377]">ไม่สามารถใช้ไอเทมได้แล้ว เนื่องจากไม่มีคำถามข้อต่อไปที่ไอเทมมีผลได้ในภารกิจนี้</p>
        ) : null
      ) : null}

      {error ? <p className="error-message mt-3" role="alert">{error}</p> : null}
      {notice && !error ? <p className="success-message mt-3" role="status">{notice}</p> : null}

      <GrimoireModal open={grimoireOpen} onClose={() => setGrimoireOpen(false)} />
    </section>
  )
}
