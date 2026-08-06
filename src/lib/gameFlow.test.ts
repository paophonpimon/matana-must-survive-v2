import { describe, expect, it } from 'vitest'
import { ANSWER_REVEAL_MILLISECONDS, areAnswersLocked, getQuestionDeadline, getRemainingMilliseconds, getRevealRemainingMilliseconds, getTeacherVisibleScore } from './gameFlow'

describe('timed game question flow', () => {
  it('uses one shared deadline for every team', () => {
    const room = { questionStartedAt: 10_000, questionDurationSeconds: 30 }
    expect(getQuestionDeadline(room)).toBe(40_000)
    expect(getRemainingMilliseconds(room, 25_000)).toBe(15_000)
    expect(getRemainingMilliseconds(room, 45_000)).toBe(0)
  })

  it('allows answer changes until time expires and only locks while saving or after the deadline', () => {
    expect(areAnswersLocked(false, false)).toBe(false)
    expect(areAnswersLocked(true, false)).toBe(true)
    expect(areAnswersLocked(false, true)).toBe(true)
  })

  it('returns zero before a question has started', () => {
    expect(getRemainingMilliseconds({ questionStartedAt: null, questionDurationSeconds: 30 })).toBe(0)
  })

  it('shows a shared reveal window after answer time ends', () => {
    const room = { questionStartedAt: 10_000, questionDurationSeconds: 30 }
    expect(getRevealRemainingMilliseconds(room, 39_999)).toBe(0)
    expect(getRevealRemainingMilliseconds(room, 40_000)).toBe(ANSWER_REVEAL_MILLISECONDS)
    expect(getRevealRemainingMilliseconds(room, 44_001)).toBe(0)
  })

  it('keeps the current answer score hidden from the teacher until students see the reveal', () => {
    const room = {
      status: 'playing' as const,
      questionStartedAt: 10_000,
      questionDurationSeconds: 30,
      currentQuestionIndex: 0,
      questionIds: ['q1'],
    }
    const correctTeam = { score: 4, answers: [{ questionId: 'q1', selectedChoiceId: 'a', isCorrect: true, answeredAt: 20_000, responseTimeMs: 10_000 }] }
    const wrongTeam = { score: 3, answers: [{ questionId: 'q1', selectedChoiceId: 'b', isCorrect: false, answeredAt: 20_000, responseTimeMs: 10_000 }] }

    expect(getTeacherVisibleScore(room, correctTeam, 30_000)).toBe(3)
    expect(getTeacherVisibleScore(room, wrongTeam, 30_000)).toBe(3)
    expect(getTeacherVisibleScore(room, correctTeam, 40_000)).toBe(4)
  })
})
