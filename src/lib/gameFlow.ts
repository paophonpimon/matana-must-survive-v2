import type { Player, Room } from '../types/game'

interface TimedQuestionState {
  questionStartedAt: number | null
  questionDurationSeconds: number
}

export const ANSWER_REVEAL_MILLISECONDS = 4_000

export const getQuestionDeadline = (room: TimedQuestionState): number | null =>
  room.questionStartedAt == null ? null : room.questionStartedAt + room.questionDurationSeconds * 1_000

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

export const getTeacherVisibleScore = (
  room: Pick<Room, 'status' | 'questionIds' | 'currentQuestionIndex' | 'questionStartedAt' | 'questionDurationSeconds'>,
  player: Pick<Player, 'score' | 'answers'>,
  now = Date.now(),
): number => {
  if (room.status !== 'playing' || getRemainingMilliseconds(room, now) === 0) return player.score
  const currentQuestionId = room.questionIds[room.currentQuestionIndex]
  const hiddenAnswer = player.answers.find((answer) => answer.questionId === currentQuestionId)
  return Math.max(0, player.score - (hiddenAnswer?.isCorrect ? 1 : 0))
}
