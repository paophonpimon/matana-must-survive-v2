import { MagicItemIcon } from './MagicItemIcon'
import { MAGIC_GRIMOIRE, MAGIC_ITEM_INFO } from '../lib/magic'
import type { BossWinner } from '../types/game'

interface BossResultDetailsProps {
  winner: BossWinner
  guardianTeamName: string
}

// Item 6 follow-up: shared by GamePage (student) and TeacherPage (teacher) for the
// "ศึกด่านชิงมนตราจบแล้ว" result screen both show while room.bossAwaitingContinue is true —
// same winner/team/stats/reward content either way, just wrapped by each page's own
// header/CTA (student: "รอครูกด เล่นต่อ"; teacher: a prominent "เล่นต่อ" button), so the result
// data/markup itself lives in exactly one place instead of two copies drifting apart.
//
// No top-3 ranking here (per the task's own "if available" wording): BossWinner (types/game.ts)
// only ever persists the single winner, never a ranking/tie-pool, so there is no already-available
// top-3 data to surface without adding new persistence — out of scope for this pass, which only
// changes how the (already-persisted) winner is presented.
export const BossResultDetails = ({ winner, guardianTeamName }: BossResultDetailsProps) => (
  <>
    <p className="boss-result-winner-name">{winner.displayName}</p>
    <p className="boss-result-team">
      {guardianTeamName}
      {winner.teamName && winner.teamName !== guardianTeamName ? <span className="boss-result-team-tag"> ({winner.teamName})</span> : null}
    </p>
    <dl className="boss-result-stats">
      <div><dt>ตอบถูก</dt><dd>{winner.correctCount}/3</dd></div>
      <div><dt>เวลารวม</dt><dd>{(winner.totalTimeMs / 1_000).toFixed(2)} วิ</dd></div>
    </dl>
    <div className="boss-result-reward">
      <MagicItemIcon itemType={winner.rewardItemType} size="lg" />
      <div>
        <small>รางวัลที่ได้รับ</small>
        <strong>{MAGIC_ITEM_INFO[winner.rewardItemType].label} +1</strong>
        <p className="boss-result-reward-effect">{MAGIC_GRIMOIRE[winner.rewardItemType].effect}</p>
      </div>
    </div>
  </>
)
