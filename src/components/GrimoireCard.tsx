import type { ReactNode } from 'react'
import { MagicItemIcon } from './MagicItemIcon'
import { MAGIC_GRIMOIRE, MAGIC_ITEM_INFO } from '../lib/magic'
import type { MagicItemType } from '../types/game'

interface GrimoireCardProps {
  itemType: MagicItemType
  // Optional dedicated card-art slot for later — defaults to the shared MagicItemIcon so this
  // component never needs gameplay/item logic baked into whatever renders here. Swapping in a
  // real illustration later is just passing a different `art` node; nothing else on the card
  // (label/activation/timing/effect copy, all sourced from MAGIC_ITEM_INFO/MAGIC_GRIMOIRE) changes.
  art?: ReactNode
}

// One card per item in the "คัมภีร์มนตรา" (Magic Grimoire) reference modal — reuses
// MAGIC_ITEM_INFO (label/icon) and MAGIC_GRIMOIRE (activation/timing/effect/note) as the single
// sources of truth, so this never becomes a second, disconnected item-copy mapping.
export const GrimoireCard = ({ itemType, art }: GrimoireCardProps) => {
  const info = MAGIC_ITEM_INFO[itemType]
  const entry = MAGIC_GRIMOIRE[itemType]
  return (
    <article className={`grimoire-card grimoire-card-${itemType}`}>
      <div className="grimoire-card-art" aria-hidden="true">
        {art ?? <MagicItemIcon itemType={itemType} size="lg" />}
      </div>
      <h3 className="grimoire-card-title">{info.label}</h3>
      <dl className="grimoire-card-facts">
        <div>
          <dt>ใครกดใช้</dt>
          <dd>{entry.activation}</dd>
        </div>
        <div>
          <dt>เวลาที่มีผล</dt>
          <dd>{entry.timing}</dd>
        </div>
        <div>
          <dt>ผลที่เกิดขึ้น</dt>
          <dd>{entry.effect}</dd>
        </div>
      </dl>
      {entry.note ? <p className="grimoire-card-note">{entry.note}</p> : null}
    </article>
  )
}
