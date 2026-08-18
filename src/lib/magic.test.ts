import { describe, expect, it } from 'vitest'
import { buildTeamMetas } from './teamScoring'
import {
  computeHostileMultiplier,
  computeTeamCompetitionStats,
  computeTeamQuestionBreakdown,
  getMagicActivationWindow,
  isEligibleQuestionIndex,
  pickElectedCaptain,
  pickIllusionHiddenChoice,
} from './magic'
import type { MagicEvent, Player, Question } from '../types/game'

const makePlayer = (overrides: Partial<Player> & { id: string }): Player => ({
  displayName: overrides.id,
  studentNumber: overrides.id,
  teamId: null,
  joinedAt: 0,
  currentRound: 1,
  currentQuestionIndex: 0,
  score: 0,
  answers: [],
  bossAnswers: [],
  recallAnswers: [],
  preTestAnswers: [],
  postTestAnswers: [],
  surveyResponses: [],
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

// Milestone 4.1: team captain election — replaces the old random pickHolders.
describe('pickElectedCaptain', () => {
  it('the highest vote count wins outright', () => {
    const captainId = pickElectedCaptain(
      ['a', 'b', 'c'],
      { voter1: 'b', voter2: 'b', voter3: 'a' },
    )
    expect(captainId).toBe('b')
  })

  it('self-voting is allowed and counts like any other vote', () => {
    const captainId = pickElectedCaptain(['a', 'b'], { a: 'a', b: 'a' })
    expect(captainId).toBe('a')
  })

  it('a tie among the top candidates is broken by a uniform random draw, not array order', () => {
    // a and b are tied at 1 vote each, c has 0 — the draw must be confined to {a, b}.
    const votes = { voter1: 'a', voter2: 'b' }
    for (let i = 0; i < 10; i += 1) {
      const captainId = pickElectedCaptain(['a', 'b', 'c'], votes, () => i / 10)
      expect(['a', 'b']).toContain(captainId)
    }
  })

  it('the tie-break draw is deterministic given the same random() sequence — reproducible, not rerollable', () => {
    const votes = { voter1: 'a', voter2: 'b' }
    const first = pickElectedCaptain(['a', 'b'], votes, () => 0.9)
    const second = pickElectedCaptain(['a', 'b'], votes, () => 0.9)
    expect(first).toBe(second)
  })

  it('falls back to a uniform random draw across the WHOLE roster when no votes were cast at all', () => {
    // Every member tallies 0, so every member is "tied for highest" — the team can never get
    // permanently stuck with no captain even if the teacher force-finalizes before any votes.
    const captainId = pickElectedCaptain(['a', 'b', 'c'], {})
    expect(['a', 'b', 'c']).toContain(captainId)
  })

  it('a vote for a target no longer on the roster is silently ignored rather than crashing', () => {
    const captainId = pickElectedCaptain(['a', 'b'], { voter1: 'stale-id', voter2: 'a' })
    expect(captainId).toBe('a')
  })

  it('returns null for an empty roster', () => {
    expect(pickElectedCaptain([], {})).toBeNull()
  })
})

// Milestone 4.1: illusion's hidden-choice selection — must never pick the correct choice.
describe('pickIllusionHiddenChoice', () => {
  const question: Pick<Question, 'choices' | 'correctChoiceId'> = {
    choices: [
      { id: 'a', text: 'a' },
      { id: 'b', text: 'b' },
      { id: 'c', text: 'c' },
      { id: 'd', text: 'd' },
    ],
    correctChoiceId: 'b',
  }

  it('never returns the correct choice, across every possible draw', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(pickIllusionHiddenChoice(question, () => i / 10)).not.toBe('b')
    }
  })

  it('always returns one of the incorrect choices', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(['a', 'c', 'd']).toContain(pickIllusionHiddenChoice(question, () => i / 10))
    }
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
  const baseRoom = { currentQuestionIndex: 0, questionIds }

  // Milestone 2.2: activation is no longer available from the waiting lobby at all — choosing a
  // starting item there only stores it. Activation is a `status === 'playing'` concept, valid
  // for the WHOLE lifecycle of the current question (answering or reveal), not time-gated.
  it('is never valid from the waiting lobby, regardless of which question would be next', () => {
    expect(getMagicActivationWindow({ ...baseRoom, status: 'waiting' })).toEqual({ valid: false, affectedQuestionIndex: null })
  })

  it('targets currentQuestionIndex + 1 while playing question 1 (its own reveal doesn\'t matter — always eligible if playing)', () => {
    const room = { ...baseRoom, status: 'playing' as const, currentQuestionIndex: 0 }
    expect(getMagicActivationWindow(room)).toEqual({ valid: true, affectedQuestionIndex: 1 })
  })

  it('targets currentQuestionIndex + 1 while playing question 4 (index 3) -> affects question 5 (index 4)', () => {
    const room = { ...baseRoom, status: 'playing' as const, currentQuestionIndex: 3 }
    expect(getMagicActivationWindow(room)).toEqual({ valid: true, affectedQuestionIndex: 4 })
  })

  it('is disabled once no eligible future question remains (currently on question 9, next would be the final question 10)', () => {
    const room = { ...baseRoom, status: 'playing' as const, currentQuestionIndex: 8 }
    expect(getMagicActivationWindow(room)).toEqual({ valid: false, affectedQuestionIndex: 9 })
  })

  it('is disabled while playing the final question itself', () => {
    const room = { ...baseRoom, status: 'playing' as const, currentQuestionIndex: 9 }
    expect(getMagicActivationWindow(room)).toEqual({ valid: false, affectedQuestionIndex: 10 })
  })

  it('rejects once the room is completed or closed', () => {
    expect(getMagicActivationWindow({ ...baseRoom, status: 'completed' })).toEqual({ valid: false, affectedQuestionIndex: null })
    expect(getMagicActivationWindow({ ...baseRoom, status: 'closed' })).toEqual({ valid: false, affectedQuestionIndex: null })
  })
})

describe('computeHostileMultiplier', () => {
  it('stacks multiplicatively: 0 seals = x1, 1 = x0.5, 2 = x0.25, 3 = x0.125', () => {
    expect(computeHostileMultiplier(0)).toBe(1)
    expect(computeHostileMultiplier(1)).toBe(0.5)
    expect(computeHostileMultiplier(2)).toBe(0.25)
    expect(computeHostileMultiplier(3)).toBe(0.125)
  })
})

// Milestone 4: 100-point scale — each question contributes
// (correct locked-roster members / total locked-roster members) * 10 to a team's raw score, so a
// perfect team's rawTotal across 10 questions is exactly 100 regardless of team size, and an
// unanswered locked member counts toward the denominator (0 toward the numerator) rather than
// being excluded.
describe('computeTeamCompetitionStats — 100-point score scale', () => {
  const teams = buildTeamMetas(2)

  it('unequal team sizes receive equal raw score when their correct-answer percentage is equal', () => {
    // team-1: 2 members, 1 correct on q0 (50%). team-2: 4 members, 2 correct on q0 (50%).
    const players = [
      makePlayer({ id: 'a1', teamId: 'team-1', answers: [answer('q0', true)] }),
      makePlayer({ id: 'a2', teamId: 'team-1', answers: [answer('q0', false)] }),
      makePlayer({ id: 'b1', teamId: 'team-2', answers: [answer('q0', true)] }),
      makePlayer({ id: 'b2', teamId: 'team-2', answers: [answer('q0', true)] }),
      makePlayer({ id: 'b3', teamId: 'team-2', answers: [answer('q0', false)] }),
      makePlayer({ id: 'b4', teamId: 'team-2', answers: [answer('q0', false)] }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, [], 1)
    expect(stats.find((s) => s.id === 'team-1')?.rawTotal).toBe(5)
    expect(stats.find((s) => s.id === 'team-2')?.rawTotal).toBe(5)
  })

  it('an unanswered locked-roster member counts as zero toward the numerator but still counts toward the denominator', () => {
    // 2 members, only one ever answers q0 (correctly) — the never-answered member is still part
    // of the roster, so the question score is (1/2)*10 = 5, never (1/1)*10 = 10.
    const players = [
      makePlayer({ id: 'a1', teamId: 'team-1', answers: [answer('q0', true)] }),
      makePlayer({ id: 'a2', teamId: 'team-1', answers: [] }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, [], 1)
    expect(stats.find((s) => s.id === 'team-1')?.rawTotal).toBe(5)
  })

  it('perfect teams of different sizes both receive exactly 100', () => {
    const allCorrect = questionIds.map((questionId) => answer(questionId, true))
    const players = [
      makePlayer({ id: 'a1', teamId: 'team-1', answers: allCorrect }),
      makePlayer({ id: 'a2', teamId: 'team-1', answers: allCorrect }),
      makePlayer({ id: 'b1', teamId: 'team-2', answers: allCorrect }),
      makePlayer({ id: 'b2', teamId: 'team-2', answers: allCorrect }),
      makePlayer({ id: 'b3', teamId: 'team-2', answers: allCorrect }),
      makePlayer({ id: 'b4', teamId: 'team-2', answers: allCorrect }),
      makePlayer({ id: 'b5', teamId: 'team-2', answers: allCorrect }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, [], 1)
    expect(stats.find((s) => s.id === 'team-1')?.rawTotal).toBe(100)
    expect(stats.find((s) => s.id === 'team-2')?.rawTotal).toBe(100)
  })

  it('matches raw scoring when no events have applied', () => {
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q0', true), answer('q1', true)] }),
      makePlayer({ id: 'b', teamId: 'team-2', answers: [answer('q0', true), answer('q1', false)] }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, [], 1)
    expect(stats.find((s) => s.id === 'team-1')).toMatchObject({ rawTotal: 20, competitionTotal: 20 })
    expect(stats.find((s) => s.id === 'team-2')).toMatchObject({ rawTotal: 10, competitionTotal: 10 })
  })

  it('power surge applies a x2 own-team multiplier only to the affected question', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true), answer('q2', true)] })]
    const events = [makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' })]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    // q1 (index 1) correct -> 10 * 2 = 20; q2 (index 2) correct, no multiplier -> 10
    expect(stats.find((s) => s.id === 'team-1')?.competitionTotal).toBeCloseTo(30)
    expect(stats.find((s) => s.id === 'team-1')?.rawTotal).toBe(20)
  })

  it('a single score_seal applies a x0.5 hostile multiplier only to the target team and only the affected question', () => {
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true)] }),
      makePlayer({ id: 'b', teamId: 'team-2', answers: [answer('q1', true)] }),
    ]
    const events = [makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-1', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'applied' })]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(stats.find((s) => s.id === 'team-1')?.competitionTotal).toBe(10)
    expect(stats.find((s) => s.id === 'team-2')?.competitionTotal).toBeCloseTo(5)
  })

  it('multiple seals from different teams stack multiplicatively (x0.25 for two applied seals)', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-2', answers: [answer('q1', true)] })]
    const events = [
      makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-1', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'applied' }),
      makeEvent({ id: 'e2', itemType: 'score_seal', sourceTeamId: 'team-3', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'applied' }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(stats.find((s) => s.id === 'team-2')?.competitionTotal).toBeCloseTo(2.5)
  })

  it('a blocked hostile effect contributes no reduction at all (full raw points kept)', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-2', answers: [answer('q1', true)] })]
    const events = [makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-1', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'blocked' })]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(stats.find((s) => s.id === 'team-2')?.competitionTotal).toBe(10)
  })

  it('with one shield against two incoming seals, exactly one is blocked and one still applies (x0.5, not x0.25)', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-2', answers: [answer('q1', true)] })]
    const events = [
      makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-1', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'blocked' }),
      makeEvent({ id: 'e2', itemType: 'score_seal', sourceTeamId: 'team-3', targetTeamId: 'team-2', affectedQuestionIndex: 1, status: 'applied' }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    expect(stats.find((s) => s.id === 'team-2')?.competitionTotal).toBeCloseTo(5)
  })

  it('combines an own buff and an incoming hostile debuff on the same team/question in the documented order (own x2 first, then hostile x0.5 = x1 net)', () => {
    const players = [makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true)] })]
    const events = [
      makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' }),
      makeEvent({ id: 'e2', itemType: 'score_seal', sourceTeamId: 'team-2', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' }),
    ]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    // 10 * 2 * 0.5 = 10
    expect(stats.find((s) => s.id === 'team-1')?.competitionTotal).toBeCloseTo(10)
  })

  it('competition score is never capped at 100 even when it exceeds it', () => {
    const allCorrect = questionIds.map((questionId) => answer(questionId, true))
    const players = [makePlayer({ id: 'a', teamId: 'team-1', answers: allCorrect })]
    const events = [makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' })]
    const stats = computeTeamCompetitionStats(players, teams, questionIds, events, 1)
    // rawTotal 100, one question doubled: 100 + 10 (the extra x1 from the doubled question) = 110
    expect(stats.find((s) => s.id === 'team-1')?.competitionTotal).toBe(110)
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
    expect(round1Stats.find((s) => s.id === 'team-1')?.competitionTotal).toBeCloseTo(20) // round 1: multiplier applies
    expect(round2Stats.find((s) => s.id === 'team-1')?.competitionTotal).toBe(10) // round 2: raw only, no leakage
  })
})

// Milestone 4 section 3: "score breakdown matches resolved competition score" — the persisted,
// per-question breakdown (what students see after reveal) must always agree with the bulk
// leaderboard computation for the same question, never drift from it.
describe('computeTeamQuestionBreakdown', () => {
  const teams = buildTeamMetas(2)
  const team1 = teams[0]

  it('breakdown fields multiply out to exactly the persisted competitionScore', () => {
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true)] }),
      makePlayer({ id: 'b', teamId: 'team-1', answers: [answer('q1', false)] }),
    ]
    const events = [
      makeEvent({ id: 'e1', itemType: 'power_surge', sourceTeamId: 'team-1', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' }),
      makeEvent({ id: 'e2', itemType: 'score_seal', sourceTeamId: 'team-2', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' }),
      makeEvent({ id: 'e3', itemType: 'score_seal', sourceTeamId: 'team-3', targetTeamId: 'team-1', affectedQuestionIndex: 1, status: 'applied' }),
    ]
    const breakdown = computeTeamQuestionBreakdown(players, team1, 'q1', 1, events, 1)
    expect(breakdown.memberCount).toBe(2)
    expect(breakdown.correctCount).toBe(1)
    expect(breakdown.rawScore).toBe(5)
    expect(breakdown.ownMultiplier).toBe(2)
    expect(breakdown.sealCount).toBe(2)
    expect(breakdown.hostileMultiplier).toBe(0.25)
    expect(breakdown.competitionScore).toBeCloseTo(5 * 2 * 0.25)
  })

  it('matches computeTeamCompetitionStats\'s per-question contribution for the same inputs', () => {
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q0', true), answer('q1', true)] }),
      makePlayer({ id: 'b', teamId: 'team-2', answers: [answer('q0', false), answer('q1', true)] }),
    ]
    const events = [makeEvent({ id: 'e1', itemType: 'score_seal', sourceTeamId: 'team-2', targetTeamId: 'team-1', affectedQuestionIndex: 0, status: 'applied' })]
    const breakdown = computeTeamQuestionBreakdown(players, team1, 'q0', 0, events, 1)
    const bulkStats = computeTeamCompetitionStats(players, teams, ['q0'], events, 1)
    expect(breakdown.competitionScore).toBeCloseTo(bulkStats.find((s) => s.id === 'team-1')?.competitionTotal ?? -1)
  })
})
