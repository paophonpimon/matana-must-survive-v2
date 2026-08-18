import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { TeamMeta } from '../types/game'

interface TargetTeamModalProps {
  open: boolean
  teams: TeamMeta[]
  selectedTeamId: string
  onSelect: (teamId: string) => void
  onClose: () => void
}

// Replaces the native <select> for choosing a hostile target. A dropdown on a tablet is a small
// tap target that hides its options behind an OS overlay; this shows every eligible team at once
// as a large card, which is both easier to hit and easier to read from a shared screen.
//
// Eligibility is unchanged: the caller still passes exactly the same opponent list it passed to
// the old select, so nothing about who may be targeted moves.
export const TargetTeamModal = ({ open, teams, selectedTeamId, onSelect, onClose }: TargetTeamModalProps) => {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  // Portalled so the modal is never clipped by the two-column gameplay grid's overflow rules.
  return createPortal(
    <div className="modal-backdrop target-team-backdrop" role="dialog" aria-modal="true" aria-label="เลือกทีมเป้าหมาย" onClick={onClose}>
      <div className="modal-card target-team-modal" onClick={(event) => event.stopPropagation()}>
        <h2 className="target-team-title">เลือกทีมเป้าหมาย</h2>
        <div className="target-team-grid">
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              className={`target-team-card ${selectedTeamId === team.id ? 'target-team-card-selected' : ''}`}
              onClick={() => { onSelect(team.id); onClose() }}
            >
              <span className="target-team-mark" aria-hidden="true">🎯</span>
              <strong>{team.name}</strong>
            </button>
          ))}
        </div>
        {teams.length === 0 ? <p className="target-team-empty">ยังไม่มีทีมเป้าหมายที่เลือกได้</p> : null}
        <button type="button" className="secondary-button w-full" onClick={onClose}>ปิด</button>
      </div>
    </div>,
    document.body,
  )
}
