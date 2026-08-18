import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { GrimoireCard } from './GrimoireCard'
import { MAGIC_ITEM_TYPES } from '../lib/magic'

interface GrimoireModalProps {
  open: boolean
  onClose: () => void
}

// "คัมภีร์มนตรา" (Magic Grimoire) — a pure reference modal: local-only open/close state, no
// service calls, no game-state writes, so opening/closing it can never alter room state or pause
// any timer (see every access point's call site — each just flips a useState boolean).
//
// iPad fix: this used to render as a normal child of MagicPanel's `.glass-panel` section, whose
// `backdrop-filter` makes it the containing block for any `position: fixed` descendant (per the
// CSS spec — same rule as `transform`/`filter`/`perspective`). That silently turned the
// "fixed, full-viewport" backdrop into something sized/positioned relative to that scrolled-down
// panel instead of the screen — an oversized, wrongly-placed box exactly matching the reported
// "traps the user" symptom, worst on iPad Safari where this containing-block behavior is strictly
// enforced. A portal to `document.body` guarantees this is never nested inside any such ancestor,
// regardless of where it's opened from. The card itself is now a fixed-height flex column with a
// sticky header (title + close button always reachable, never scrolled away) and a separately
// scrolling body, and body scroll is locked while open and restored on close/unmount so the page
// behind it can't scroll along with it.
export const GrimoireModal = ({ open, onClose }: GrimoireModalProps) => {
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="grimoire-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="grimoire-card-shell" role="dialog" aria-modal="true" aria-labelledby="grimoire-title">
        <header className="grimoire-card-header">
          <div className="min-w-0">
            <p className="eyebrow">📜 คัมภีร์มนตรา</p>
            <h2 id="grimoire-title" className="grimoire-title">คัมภีร์มนตรา</h2>
            <p className="grimoire-subtitle">รู้จักพลัง ก่อนเลือกใช้</p>
          </div>
          <button type="button" className="grimoire-close-button" aria-label="ปิดคัมภีร์มนตรา" onClick={onClose}>✕</button>
        </header>

        <div className="grimoire-card-body">
          {/* Desktop: 2x2 grid. Tablet/mobile: collapses to 1 (narrow) or 2 compact columns via
              the same auto-fit/minmax pattern already used for .team-magic-grid. */}
          <div className="grimoire-grid">
            {MAGIC_ITEM_TYPES.map((itemType) => (
              <GrimoireCard key={itemType} itemType={itemType} />
            ))}
          </div>

          <div className="grimoire-summary">
            <p className="grimoire-summary-title">จำง่าย ๆ</p>
            <p>⚡ 🔒 🔮 = หัวหน้าทีมกดใช้ → มีผลกับคำถามข้อที่กำลังตอบอยู่ เพียง 1 ข้อ</p>
            <p>🛡️ = ไม่ต้องกด → ป้องกันมนตร์ผนึกคะแนนให้อัตโนมัติ 1 ครั้ง</p>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
