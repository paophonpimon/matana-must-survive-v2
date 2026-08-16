import type { Player, Room } from '../types/game'

interface TimedQuestionState {
  questionStartedAt: number | null
  questionDurationSeconds: number
  questionClosedAt: number | null
}

export const ANSWER_REVEAL_MILLISECONDS = 4_000

// Milestone 2.2: an early teacher close (questionClosedAt) overrides the normal
// questionStartedAt + questionDurationSeconds deadline. Every timing computation in this file —
// remaining time, reveal countdown, teacher-visible score hiding — derives from this single
// function, so early-close support required no changes anywhere else: the moment
// questionClosedAt lands, getRemainingMilliseconds reads 0 and getRevealRemainingMilliseconds
// starts counting down from questionClosedAt instead of the original deadline.
export const getQuestionDeadline = (room: TimedQuestionState): number | null => {
  if (room.questionClosedAt != null) return room.questionClosedAt
  return room.questionStartedAt == null ? null : room.questionStartedAt + room.questionDurationSeconds * 1_000
}

export const getRemainingMilliseconds = (room: TimedQuestionState, now = Date.now()): number => {
  const deadline = getQuestionDeadline(room)
  return deadline == null ? 0 : Math.max(0, deadline - now)
}

export const getRevealRemainingMilliseconds = (room: TimedQuestionState, now = Date.now()): number => {
  const deadline = getQuestionDeadline(room)
  if (deadline == null || now < deadline) return 0
  return Math.max(0, deadline + ANSWER_REVEAL_MILLISECONDS - now)
}

export const areAnswersLocked = (saving: boolean, timeExpired: boolean): boolean =>
  saving || timeExpired

// True once the current question's answer window has closed — i.e. answers are locked and the
// reveal has begun, so the current question's correctness may be shown to the teacher. Before
// this, the projected teacher screen must not expose anything derived from current-question
// correctness, or students can answer at random and read the answer off the projector.
export const isCurrentQuestionRevealed = (
  room: Pick<Room, 'status' | 'questionStartedAt' | 'questionDurationSeconds' | 'questionClosedAt'>,
  now = Date.now(),
): boolean => room.status !== 'playing' || getRemainingMilliseconds(room, now) === 0

// The teacher-safe view of a player during a live question: the current question's answer record
// is withheld entirely (not just its score point), so every downstream aggregate computed from
// `answers` — team correct counts, competition scores, per-question ticks — is blind to it too.
// Once the window closes this returns the player untouched.
export const getTeacherVisiblePlayer = <T extends Pick<Player, 'score' | 'answers'>>(
  room: Pick<Room, 'status' | 'questionIds' | 'currentQuestionIndex' | 'questionStartedAt' | 'questionDurationSeconds' | 'questionClosedAt'>,
  player: T,
  now = Date.now(),
): T => {
  if (isCurrentQuestionRevealed(room, now)) return player
  const currentQuestionId = room.questionIds[room.currentQuestionIndex]
  const hiddenAnswer = player.answers.find((answer) => answer.questionId === currentQuestionId)
  if (!hiddenAnswer) return player
  return {
    ...player,
    score: Math.max(0, player.score - (hiddenAnswer.isCorrect ? 1 : 0)),
    answers: player.answers.filter((answer) => answer.questionId !== currentQuestionId),
  }
}

export const getTeacherVisibleScore = (
  room: Pick<Room, 'status' | 'questionIds' | 'currentQuestionIndex' | 'questionStartedAt' | 'questionDurationSeconds' | 'questionClosedAt'>,
  player: Pick<Player, 'score' | 'answers'>,
  now = Date.now(),
): number => {
  if (room.status !== 'playing' || getRemainingMilliseconds(room, now) === 0) return player.score
  const currentQuestionId = room.questionIds[room.currentQuestionIndex]
  const hiddenAnswer = player.answers.find((answer) => answer.questionId === currentQuestionId)
  return Math.max(0, player.score - (hiddenAnswer?.isCorrect ? 1 : 0))
}
