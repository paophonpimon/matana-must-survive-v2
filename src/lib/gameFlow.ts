import { PHASE_INTRO_MILLISECONDS } from '../types/game'
import type { Player, Room } from '../types/game'

export interface TimedQuestionState {
  questionStartedAt: number | null
  questionDurationSeconds: number
  questionClosedAt: number | null
  // Milliseconds of phase-intro cutscene that play AFTER the persisted start instant and BEFORE
  // gameplay time begins. Applied here, in the derivation, rather than baked into the stored
  // timestamp — the stored value stays the real server-authored phase-entry instant, and no
  // client clock ever becomes the authority. Zero for every question that has no intro.
  introOffsetMs?: number
}

export const ANSWER_REVEAL_MILLISECONDS = 4_000

// Story Recall gets a much shorter post-question pause than Main. Recall is a warm-up review, so
// a 4-second hold between five short items reads as dead air; Main keeps its longer reveal
// because that is where the competitive score lands and teams need to read the breakdown.
export const RECALL_REVEAL_MILLISECONDS = 1_000

// Milestone 2.2: an early teacher close (questionClosedAt) overrides the normal
// questionStartedAt + questionDurationSeconds deadline. Every timing computation in this file —
// remaining time, reveal countdown, teacher-visible score hiding — derives from this single
// function, so early-close support required no changes anywhere else: the moment
// questionClosedAt lands, getRemainingMilliseconds reads 0 and getRevealRemainingMilliseconds
// starts counting down from questionClosedAt instead of the original deadline.
export const getQuestionDeadline = (room: TimedQuestionState): number | null => {
  if (room.questionClosedAt != null) return room.questionClosedAt
  if (room.questionStartedAt == null) return null
  // gameplayStart = persisted phase-entry instant + intro offset; deadline = that + duration.
  return room.questionStartedAt + (room.introOffsetMs ?? 0) + room.questionDurationSeconds * 1_000
}

export const getRemainingMilliseconds = (room: TimedQuestionState, now = Date.now()): number => {
  const deadline = getQuestionDeadline(room)
  if (deadline == null) return 0
  // Clamped to the configured duration so the intro window shows the full configured time rather
  // than the intro remainder on top of it — gameplay time does not decrement until the intro ends.
  return Math.max(0, Math.min(room.questionDurationSeconds * 1_000, deadline - now))
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
  room: Pick<Room, 'status' | 'questionStartedAt' | 'questionDurationSeconds' | 'questionClosedAt' | 'currentQuestionIndex'>,
  now = Date.now(),
): boolean => room.status !== 'playing' || getRemainingMilliseconds(mainQuestionTiming(room), now) === 0

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

// Assessment Layer: ONE budget for the whole test, derived from the room's authoritative start
// instant. Every client computes the same deadline from the same persisted timestamp, so nothing
// here can be reset or extended by reloading.
//
// A null startedAt means the test is not open yet, so remaining time reads as the FULL budget and
// nothing is expired — the clock only begins when the teacher starts the test.
export interface AssessmentWindow {
  startedAt: number | null
  durationSeconds: number
  // Same role as TimedQuestionState.introOffsetMs — the persisted startedAt is the real
  // server-authored instant the teacher opened the test; the intro offset is applied on read.
  introOffsetMs?: number
}

export const getAssessmentDeadline = (window: AssessmentWindow): number | null =>
  window.startedAt == null ? null : window.startedAt + (window.introOffsetMs ?? 0) + window.durationSeconds * 1_000

export const getAssessmentRemainingMilliseconds = (window: AssessmentWindow, now = Date.now()): number => {
  const deadline = getAssessmentDeadline(window)
  if (deadline == null) return window.durationSeconds * 1_000
  // Same clamp as the per-question timer: during the intro the readout shows the full budget and
  // does not decrement, and it can never exceed the configured duration.
  return Math.max(0, Math.min(window.durationSeconds * 1_000, deadline - now))
}

// A test with no recorded start has not opened yet and is therefore NOT expired — treating an
// absent timestamp as "time is up" would lock out every student the instant a legacy room loads.
export const isAssessmentExpired = (window: AssessmentWindow, now = Date.now()): boolean => {
  const deadline = getAssessmentDeadline(window)
  return deadline != null && now >= deadline
}

// The authoritative "may students answer this test right now?" predicate. Deliberately derived
// ONLY from room state — never from player.submitted or an answer count — so every client, and
// both services, reach the same verdict from the same persisted fields after any refresh.
export const isAssessmentOpen = (window: AssessmentWindow, now = Date.now()): boolean =>
  window.startedAt != null && !isAssessmentExpired(window, now)

// Latency rescue for a question that arrives already expired.
//
// A question's window opens at the instant the PREVIOUS answer was persisted, but the student's
// device does not see it until that write has round-tripped. On a slow phone — and on a short
// per-question budget — the round trip can eat the entire window, so the next question can reach
// the screen with no time left on it. That time was spent by the network, not by the student, and
// letting it stand means the timeout advance fires at once, writes the next question with the same
// handicap, and carries the student through several items they never saw.
//
// So a window that is ALREADY expired the first time a client lays eyes on it is re-anchored to
// `now` for a full fresh budget. `claim` gates it to once per question — a reload finds the claim
// already spent and gets the real, expired window, so the rescue cannot be farmed.
//
// Returns null when no rescue applies, meaning "use the persisted window unchanged".
export const rescueLateArrivingWindow = (
  window: AssessmentWindow,
  claim: () => boolean,
  now = Date.now(),
): AssessmentWindow | null => {
  if (window.startedAt == null) return null
  if (!isAssessmentExpired(window, now)) return null
  if (!claim()) return null
  return { startedAt: now, durationSeconds: window.durationSeconds, introOffsetMs: 0 }
}

// ---------------------------------------------------------------------------------------------
// Timing builders. Every caller — student pages, teacher auto-advance, and both services — goes
// through one of these instead of hand-assembling a timing object, so the "does an intro play
// here?" rule lives in exactly one place and cannot drift between screens.
//
// The rule: an intro plays on ENTRY to a phase, never between ordinary questions. That is fully
// derivable from the room's own index fields, so no extra persisted field is needed:
//   Main   -> currentQuestionIndex === 0
//   Boss   -> bossQuestionIndex === 0
//   Recall -> recallQuestionIndex === 0
//   Pre/Post -> always (each test is a single window entered once)
//
// Crucially the persisted timestamps stay exactly what the server wrote. The offset is applied on
// read, so the teacher's device clock is never the authority for synchronized timing.

type MainTimingRoom = Pick<Room, 'questionStartedAt' | 'questionDurationSeconds' | 'questionClosedAt' | 'currentQuestionIndex'>
type BossTimingRoom = Pick<Room, 'bossQuestionStartedAt' | 'bossQuestionDurationSeconds' | 'bossQuestionIndex'>
type RecallTimingRoom = Pick<Room, 'recallQuestionStartedAt' | 'recallQuestionDurationSeconds' | 'recallQuestionIndex'>
type PreTestRoom = Pick<Room, 'preTestStartedAt' | 'assessmentSecondsPerQuestion'>
type PostTestRoom = Pick<Room, 'postTestStartedAt' | 'assessmentSecondsPerQuestion'>

export const mainQuestionTiming = (room: MainTimingRoom): TimedQuestionState => ({
  questionStartedAt: room.questionStartedAt,
  questionDurationSeconds: room.questionDurationSeconds,
  questionClosedAt: room.questionClosedAt,
  introOffsetMs: room.currentQuestionIndex === 0 ? PHASE_INTRO_MILLISECONDS : 0,
})

export const bossQuestionTiming = (room: BossTimingRoom): TimedQuestionState => ({
  questionStartedAt: room.bossQuestionStartedAt,
  questionDurationSeconds: room.bossQuestionDurationSeconds,
  questionClosedAt: null,
  introOffsetMs: room.bossQuestionIndex === 0 ? PHASE_INTRO_MILLISECONDS : 0,
})

export const recallQuestionTiming = (room: RecallTimingRoom): TimedQuestionState => ({
  questionStartedAt: room.recallQuestionStartedAt,
  questionDurationSeconds: room.recallQuestionDurationSeconds,
  questionClosedAt: null,
  introOffsetMs: room.recallQuestionIndex === 0 ? PHASE_INTRO_MILLISECONDS : 0,
})

// Assessment timing is PER QUESTION and per student, because each student works through the test
// at their own pace — there is no shared question index to key a room-wide countdown off.
//
// The window is the student's OWN persisted question-start instant, written by the service every
// time they move on (answer or timeout). Falling back to the room's open instant covers the first
// question and any record written before this field existed.
//
// The phase-intro offset applies only to the very first question, which is the one the intro
// plays over.
export interface AssessmentProgress {
  questionStartedAt: number | null
  progress: number
}

const assessmentQuestionWindow = (
  openedAt: number | null,
  secondsPerQuestion: number,
  student: AssessmentProgress,
): AssessmentWindow => ({
  startedAt: student.questionStartedAt ?? openedAt,
  durationSeconds: secondsPerQuestion,
  introOffsetMs: student.progress === 0 ? PHASE_INTRO_MILLISECONDS : 0,
})

export const preTestWindow = (
  room: PreTestRoom,
  student: AssessmentProgress = { questionStartedAt: null, progress: 0 },
): AssessmentWindow =>
  assessmentQuestionWindow(room.preTestStartedAt, room.assessmentSecondsPerQuestion, student)

export const postTestWindow = (
  room: PostTestRoom,
  student: AssessmentProgress = { questionStartedAt: null, progress: 0 },
): AssessmentWindow =>
  assessmentQuestionWindow(room.postTestStartedAt, room.assessmentSecondsPerQuestion, student)

// Convenience readers so call sites never assemble the progress shape by hand.
export const preTestProgressOf = (player: Pick<Player, 'preTestProgress' | 'preTestQuestionStartedAt'>): AssessmentProgress =>
  ({ questionStartedAt: player.preTestQuestionStartedAt, progress: player.preTestProgress })

export const postTestProgressOf = (player: Pick<Player, 'postTestProgress' | 'postTestQuestionStartedAt'>): AssessmentProgress =>
  ({ questionStartedAt: player.postTestQuestionStartedAt, progress: player.postTestProgress })
