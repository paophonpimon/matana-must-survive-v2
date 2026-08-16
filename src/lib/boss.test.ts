import { describe, expect, it } from 'vitest'
import { BOSS_REVEAL_MILLISECONDS, BOSS_TIE_POOL_THRESHOLD_MS, computeBossRanking, pickRandomMagicItem, selectBossQuestions } from './boss'
import { bossQuestions } from '../data/bossQuestions'
import { BOSS_QUESTION_COUNT } from '../types/game'
import type { BossAnswerRecord, Question } from '../types/game'

const makeQuestion = (id: string): Question => ({
  id,
  category: 'basic',
  question: `question ${id}`,
  choices: [
    { id: 'a', text: 'a' },
    { id: 'b', text: 'b' },
  ],
  correctChoiceId: 'a',
  explanation: '',
  difficulty: 'easy',
})

const makeBossAnswer = (questionId: string, isCorrect: boolean, responseTimeMs: number): BossAnswerRecord => ({
  questionId,
  selectedChoiceId: isCorrect ? 'a' : 'b',
  isCorrect,
  answeredAt: 1_000,
  responseTimeMs,
})

const BOSS_DURATION_SECONDS = 10
const BOSS_QUESTION_IDS = ['boss-q0', 'boss-q1', 'boss-q2']

// Puts the player's entire total time on question 0 (0ms on the rest, all correct) so the
// resulting totalTimeMs is exactly `totalTimeMs` — no compounding across BOSS_QUESTION_COUNT
// questions, which is what makes the tie-pool boundary tests exact rather than approximate.
const makePlayerWithTotalTime = (id: string, teamId: string, totalTimeMs: number) => ({
  id,
  teamId,
  displayName: id,
  studentNumber: id,
  bossAnswers: [
    makeBossAnswer(BOSS_QUESTION_IDS[0], true, totalTimeMs),
    makeBossAnswer(BOSS_QUESTION_IDS[1], true, 0),
    makeBossAnswer(BOSS_QUESTION_IDS[2], true, 0),
  ],
})

describe('selectBossQuestions', () => {
  it('uses the curated rapid-boss sequence in a stable binary -> rune -> swipe order', () => {
    const selected = selectBossQuestions(bossQuestions, [])
    expect(selected).toHaveLength(BOSS_QUESTION_COUNT)
    expect(selected).toEqual(['boss-rapid-01', 'boss-rapid-02', 'boss-rapid-03'])
    expect(bossQuestions.map((question) => question.bossInteraction?.kind)).toEqual(['binary', 'rune', 'swipe'])
  })

  it('still honors exclusions and returns fewer than BOSS_QUESTION_COUNT instead of throwing', () => {
    const bank = [makeQuestion('q0'), makeQuestion('q1')]
    const selected = selectBossQuestions(bank, ['q0'])
    expect(selected).toEqual(['q1'])
  })

  it('uses a short boss-only reveal beat so the whole mini-game stays brief', () => {
    expect(BOSS_REVEAL_MILLISECONDS).toBeLessThan(2_000)
  })
})

describe('pickRandomMagicItem', () => {
  it('always returns one of the four magic item types', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(['power_surge', 'score_seal', 'rose_shield', 'illusion']).toContain(pickRandomMagicItem(() => i / 20))
    }
  })
})

describe('computeBossRanking', () => {
  it('ranks accuracy (correct count) before speed', () => {
    const players = [
      { id: 'slow-but-perfect', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: BOSS_QUESTION_IDS.map((id) => makeBossAnswer(id, true, 9_000)) },
      { id: 'fast-but-one-wrong', teamId: 'team-2', displayName: 'B', studentNumber: '2', bossAnswers: [makeBossAnswer(BOSS_QUESTION_IDS[0], true, 100), makeBossAnswer(BOSS_QUESTION_IDS[1], true, 100), makeBossAnswer(BOSS_QUESTION_IDS[2], false, 100)] },
    ]
    const result = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(result.winner?.playerId).toBe('slow-but-perfect')
  })

  it('an incorrect or unanswered question adds the full boss-question duration as a time penalty', () => {
    const players = [
      { id: 'p1', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: [makeBossAnswer(BOSS_QUESTION_IDS[0], false, 500), makeBossAnswer(BOSS_QUESTION_IDS[1], true, 1_000)] },
    ]
    // q0 wrong -> 10_000ms penalty; q1 correct -> 1_000ms; q2 unanswered -> 10_000ms penalty.
    const result = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(result.ranking[0].correctCount).toBe(1)
    expect(result.ranking[0].totalTimeMs).toBe(10_000 + 1_000 + 10_000)
  })

  it('clamps an out-of-range responseTimeMs to the valid [0, duration] range', () => {
    const players = [
      { id: 'p1', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: [makeBossAnswer(BOSS_QUESTION_IDS[0], true, -50), makeBossAnswer(BOSS_QUESTION_IDS[1], true, 50_000)] },
    ]
    const result = computeBossRanking(players, BOSS_QUESTION_IDS.slice(0, 2), BOSS_DURATION_SECONDS)
    // -50 clamps to 0, 50_000 clamps to 10_000 (the boss question duration in ms).
    expect(result.ranking[0].totalTimeMs).toBe(0 + 10_000)
  })

  it('players within 0.5s of the best TOTAL time (same correct count) form a tie pool; the winner is drawn from it', () => {
    const players = [
      makePlayerWithTotalTime('best', 'team-1', 5_000),
      makePlayerWithTotalTime('near-tie', 'team-2', 5_000 + BOSS_TIE_POOL_THRESHOLD_MS),
      makePlayerWithTotalTime('too-slow', 'team-3', 5_000 + BOSS_TIE_POOL_THRESHOLD_MS + 1),
    ]
    const result = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(result.tiePoolPlayerIds.sort()).toEqual(['best', 'near-tie'])
    expect(['best', 'near-tie']).toContain(result.winner?.playerId)
  })

  it('a total-time difference of exactly 500ms (the threshold) is included in the tie pool', () => {
    const players = [
      makePlayerWithTotalTime('best', 'team-1', 5_000),
      makePlayerWithTotalTime('at-boundary', 'team-2', 5_000 + 500),
    ]
    expect(BOSS_TIE_POOL_THRESHOLD_MS).toBe(500)
    const result = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(result.tiePoolPlayerIds.sort()).toEqual(['at-boundary', 'best'])
  })

  it('a total-time difference of 501ms (one past the threshold) is excluded from the tie pool', () => {
    const players = [
      makePlayerWithTotalTime('best', 'team-1', 5_000),
      makePlayerWithTotalTime('just-outside', 'team-2', 5_000 + 501),
    ]
    const result = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(result.tiePoolPlayerIds).toEqual(['best'])
    expect(result.winner?.playerId).toBe('best')
  })

  it('the winner draw is deterministic given the same random() sequence — reproducible, not rerollable', () => {
    const players = [
      { id: 'best', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: BOSS_QUESTION_IDS.map((id) => makeBossAnswer(id, true, 5_000)) },
      { id: 'near-tie', teamId: 'team-2', displayName: 'B', studentNumber: '2', bossAnswers: BOSS_QUESTION_IDS.map((id) => makeBossAnswer(id, true, 5_000)) },
    ]
    const first = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS, () => 0.9)
    const second = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS, () => 0.9)
    expect(first.winner?.playerId).toBe(second.winner?.playerId)
  })

  it('a pool of exactly one player still "wins" trivially', () => {
    const players = [
      { id: 'solo', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: BOSS_QUESTION_IDS.map((id) => makeBossAnswer(id, true, 1_000)) },
    ]
    const result = computeBossRanking(players, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(result.winner?.playerId).toBe('solo')
  })

  it('returns a null winner and empty ranking for an empty player list', () => {
    const result = computeBossRanking([], BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(result.winner).toBeNull()
    expect(result.ranking).toEqual([])
  })

  // Regression: the sort always puts SOMEONE first, so with nobody correct the fastest wrong
  // answer (or just the lowest playerId) used to be crowned and handed a random item for
  // achieving nothing. A reward now requires at least one correct boss answer.
  it('has no winner and no tie pool when nobody answers a single boss question correctly', () => {
    const allWrong = [
      { id: 'p1', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: BOSS_QUESTION_IDS.map((id) => makeBossAnswer(id, false, 200)) },
      { id: 'p2', teamId: 'team-2', displayName: 'B', studentNumber: '2', bossAnswers: BOSS_QUESTION_IDS.map((id) => makeBossAnswer(id, false, 5_000)) },
    ]
    const wrongResult = computeBossRanking(allWrong, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS)
    expect(wrongResult.winner).toBeNull()
    expect(wrongResult.tiePoolPlayerIds).toEqual([])
    // The ranking itself is still produced so the round can complete and be displayed.
    expect(wrongResult.ranking).toHaveLength(2)

    // Same outcome when everyone simply leaves all three unanswered...
    const allUnanswered = [
      { id: 'p1', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: [] },
      { id: 'p2', teamId: 'team-2', displayName: 'B', studentNumber: '2', bossAnswers: [] },
    ]
    expect(computeBossRanking(allUnanswered, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS).winner).toBeNull()

    // ...and for a mixture of unanswered and wrong, where still nobody is correct.
    const mixed = [
      { id: 'p1', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: [makeBossAnswer(BOSS_QUESTION_IDS[0], false, 300)] },
      { id: 'p2', teamId: 'team-2', displayName: 'B', studentNumber: '2', bossAnswers: [] },
    ]
    expect(computeBossRanking(mixed, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS).winner).toBeNull()

    // A single correct answer anywhere restores the normal winner/reward path.
    const oneCorrect = [
      { id: 'p1', teamId: 'team-1', displayName: 'A', studentNumber: '1', bossAnswers: [makeBossAnswer(BOSS_QUESTION_IDS[0], false, 300)] },
      { id: 'p2', teamId: 'team-2', displayName: 'B', studentNumber: '2', bossAnswers: [makeBossAnswer(BOSS_QUESTION_IDS[0], true, 300)] },
    ]
    expect(computeBossRanking(oneCorrect, BOSS_QUESTION_IDS, BOSS_DURATION_SECONDS).winner?.playerId).toBe('p2')
  })
})
