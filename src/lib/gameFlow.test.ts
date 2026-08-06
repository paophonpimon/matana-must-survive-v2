import { describe, expect, it } from 'vitest'
import { ANSWER_REVEAL_MILLISECONDS, areAnswersLocked, getQuestionDeadline, getRemainingMilliseconds, getRevealRemainingMilliseconds, getTeacherVisibleScore } from './gameFlow'

describe('timed game question flow', () => {
  it('uses one shared deadline for every team', () => {
    const room = { questionStartedAt: 10_000, questionDurationSeconds: 30, questionClosedAt: null }
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
    expect(getRemainingMilliseconds({ questionStartedAt: null, questionDurationSeconds: 30, questionClosedAt: null })).toBe(0)
  })

  it('shows a shared reveal window after answer time ends', () => {
    const room = { questionStartedAt: 10_000, questionDurationSeconds: 30, questionClosedAt: null }
    expect(getRevealRemainingMilliseconds(room, 39_999)).toBe(0)
    expect(getRevealRemainingMilliseconds(room, 40_000)).toBe(ANSWER_REVEAL_MILLISECONDS)
    expect(getRevealRemainingMilliseconds(room, 44_001)).toBe(0)
  })

  // Milestone 2.2: a teacher's early close overrides the normal deadline entirely — this is the
  // single lever every other timing computation (remaining time, reveal countdown, teacher score
  // hiding) is built on, so testing it here covers all of them by construction.
  describe('questionClosedAt (teacher early-close)', () => {
    it('becomes the effective deadline, overriding questionStartedAt + questionDurationSeconds', () => {
      const room = { questionStartedAt: 10_000, questionDurationSeconds: 30, questionClosedAt: 15_000 }
      expect(getQuestionDeadline(room)).toBe(15_000) // not 40_000
    })

    it('makes remaining time read 0 immediately, even though the normal deadline has not passed yet', () => {
      const room = { questionStartedAt: 10_000, questionDurationSeconds: 30, questionClosedAt: 15_000 }
      expect(getRemainingMilliseconds(room, 15_001)).toBe(0)
    })

    it('starts the reveal countdown from questionClosedAt, not from the original deadline', () => {
      const room = { questionStartedAt: 10_000, questionDurationSeconds: 30, questionClosedAt: 15_000 }
      expect(getRevealRemainingMilliseconds(room, 15_000)).toBe(ANSWER_REVEAL_MILLISECONDS)
      expect(getRevealRemainingMilliseconds(room, 15_000 + ANSWER_REVEAL_MILLISECONDS)).toBe(0)
    })

    it('has no effect when null (normal deadline math applies unchanged)', () => {
      const room = { questionStartedAt: 10_000, questionDurationSeconds: 30, questionClosedAt: null }
      expect(getQuestionDeadline(room)).toBe(40_000)
    })
  })

  it('keeps the current answer score hidden from the teacher until students see the reveal', () => {
    const room = {
      status: 'playing' as const,
      questionStartedAt: 10_000,
      questionDurationSeconds: 30,
      questionClosedAt: null,
      currentQuestionIndex: 0,
      questionIds: ['q1'],
    }
    const correctTeam = { score: 4, answers: [{ questionId: 'q1', selectedChoiceId: 'a', isCorrect: true, answeredAt: 20_000, responseTimeMs: 10_000 }] }
    const wrongTeam = { score: 3, answers: [{ questionId: 'q1', selectedChoiceId: 'b', isCorrect: false, answeredAt: 20_000, responseTimeMs: 10_000 }] }

    expect(getTeacherVisibleScore(room, correctTeam, 30_000)).toBe(3)
    expect(getTeacherVisibleScore(room, wrongTeam, 30_000)).toBe(3)
    expect(getTeacherVisibleScore(room, correctTeam, 40_000)).toBe(4)
  })

  it('reveals the teacher-visible score as soon as an early close lands, even before the original deadline', () => {
    const room = {
      status: 'playing' as const,
      questionStartedAt: 10_000,
      questionDurationSeconds: 30,
      questionClosedAt: 15_000,
      currentQuestionIndex: 0,
      questionIds: ['q1'],
    }
    const correctTeam = { score: 4, answers: [{ questionId: 'q1', selectedChoiceId: 'a', isCorrect: true, answeredAt: 12_000, responseTimeMs: 2_000 }] }
    expect(getTeacherVisibleScore(room, correctTeam, 15_001)).toBe(4) // would still be hidden (3) without the early close
  })
})
