import { describe, expect, it } from 'vitest'
import { buildTeamMetas, computeCurrentQuestionStats, computeTeamCurrentQuestionCounts, computeTeamStats, distributeTeamsEvenly } from './teamScoring'
import type { Player } from '../types/game'

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

describe('buildTeamMetas', () => {
  it('labels teams ทีม 1..N', () => {
    expect(buildTeamMetas(3)).toEqual([
      { id: 'team-1', name: 'ทีม 1' },
      { id: 'team-2', name: 'ทีม 2' },
      { id: 'team-3', name: 'ทีม 3' },
    ])
  })

  it('returns an empty list for zero teams', () => {
    expect(buildTeamMetas(0)).toEqual([])
  })
})

describe('distributeTeamsEvenly', () => {
  it('splits an uneven count so team sizes differ by at most one', () => {
    const playerIds = Array.from({ length: 7 }, (_, index) => `p${index}`)
    const assignment = distributeTeamsEvenly(playerIds, 3, () => 0.42)
    const counts = new Map<string, number>()
    for (const teamId of Object.values(assignment)) counts.set(teamId, (counts.get(teamId) ?? 0) + 1)
    const sizes = [...counts.values()].sort((a, b) => a - b)
    expect(sizes).toEqual([2, 2, 3])
    expect(Object.keys(assignment)).toHaveLength(7)
  })

  it('is deterministic for a given random function', () => {
    const playerIds = ['a', 'b', 'c', 'd']
    const first = distributeTeamsEvenly(playerIds, 2, () => 0.1)
    const second = distributeTeamsEvenly(playerIds, 2, () => 0.1)
    expect(first).toEqual(second)
  })

  it('returns no assignment when teamCount is zero', () => {
    expect(distributeTeamsEvenly(['a', 'b'], 0)).toEqual({})
  })
})

describe('computeTeamStats', () => {
  it('ranks by average score, not raw total, when team sizes differ', () => {
    const teams = buildTeamMetas(2)
    const small = [
      makePlayer({ id: 'a', teamId: 'team-1', score: 8, answers: [answer('q1', true)] }),
      makePlayer({ id: 'b', teamId: 'team-1', score: 8, answers: [answer('q1', true)] }),
    ]
    const large = [
      makePlayer({ id: 'c', teamId: 'team-2', score: 6, answers: [answer('q1', true)] }),
      makePlayer({ id: 'd', teamId: 'team-2', score: 6, answers: [answer('q1', true)] }),
      makePlayer({ id: 'e', teamId: 'team-2', score: 6, answers: [answer('q1', true)] }),
      makePlayer({ id: 'f', teamId: 'team-2', score: 5, answers: [] }),
      makePlayer({ id: 'g', teamId: 'team-2', score: 5, answers: [] }),
    ]
    const stats = computeTeamStats([...small, ...large], teams)

    // team-2's raw total (28) beats team-1's raw total (16), but team-1's average (8) beats
    // team-2's average (5.6), and average is what must win the ranking.
    expect(stats[0].id).toBe('team-1')
    expect(stats[0].averageScore).toBe(8)
    expect(stats[1].id).toBe('team-2')
    expect(stats[1].averageScore).toBeCloseTo(5.6)
  })

  it('counts an unsubmitted mid-game player in the denominator the same as a submitted one', () => {
    const teams = buildTeamMetas(1)
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', score: 10, submitted: true }),
      makePlayer({ id: 'b', teamId: 'team-1', score: 0, submitted: false }),
    ]
    const stats = computeTeamStats(players, teams)
    expect(stats[0].memberCount).toBe(2)
    expect(stats[0].averageScore).toBe(5)
    expect(stats[0].submittedCount).toBe(1)
  })

  it('reports zero average for a team with no assigned members', () => {
    const teams = buildTeamMetas(1)
    expect(computeTeamStats([], teams)[0]).toMatchObject({ memberCount: 0, averageScore: 0, totalScore: 0 })
  })

  it('sums correct answers across all members for correctCount', () => {
    const teams = buildTeamMetas(1)
    const players = [
      makePlayer({ id: 'a', teamId: 'team-1', answers: [answer('q1', true), answer('q2', false)] }),
      makePlayer({ id: 'b', teamId: 'team-1', answers: [answer('q1', true), answer('q2', true)] }),
    ]
    expect(computeTeamStats(players, teams)[0].correctCount).toBe(3)
  })
})

describe('computeCurrentQuestionStats', () => {
  it('counts only answers for the active question, separate from cumulative totals', () => {
    const players = [
      makePlayer({ id: 'a', answers: [answer('q1', true), answer('q2', false)] }),
      makePlayer({ id: 'b', answers: [answer('q1', false)] }),
      makePlayer({ id: 'c', answers: [] }),
    ]
    expect(computeCurrentQuestionStats(players, 'q1')).toEqual({ answeredCount: 2, correctCount: 1 })
    expect(computeCurrentQuestionStats(players, 'q2')).toEqual({ answeredCount: 1, correctCount: 0 })
  })

  it('returns zeroes when there is no active question', () => {
    expect(computeCurrentQuestionStats([], undefined)).toEqual({ answeredCount: 0, correctCount: 0 })
  })
})

describe('computeTeamCurrentQuestionCounts', () => {
  it('counts, per team, only members who answered the given question — distinct from full-game completion', () => {
    const teams = buildTeamMetas(2)
    const players = [
      // has answered q3 but not finished the game (not submitted)
      makePlayer({ id: 'a', teamId: 'team-1', submitted: false, answers: [answer('q3', true)] }),
      makePlayer({ id: 'b', teamId: 'team-1', submitted: false, answers: [] }),
      makePlayer({ id: 'c', teamId: 'team-2', submitted: true, answers: [answer('q3', false)] }),
    ]
    const counts = computeTeamCurrentQuestionCounts(players, teams, 'q3')
    expect(counts.get('team-1')).toBe(1)
    expect(counts.get('team-2')).toBe(1)

    // Confirm this is genuinely a different number than computeTeamStats's full-game
    // submittedCount for the same roster (team-1 has 0 finished, 1 answered-this-question).
    const stats = computeTeamStats(players, teams)
    expect(stats.find((team) => team.id === 'team-1')?.submittedCount).toBe(0)
  })

  it('returns zero for every team when there is no active question', () => {
    const teams = buildTeamMetas(2)
    const counts = computeTeamCurrentQuestionCounts([], teams, undefined)
    expect(counts.get('team-1')).toBe(0)
    expect(counts.get('team-2')).toBe(0)
  })
})
