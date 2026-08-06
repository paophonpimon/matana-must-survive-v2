import { shuffle } from './game'
import { MAGIC_ITEM_TYPES } from './magic'
import { BOSS_QUESTION_COUNT } from '../types/game'
import type { BossAnswerRecord, MagicItemType, Player, Question } from '../types/game'

// Milestone 4: players whose total boss time differs by no more than this from the best time
// within the same correct-count group form a "near tie" pool — the winner is drawn uniformly at
// random from that pool, not just handed to whoever happened to be a few milliseconds faster.
export const BOSS_TIE_POOL_THRESHOLD_MS = 500

// Picks exactly BOSS_QUESTION_COUNT distinct questions, excluding whatever the main round
// already used this round (so the boss stage never repeats a question the student just saw).
// The bank has 25 questions and a round only uses 10, so the excluded pool is never exhausted
// in practice; if it somehow were, this simply returns fewer than BOSS_QUESTION_COUNT ids rather
// than throwing — callers should treat a short result as a data problem, not crash mid-round.
export const selectBossQuestions = (
  bank: Question[],
  excludeQuestionIds: string[],
  random: () => number = Math.random,
): string[] => {
  const excluded = new Set(excludeQuestionIds)
  const pool = bank.filter((question) => !excluded.has(question.id))
  return shuffle(pool, random).slice(0, BOSS_QUESTION_COUNT).map((question) => question.id)
}

export const pickRandomMagicItem = (random: () => number = Math.random): MagicItemType =>
  MAGIC_ITEM_TYPES[Math.floor(random() * MAGIC_ITEM_TYPES.length)]

export interface BossRankingEntry {
  playerId: string
  teamId: string | null
  displayName: string
  studentNumber: string
  correctCount: number
  totalTimeMs: number
}

export interface BossRankingResult {
  ranking: BossRankingEntry[]
  winner: BossRankingEntry | null
  // The pool of players the winner was randomly drawn from — exposed mainly for testing/audit
  // transparency, not required by the UI.
  tiePoolPlayerIds: string[]
}

type BossRankablePlayer = Pick<Player, 'id' | 'teamId' | 'displayName' | 'studentNumber' | 'bossAnswers'>

const computeBossTotals = (
  player: BossRankablePlayer,
  bossQuestionIds: string[],
  bossQuestionDurationSeconds: number,
): BossRankingEntry => {
  const penaltyMs = bossQuestionDurationSeconds * 1_000
  let correctCount = 0
  let totalTimeMs = 0
  for (const questionId of bossQuestionIds) {
    const answer = player.bossAnswers.find((entry: BossAnswerRecord) => entry.questionId === questionId)
    if (!answer || !answer.isCorrect) {
      // Unanswered or incorrect: the full boss-question duration counts as a time penalty,
      // regardless of how much of that time was actually used.
      totalTimeMs += penaltyMs
      continue
    }
    correctCount += 1
    // Elapsed time comes from the stored answer/question-start timestamps (responseTimeMs is
    // computed server-side at save time, the same way main-question responseTimeMs already is)
    // — clamped to the valid duration so a clock-skew edge case can never credit a player with
    // "negative" or impossibly-long time.
    totalTimeMs += Math.min(Math.max(answer.responseTimeMs, 0), penaltyMs)
  }
  return {
    playerId: player.id,
    teamId: player.teamId,
    displayName: player.displayName,
    studentNumber: player.studentNumber,
    correctCount,
    totalTimeMs,
  }
}

// Ranking: 1) most correct out of 3, 2) lowest total time. Players within
// BOSS_TIE_POOL_THRESHOLD_MS of the best time, WITHIN the same top correct-count group, form a
// tie pool; the winner is drawn uniformly at random from that pool (a pool of exactly one still
// "wins" trivially). Callers are responsible for persisting the result — calling this twice with
// the same random() state is only for tests; production code must call it exactly once per round
// (inside the atomic resolution transaction) and never again once bossCompleted is true.
export const computeBossRanking = (
  players: BossRankablePlayer[],
  bossQuestionIds: string[],
  bossQuestionDurationSeconds: number,
  random: () => number = Math.random,
): BossRankingResult => {
  const entries = players.map((player) => computeBossTotals(player, bossQuestionIds, bossQuestionDurationSeconds))
  const ranking = [...entries].sort((a, b) =>
    b.correctCount - a.correctCount || a.totalTimeMs - b.totalTimeMs || a.playerId.localeCompare(b.playerId),
  )
  if (ranking.length === 0) return { ranking: [], winner: null, tiePoolPlayerIds: [] }
  const best = ranking[0]
  const tiePool = ranking.filter(
    (entry) => entry.correctCount === best.correctCount && Math.abs(entry.totalTimeMs - best.totalTimeMs) <= BOSS_TIE_POOL_THRESHOLD_MS,
  )
  const winner = tiePool[Math.floor(random() * tiePool.length)] ?? best
  return { ranking, winner, tiePoolPlayerIds: tiePool.map((entry) => entry.playerId) }
}
