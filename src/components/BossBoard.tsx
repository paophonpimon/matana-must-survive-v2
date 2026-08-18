import { BOSS_QUESTION_COUNT } from '../types/game'
import type { Player, Room, TeamMeta } from '../types/game'

export interface BossBoardProps {
  room: Room
  players: Player[]
  teams: TeamMeta[]
  teamDisplayName: (teamId: string) => string
  teamTone: (teamId: string) => number
  remainingMs: number
  revealRemainingMs: number
  formatCountdown: (ms: number) => string
}

type BossTeamState = 'waiting' | 'answered' | 'correct' | 'wrong' | 'leading' | 'tied' | 'winner'

const STATE_LABEL: Record<BossTeamState, string> = {
  waiting: 'ยังไม่ตอบ',
  answered: 'ตอบแล้ว',
  correct: 'ตอบถูก',
  wrong: 'ตอบผิด',
  leading: 'กำลังนำ',
  tied: 'คะแนนเท่ากัน',
  winner: 'ผู้ชนะ',
}

// Teacher-facing board for the boss phase. Presentation only: every figure is derived from data
// already on screen (players' bossAnswers, room.bossQuestionIds/Index, room.bossWinner). No new
// field, no service call, no scoring or ranking rule.
//
// The one rule this screen must not break: correctness is NEVER shown while the answer window is
// open. This board is projected, so a live "team 3 got it right" would simply tell everyone the
// answer. Correct/wrong/leading/tied therefore appear only once the question has closed — before
// that, a team can only read as waiting or answered.
export const BossBoard = ({
  room,
  players,
  teams,
  teamDisplayName,
  teamTone,
  remainingMs,
  revealRemainingMs,
  formatCountdown,
}: BossBoardProps) => {
  const currentQuestionId = room.bossQuestionIds[room.bossQuestionIndex]
  const questionNumber = Math.min(room.bossQuestionIndex + 1, BOSS_QUESTION_COUNT)
  // Closed = the answer window is over. Correctness may be shown from here on, and only here on.
  const closed = remainingMs <= 0
  const finished = room.bossCompleted || room.bossAwaitingContinue
  const urgent = !closed && remainingMs <= 3_000

  const answeredCount = currentQuestionId
    ? players.filter((player) => player.bossAnswers.some((answer) => answer.questionId === currentQuestionId)).length
    : 0

  // Cumulative correct answers per team across the boss questions resolved so far. Read-only
  // aggregation of existing records — it decides nothing, it only labels a card.
  const perTeam = teams.map((team) => {
    const members = players.filter((player) => player.teamId === team.id)
    const answeredThis = members.filter((player) =>
      player.bossAnswers.some((answer) => answer.questionId === currentQuestionId)).length
    const correctThis = members.filter((player) =>
      player.bossAnswers.some((answer) => answer.questionId === currentQuestionId && answer.isCorrect)).length
    const correctTotal = members.reduce(
      (total, player) => total + player.bossAnswers.filter((answer) => answer.isCorrect).length,
      0,
    )
    return { team, memberCount: members.length, answeredThis, correctThis, correctTotal }
  })

  const bestTotal = perTeam.reduce((best, entry) => Math.max(best, entry.correctTotal), 0)
  const leaders = bestTotal > 0 ? perTeam.filter((entry) => entry.correctTotal === bestTotal) : []
  const winnerTeamId = finished ? room.bossWinner?.teamId ?? null : null

  const resolveState = (entry: typeof perTeam[number]): BossTeamState => {
    if (winnerTeamId && entry.team.id === winnerTeamId) return 'winner'
    // Before the window closes, correctness stays hidden — only participation is shown.
    if (!closed) return entry.answeredThis > 0 ? 'answered' : 'waiting'
    if (leaders.length > 1 && leaders.some((leader) => leader.team.id === entry.team.id)) return 'tied'
    if (leaders.length === 1 && leaders[0].team.id === entry.team.id) return 'leading'
    if (entry.correctThis > 0) return 'correct'
    return entry.answeredThis > 0 ? 'wrong' : 'waiting'
  }

  // One headline for the whole board, so the room reads the same conclusion at a glance.
  const outcome = (): string => {
    if (winnerTeamId) return `ทีม ${teamDisplayName(winnerTeamId)} ชนะศึกชิงมนตรา`
    if (!closed) return `ตอบแล้ว ${answeredCount}/${players.length} คน`
    if (leaders.length > 1) return `${leaders.length} ทีมคะแนนเท่ากัน`
    if (leaders.length === 1) return `ทีม ${teamDisplayName(leaders[0].team.id)} นำอยู่`
    return 'ยังไม่มีทีมใดตอบถูก'
  }

  return (
    <section className="boss-board" aria-label="ศึกชิงมนตรา">
      <div className="boss-board-aura" aria-hidden="true" />

      <header className="boss-board-hero">
        <span className="boss-board-live">● ช่วงพิเศษ</span>
        <h2 className="boss-board-title">ศึกชิงมนตรา</h2>
        <p className="boss-board-subtitle">3 ข้อพิเศษ • ชิงไอเท็ม • คะแนนพลิกเกมได้</p>
      </header>

      <div className="boss-board-strip">
        <div className="boss-board-stat">
          <small>ข้อที่</small>
          <strong>{questionNumber}<span>/{BOSS_QUESTION_COUNT}</span></strong>
        </div>
        <div className={`boss-board-timer ${urgent ? 'is-urgent' : ''} ${closed ? 'is-done' : ''}`}>
          <small>{revealRemainingMs > 0 ? 'ดูผลอีก' : closed ? 'สิ้นสุดเวลา' : 'เวลาคงเหลือ'}</small>
          <strong>{closed && revealRemainingMs <= 0 ? 'หมดเวลา' : formatCountdown(revealRemainingMs > 0 ? revealRemainingMs : remainingMs)}</strong>
        </div>
        <div className="boss-board-stat">
          <small>ตอบแล้ว</small>
          <strong>{answeredCount}<span>/{players.length}</span></strong>
        </div>
        <div className="boss-board-stat boss-board-reward">
          <small>รางวัล</small>
          <strong>ผู้ชนะได้ไอเทมเพิ่ม 1 ชิ้น</strong>
        </div>
      </div>

      <p className={`boss-board-outcome ${winnerTeamId ? 'is-winner' : ''}`} aria-live="polite">{outcome()}</p>

      <ul className="boss-board-teams">
        {perTeam.map((entry) => {
          const state = resolveState(entry)
          return (
            <li key={entry.team.id} className={`boss-team-card is-${state} team-tone-${teamTone(entry.team.id)}`}>
              <div className="boss-team-head">
                <i className="team-tone-dot" aria-hidden="true" />
                <strong>{teamDisplayName(entry.team.id)}</strong>
                <span className={`boss-team-chip is-${state}`}>{STATE_LABEL[state]}</span>
              </div>
              <div className="boss-team-meta">
                <span>ตอบแล้ว {entry.answeredThis}/{entry.memberCount}</span>
                {/* Correct counts appear only after the window closes — see the note above. */}
                {closed ? <span>ถูกข้อนี้ {entry.correctThis}</span> : null}
                {closed ? <span>รวมถูก {entry.correctTotal}</span> : null}
              </div>
            </li>
          )
        })}
        {perTeam.length === 0 ? <li className="boss-board-empty">ยังไม่มีทีม</li> : null}
      </ul>
    </section>
  )
}
