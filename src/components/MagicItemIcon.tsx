import { MAGIC_ITEM_INFO } from '../lib/magic'
import type { MagicItemType } from '../types/game'

interface MagicItemIconProps {
  itemType: MagicItemType
  size?: 'sm' | 'md' | 'lg'
}

// Single shared render site for every per-item icon (power_surge/score_seal/rose_shield/
// illusion) — see MAGIC_ITEM_INFO's doc comment in lib/magic.ts for why this exists: the correct
// emoji already existed in the codebase, just scattered as hardcoded literals in a handful of
// one-off spots, so most generic list-rendering sites had nothing to render at all.
export const MagicItemIcon = ({ itemType, size = 'md' }: MagicItemIconProps) => (
  <span className={`magic-item-icon magic-item-icon-${size}`} aria-hidden="true">
    {MAGIC_ITEM_INFO[itemType].icon}
  </span>
)
