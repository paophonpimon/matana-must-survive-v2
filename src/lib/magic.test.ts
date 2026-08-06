import { describe, expect, it } from 'vitest'
import { buildTeamMetas } from './teamScoring'
import { computeTeamCompetitionStats, getMagicActivationWindow, isEligibleQuestionIndex, pickHolders } from './magic'
import type { MagicEvent, Player } from '../types/game'

const makePlayer = (overrides: Partial<Player> & { id: string }): Player => ({
  displayName: overrides.id,
  studentNumber: overrides.id,
  teamId: null,
  joinedAt: 0,
  currentRound: 1,
  currentQuestionIndex: 0,
  score: 0,
  answers: [],
  submitted: false,
  finishedAt: null,
  elapsedMs: null,
  status: 'waiting',
  ownerUid: `owner-${overrides.id}`,
  ...overrides,
})

const answer = (questionId: string, isCorrect: boolean): Player['answers'][number] => ({
  questionId,
  selectedChoiceId: isCorrect ? 'correct' : 'wrong',
  isCorrect,
  answeredAt: 1_000,
  responseTimeMs: 500,
})

const makeEvent = (overrides: Partial<MagicEvent> & { id: string }): MagicEvent => ({
  itemType: 'power_surge',
  actorPlayerId: 'actor',
  sourceTeamId: 'team-1',
  targetTeamId: 'team-1',
  affectedQuestionIndex: 1,
  status: 'applied',
  round: 1,
  createdAt: 0,
  resolvedAt: 0,
  ...overrides,
})

const questionIds = Array.from({ length: 10 }, (_, index) => `q${index}`)

describe('pickHolders', () => {
  it('selects exactly one holder per team, including uneven team sizes', () => {
    const holders = pickHolders({ 'team-1': ['a', 'b', 'c'], 'team-2': ['d', 'e'] }, () => 0.42)
    expect(Object.keys(holders)).toEqual(['team-1', 'team-2'])
    expect(['a', 'b', 'c']).toContain(holders['team-1'])
    expect(['d', 'e']).toContain(holders['team-2'])
  })

  it('skips a team with no members instead of throwing', () => {
    const holders = pickHolders({ 'team-1': [], 'team-2': ['a'] })
    expect(holders).toEqual({ 'team-2': 'a' })
  })
})

describe('isEligibleQuestionIndex', () => {
  it('rejects question 1 (index 0) and the final question, accepts everything between', () => {
    expect(isEligibleQuestionIndex(0, 10)).toBe(false)
    expect(isEligibleQuestionIndex(9, 10)).toBe(false)
    expect(isEligibleQuestionIndex(1, 10)).toBe(true)
    expect(isEligibleQuestionIndex(8, 10)).toBe(true)
  })
})

describe('getMagicActivationWindow', () => {
  const baseRoom = { currentQuestionIndex: 0, questionIds, questionStartedAt: 10_000, questionDurationSeconds: 30 }

  it('targets question 2 (index 1) from the waiting lobby', () => {
    expect(getMagicActivationWindow({ ...baseRoom, status: 'waiting' })).toEqual({ valid: true, affectedQuestionIndex: 1 })
  })

  it('targets currentQuestionIndex + 1 during the reveal window', () => {
    const room = { ...baseRoom, status: 'playing' as const, currentQuestionIndex: 3, questionStartedAt: 10_000 }
    // deadline = 10_000 + 30_000 = 40_000; reveal window is (40_000, 44_000]
    expect(getMagicActivationWindow(room, 41_000)).toEqual({ valid: true, affectedQuestionIndex: 4 })
  })

  it('rejects mid-question (timer still running)', () => {
    const room = { ...baseRoom, status: 'playing' as const, currentQuestionIndex: 3, questionStartedAt: 10_000 }
    expect(getMagicActivationWindow(room, 20_000)).toEqual({ valid: false, affectedQuestionIndex: null })
  })

  it('rejects when the reveal window would target the final question (question 10)', () => {
    // currentQuestionIndex 8 (question 9) -> next would be index 9 (question 10), disallowed
    const room = { ...baseRoom, status: 'playing' as const, currentQuestionIndex: 8, questionStartedAt: 10_000 }
    expect(getMagicActivationWindow(room, 41_000)).toEqual({ valid: false, affectedQuestionIndex: 9 })
  })

  it('rejects once the room is completed or closed', () => {
    expect(getMagicActivationWindow({ ...baseRoom, status: 'completed' })).toEqual({ valid: false, affectedQuestionIndex: null })
    expect(getMagicActivationWindow({ ...baseRoom, status: 'closed' })).toEqual({ valid: false, affectedQuestionIndex: null })
  })
})

describe('computeTeamCompetitionStats', () => {
  const teams = buildTeamMetas(2)

  it('matches raw scoring when no events have applied', () => {
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q0', true), answer('q1', true)] }),
      makePlayer({ id: 'b', teamId: 'team-2', answers: [answer('q0', true), answer('q1', false)] }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, [], 1)
    expect(stats.find((s) => s.id === 'team-1')).toMatchObject({ rawTotal: 2, competitionTotal: 2 })
    expect(stats.find((s) => s.id === 'team-2')).toMatchObject({ rawTotal: 1, competitionTotal: 1 })
  })

  it('applies a 150% own-team multiplier only to the applied question', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true), answer('q2', true)] })]
    const events = [makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' })]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    // q1 (index 1) correct -> 1 * 1.5 = 1.5; q2 (index 2) correct, no multiplier -> 1
    expect(stats.find((s) => s.id === 'team-1')?.competitionTotal).toBeCloseTo(2.5)
    expect(stats.find((s) => s.id === 'team-1')?.rawTotal).toBe(2)
  })

  it('applies a 50% hostile multiplier only to the target team and only the applied question', () => {
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true)] }),
      makePlayer({ id: 'b', teamId: 'team-2', answers: [answer('q1', true)] }),
    ]
    const events = [makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-1', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'applied' })]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(stats.find((s) => s.id === 'team-1')?.competitionTotal).toBe(1)
    expect(stats.find((s) => s.id === 'team-2')?.competitionTotal).toBeCloseTo(0.5)
  })

  it('a blocked hostile effect contributes no reduction at all (full raw points kept)', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-2', answers: [answer('q1', true)] })]
    const events = [makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-1', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'blocked' })]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(stats.find((s) => s.id === 'team-2')?.competitionTotal).toBe(1)
  })

  it('combines an own buff and an incoming hostile debuff on the same team/question in the documented order (own first, then hostile: x0.75)', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true)] })]
    const events = [
      makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' }),
      makeEvent({ id: 'e2', itemType: 'score_seal', sourceTeamId: 'team-2', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    // 1 * 1.5 * 0.5 = 0.75
    expect(stats.find((s) => s.id === 'team-1')?.competitionTotal).toBeCloseTo(0.75)
  })

  it('is deterministic — identical inputs produce identical output every time', () => {
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true), answer('q2', false)] }),
      makePlayer({ id: 'b', teamId: 'team-2', answers: [answer('q1', false), answer('q2', true)] }),
    ]
    const events = [makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-1', targetTeamId: 'team-2', affectedQuestionIndex: 2, status: 'applied' })]
    const first = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    const second = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(first).toEqual(second)
  })

  it('never reads or mutates player.score — raw individual scores stay Milestone 1\'s exclusively', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-1', score: 999, answers: [answer('q1', true)] })]
    const events = [makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' })]
    const before = JSON.stringify(players)
    computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(JSON.stringify(players)).toBe(before)
    expect(players[0].score).toBe(999)
  })

  it('an applied event from round 1 does not affect round 2\'s competition score, even with the same target/question-index key', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-1', currentRound: 2, answers: [answer('q1', true)] })]
    // Same targetTeamId:affectedQuestionIndex key as round 2 would use, but created in round 1.
    const events = [makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied', round: 1 })]
    const round1Stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    const round2Stats = computeTeamCompetitionStats(players, teams, questionIds, events, 2)
    expect(round1Stats.find((s) => s.id === 'team-1')?.competitionTotal).toBeCloseTo(1.5) // round 1: multiplier applies
    expect(round2Stats.find((s) => s.id === 'team-1')?.competitionTotal).toBe(1) // round 2: raw only, no leakage
  })
})
