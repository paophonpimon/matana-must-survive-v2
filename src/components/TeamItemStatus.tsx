import { MagicItemIcon } from './MagicItemIcon'
import { MAGIC_ITEM_INFO, MAGIC_ITEM_TYPES } from '../lib/magic'
import type { MagicInventory, MagicItemType } from '../types/game'

interface TeamItemStatusProps {
  inventory: MagicInventory | undefined
  // The item type this team currently has queued/active, if any — read straight from the
  // existing TeamMagicState.queuedEffect by the caller. A queued item is still counted as
  // `available` (consumption only happens at resolution), so this just marks which of the
  // available chips is currently in play rather than introducing a separate state.
  activeItemType?: MagicItemType | null
  // An opponent's item currently taking effect ON this team (today only score_seal can target
  // another team). Derived by the caller from the existing magicEvents-backed incoming-effect
  // data — this component adds no state of its own. Rendered as a distinct hostile chip because
  // it is something being done TO the team, not something the team holds.
  incomingEffect?: { itemType: MagicItemType; count: number } | null
  className?: string
}

// Persistent team item strip, shown beside the team identity throughout Main, Boss and Result.
//
// Reads the EXISTING TeamMagicState.inventory directly — it deliberately keeps no history state of
// its own. The inventory already tracks `available` and `consumed` counts per item type for the
// whole round (both only reset on a new round), so "used items stay visible until the round ends"
// falls out of rendering `consumed` rather than from any new bookkeeping. Purely presentational:
// nothing here can alter magic behaviour.
export const TeamItemStatus = ({ inventory, activeItemType = null, incomingEffect = null, className = '' }: TeamItemStatusProps) => {
  const entries = inventory
    ? MAGIC_ITEM_TYPES.flatMap((itemType) => {
      const entry = inventory[itemType]
      if (!entry || (entry.available <= 0 && entry.consumed <= 0)) return []
      return [{ itemType, available: entry.available, consumed: entry.consumed }]
    })
    : []
  // A team with no items of its own can still be on the receiving end of one, so an incoming
  // effect alone is enough to render the strip.
  if (entries.length === 0 && !incomingEffect) return null

  return (
    <ul className={`team-item-status ${className}`.trim()} aria-label="ไอเทมของทีม">
      {entries.map(({ itemType, available, consumed }) => (
        <li key={itemType} className="team-item-status-group">
          {/* Available and consumed are rendered as separate chips of the same item so a team
              holding two copies with one spent reads correctly, instead of collapsing to a
              single ambiguous icon. */}
          {available > 0 ? (
            <span
              className={`team-item-chip ${activeItemType === itemType ? 'team-item-chip-active' : ''}`.trim()}
              title={`${MAGIC_ITEM_INFO[itemType].label} · ใช้ได้ ${available}${activeItemType === itemType ? ' · กำลังมีผล' : ''}`}
            >
              <MagicItemIcon itemType={itemType} size="sm" />
              {available > 1 ? <b>×{available}</b> : null}
              {activeItemType === itemType ? <em>กำลังมีผล</em> : null}
            </span>
          ) : null}
          {consumed > 0 ? (
            <span className="team-item-chip team-item-chip-used" title={`${MAGIC_ITEM_INFO[itemType].label} · ใช้ไปแล้ว ${consumed}`}>
              <MagicItemIcon itemType={itemType} size="sm" />
              {consumed > 1 ? <b>×{consumed}</b> : null}
              <span className="sr-only">ใช้ไปแล้ว</span>
            </span>
          ) : null}
        </li>
      ))}
      {incomingEffect ? (
        <li className="team-item-status-group">
          <span
            className="team-item-chip team-item-chip-incoming"
            title={`${MAGIC_ITEM_INFO[incomingEffect.itemType].label} จากทีมอื่น · กำลังได้รับผล${incomingEffect.count > 1 ? ` ${incomingEffect.count} ครั้ง` : ''}`}
          >
            <MagicItemIcon itemType={incomingEffect.itemType} size="sm" />
            {incomingEffect.count > 1 ? <b>×{incomingEffect.count}</b> : null}
            <em>กำลังได้รับผล</em>
          </span>
        </li>
      ) : null}
    </ul>
  )
}
