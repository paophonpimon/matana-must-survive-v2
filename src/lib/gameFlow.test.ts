import { describe, expect, it } from 'vitest'
import { ANSWER_REVEAL_MILLISECONDS, areAnswersLocked, getQuestionDeadline, getRemainingMilliseconds, getRevealRemainingMilliseconds, getTeacherVisibleScore, getTeacherVisiblePlayer, isCurrentQuestionRevealed, getAssessmentRemainingMilliseconds, isAssessmentExpired, rescueLateArrivingWindow, type AssessmentWindow } from './gameFlow'

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

  // Regression: the projected teacher screen must not act as an answer oracle. Hiding only the
  // score point was not enough — team correct counts and competition scores are derived from
  // `answers`, so a correct guess still ticked those upward mid-question.
  it('withholds the current question\'s answer record from the teacher until the reveal begins', () => {
    const room = {
      status: 'playing' as const,
      questionIds: ['q1', 'q2'],
      currentQuestionIndex: 1,
      questionStartedAt: 10_000,
      questionDurationSeconds: 30,
      questionClosedAt: null,
    }
    const player = {
      score: 2,
      answers: [
        { questionId: 'q1', selectedChoiceId: 'a', isCorrect: true, answeredAt: 5_000, responseTimeMs: 1_000 },
        { questionId: 'q2', selectedChoiceId: 'b', isCorrect: true, answeredAt: 12_000, responseTimeMs: 2_000 },
      ],
    }

    // Timer still live: the current question is invisible in every derived form.
    expect(isCurrentQuestionRevealed(room, 20_000)).toBe(false)
    const live = getTeacherVisiblePlayer(room, player, 20_000)
    expect(live.score).toBe(1)
    expect(live.answers.map((answer) => answer.questionId)).toEqual(['q1'])
    // Any aggregate counting correct answers therefore sees only the resolved question.
    expect(live.answers.filter((answer) => answer.isCorrect)).toHaveLength(1)

    // After the deadline: fully visible, nothing withheld.
    expect(isCurrentQuestionRevealed(room, 40_001)).toBe(true)
    const revealed = getTeacherVisiblePlayer(room, player, 40_001)
    expect(revealed.score).toBe(2)
    expect(revealed.answers.map((answer) => answer.questionId)).toEqual(['q1', 'q2'])
    expect(revealed.answers.filter((answer) => answer.isCorrect)).toHaveLength(2)
    // The original record is never mutated.
    expect(player.answers).toHaveLength(2)
  })
})

describe('latency rescue for a question that arrives already expired', () => {
  const OPENED = 1_000_000
  const window10s = { startedAt: OPENED, durationSeconds: 10 }
  const always = () => true

  it('leaves a window that still has time on it completely alone', () => {
    expect(rescueLateArrivingWindow(window10s, always, OPENED + 4_000)).toBeNull()
  })

  it('does nothing before the teacher has opened the test', () => {
    expect(rescueLateArrivingWindow({ startedAt: null, durationSeconds: 10 }, always, OPENED)).toBeNull()
  })

  it('re-anchors a window whose whole budget was consumed by the round trip', () => {
    // The previous answer persisted at OPENED; this device only rendered the new question 12s
    // later, so it arrives 2s past its deadline having never been on screen.
    const arrivedAt = OPENED + 12_000
    const rescued = rescueLateArrivingWindow(window10s, always, arrivedAt)
    expect(rescued).toEqual({ startedAt: arrivedAt, durationSeconds: 10, introOffsetMs: 0 })
    // A full fresh budget, and no intro offset — the intro belongs to question 1 only.
    expect(getAssessmentRemainingMilliseconds(rescued as AssessmentWindow, arrivedAt)).toBe(10_000)
    expect(isAssessmentExpired(rescued as AssessmentWindow, arrivedAt)).toBe(false)
  })

  it('cannot be farmed: the second arrival on the same question is refused', () => {
    // What sessionStorage does in the component — the claim succeeds once, then never again.
    let spent = false
    const claimOnce = (): boolean => (spent ? false : ((spent = true), true))
    const arrivedAt = OPENED + 12_000
    expect(rescueLateArrivingWindow(window10s, claimOnce, arrivedAt)).not.toBeNull()
    // A reload re-renders the same expired index; this time it gets the real window and times out.
    expect(rescueLateArrivingWindow(window10s, claimOnce, arrivedAt + 500)).toBeNull()
  })

  it('never spends the claim on a question that did not need rescuing', () => {
    let claims = 0
    const counting = (): boolean => { claims += 1; return true }
    rescueLateArrivingWindow(window10s, counting, OPENED + 1_000)
    expect(claims).toBe(0)
  })
})
