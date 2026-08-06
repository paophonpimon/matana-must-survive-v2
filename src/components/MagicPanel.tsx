import { useState } from 'react'
import { MAGIC_ITEM_INFO } from '../lib/magic'
import { friendlyError } from '../services'
import type { MagicItemType, TeamMagicState, TeamMeta } from '../types/game'

interface MagicPanelProps {
  magic: TeamMagicState | null
  magicLoading: boolean
  teams: TeamMeta[]
  isHolder: boolean
  canActivateNow: boolean
  affectedQuestionIndex: number | null
  onChoose: (itemType: MagicItemType) => Promise<void>
  onActivate: (itemType: 'power_surge' | 'score_seal', targetTeamId?: string) => Promise<void>
}

const ITEM_TYPES: MagicItemType[] = ['power_surge', 'score_seal', 'rose_shield']

// Shared by LobbyPage (activation window = the waiting lobby) and GamePage (activation
// window = the answer-reveal/intermission period) so the magic UI is built once, not twice.
export const MagicPanel = ({ magic, magicLoading, teams, isHolder, canActivateNow, affectedQuestionIndex, onChoose, onActivate }: MagicPanelProps) => {
  const [selectedStartingItem, setSelectedStartingItem] = useState<MagicItemType | ''>('')
  const [selectedTargetTeamId, setSelectedTargetTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  if (magicLoading) {
    return (
      <section className="glass-panel mt-5 p-5" aria-live="polite">
        <p className="eyebrow">มนตรา</p>
        <p className="mt-2 text-sm text-[#c0b7ab]">กำลังโหลดข้อมูลมนตรา...</p>
      </section>
    )
  }
  if (!magic) return null

  const hasChosenStartingItem = magic.inventory.length > 0
  const unconsumedItem = magic.inventory.find((item) => !item.consumed) ?? null
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
    if (!unconsumedItem || unconsumedItem.itemType === 'rose_shield') return
    if (unconsumedItem.itemType === 'score_seal' && !selectedTargetTeamId) {
      setError('กรุณาเลือกทีมเป้าหมาย')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onActivate(
        unconsumedItem.itemType as 'power_surge' | 'score_seal',
        unconsumedItem.itemType === 'score_seal' ? selectedTargetTeamId : undefined,
      )
      setNotice(affectedQuestionIndex != null ? `ใช้ไอเทมแล้ว จะมีผลกับคำถามข้อที่ ${affectedQuestionIndex + 1}` : 'ใช้ไอเทมแล้ว')
      setSelectedTargetTeamId('')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="glass-panel mt-5 p-5" aria-label="สถานะมนตรา">
      <p className="eyebrow">มนตรา</p>
      <p className="mt-1 text-sm text-[#c0b7ab]">
        {magic.magicHolderPlayerId
          ? (isHolder ? 'คุณคือผู้ถือคทาเวทมนตร์ของทีมนี้' : 'ผู้ถือคทาเวทมนตร์ของทีมนี้เท่านั้นที่ใช้ไอเทมได้')
          : 'ยังไม่มีผู้ถือคทาเวทมนตร์'}
      </p>

      {!hasChosenStartingItem ? (
        <p className="mt-2 text-sm text-[#8b8377]">ทีมนี้ยังไม่ได้เลือกไอเทมเริ่มต้น</p>
      ) : (
        <ul className="mt-3 space-y-1 text-sm">
          {magic.inventory.map((item, index) => (
            <li key={index} className={item.consumed ? 'text-[#8b8377] line-through' : 'text-[#fff7df]'}>
              {MAGIC_ITEM_INFO[item.itemType].label}{item.consumed ? ' (ใช้แล้ว)' : ''}
            </li>
          ))}
        </ul>
      )}

      {magic.queuedEffect ? (
        <p className="mt-3 text-sm text-[#f2d58d]">
          ไอเทมของทีมกำลังรอผลในคำถามข้อที่ {magic.queuedEffect.affectedQuestionIndex + 1}
        </p>
      ) : null}

      {isHolder && !hasChosenStartingItem ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-[#d8d1c5]">เลือกไอเทมเริ่มต้นของทีม (เลือกได้ครั้งเดียว)</p>
          <div className="grid gap-2">
            {ITEM_TYPES.map((itemType) => (
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

      {isHolder && hasChosenStartingItem && unconsumedItem && unconsumedItem.itemType !== 'rose_shield' && !magic.queuedEffect ? (
        canActivateNow ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-[#d8d1c5]">
              ใช้ {MAGIC_ITEM_INFO[unconsumedItem.itemType].label}
              {affectedQuestionIndex != null ? ` — จะมีผลกับคำถามข้อที่ ${affectedQuestionIndex + 1}` : ''}
            </p>
            {unconsumedItem.itemType === 'score_seal' ? (
              <select value={selectedTargetTeamId} onChange={(event) => setSelectedTargetTeamId(event.target.value)} disabled={busy} aria-label="เลือกทีมเป้าหมาย">
                <option value="">เลือกทีมเป้าหมาย</option>
                {opponentTeams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            ) : null}
            <button className="primary-button w-full" type="button" onClick={() => void submitActivation()} disabled={busy}>
              {busy ? 'กำลังใช้ไอเทม...' : 'ใช้ไอเทมนี้'}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[#8b8377]">ใช้ไอเทมได้เฉพาะช่วงรอเริ่มคำถามหรือช่วงเฉลย</p>
        )
      ) : null}

      {error ? <p className="error-message mt-3" role="alert">{error}</p> : null}
      {notice && !error ? <p className="success-message mt-3" role="status">{notice}</p> : null}
    </section>
  )
}
