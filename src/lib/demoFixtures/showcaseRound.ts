import { PRE_TEST_QUESTIONS, POST_TEST_QUESTIONS } from '../../data/assessmentQuestions'
import { questions } from '../../data/questions'
import { RECALL_QUESTIONS } from '../../data/recallQuestions'
import { SURVEY_ITEMS } from '../../data/surveyItems'
import { ROUND_CATEGORY_COUNTS } from '../game'
import type { Player, TeamMeta } from '../../types/game'
import { rosterDisplayName, type RosterStudent } from './syntheticRoster'

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  SHOWCASE ROUND GENERATOR — SIMULATED PRESENTATION DATA
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
//  Builds ONE finished round for a 30-student roster, shaped so the existing production pipeline
//  (computeEvidenceSummary → Teacher Result / Print / Excel) derives the agreed presentation
//  figures. It produces REAL Player records — the same shape a played round leaves behind — so
//  every number on screen is derived by the normal aggregator, never asserted here.
//
//  THE ROSTER IS AN ARGUMENT, NEVER A COMMITTED CONSTANT.
//  Tests pass the SYNTHETIC roster. The seed script passes rows parsed at run time from the
//  teacher's CSV, which lives outside this repository. No real student identity is ever stored
//  in version control.
//
//  EVERY SCORE BELOW IS SIMULATED. Do not present any figure derived from this file as a measured
//  classroom result.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Stable, easy-to-recognise room code for the showcase round. */
export const SHOWCASE_ROOM_CODE = '5101'
/** Marks the room as presentation data. Read by nothing in gameplay — provenance only. */
export const SHOWCASE_MODE_FIELD = 'showcaseMode'
export const SHOWCASE_ROUND = 1
/** Fixed instant so re-seeding produces byte-identical documents. */
export const SHOWCASE_COMPLETED_AT = Date.UTC(2026, 7, 20, 3, 30, 0)
/** The generator is calibrated for exactly this class size. */
export const SHOWCASE_STUDENT_COUNT = 30

const TEAM_COUNT = 5
const TEAM_SIZE = 6

/** Guardian names for the five showcase teams, in team order. */
export const SHOWCASE_TEAM_NAMES = [
  'ทีมกุหลาบทอง',
  'ทีมมนตราเงิน',
  'ทีมพิทักษ์รัตนา',
  'ทีมวารีเมขลา',
  'ทีมวายุบุตร',
] as const

export const SHOWCASE_TEAMS: TeamMeta[] = Array.from({ length: TEAM_COUNT }, (_, index) => ({
  id: `team-${index + 1}`,
  name: `ทีม ${index + 1}`,
}))

// Deterministic question selection: the first N of each category, in the same per-category counts
// selectRoundQuestions uses. Deterministic (not random) so re-running the seed rewrites the same
// round rather than silently producing a different one.
export const SHOWCASE_QUESTION_IDS: string[] = Object.entries(ROUND_CATEGORY_COUNTS)
  .flatMap(([category, count]) =>
    questions.filter((question) => question.category === category).slice(0, count).map((question) => question.id))

// ── SIMULATED per-position performance ─────────────────────────────────────────────────────────
// Indexed by studentNumber (1–30) — a POSITION in the roster, never a person. Written out
// explicitly so every reported figure can be traced by eye to the row behind it.
//
// The class shape these rows produce, all DERIVED by the shared aggregator:
//   paired pre/post 30/30 · pre 5.43 · post 8.33 · difference +2.90
//   improved 26 · unchanged 3 · declined 1
//   main complete 30/30 · main average 8.17 · recall average 4.13 · survey average 4.63
interface ShowcasePerformance {
  studentNumber: number
  /** SIMULATED pre-test correct count, out of 10. */
  preCorrect: number
  /** SIMULATED post-test correct count, out of 10. */
  postCorrect: number
  /** SIMULATED main knowledge score, out of 10. Raw individual only. */
  mainScore: number
  /** SIMULATED recall correct count, out of 5 (all five items answered). */
  recallCorrect: number
  /** SIMULATED: how many of the 6 survey items were answered 5; the rest are answered 4. */
  surveyFives: number
}

const SHOWCASE_PERFORMANCE: ShowcasePerformance[] = [
  // Improved (26 positions) ─────────────────────────────────────────────────────────────────────
  { studentNumber: 1, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 2, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 3, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 4, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 5, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 6, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 7, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 8, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 9, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 10, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 11, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 5, surveyFives: 6 },
  { studentNumber: 12, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 5, surveyFives: 4 },
  { studentNumber: 13, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 14, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 15, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 16, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 17, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 18, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 19, preCorrect: 4, postCorrect: 8, mainScore: 7, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 20, preCorrect: 4, postCorrect: 8, mainScore: 7, recallCorrect: 4, surveyFives: 4 },
  { studentNumber: 21, preCorrect: 4, postCorrect: 8, mainScore: 7, recallCorrect: 4, surveyFives: 2 },
  { studentNumber: 22, preCorrect: 4, postCorrect: 8, mainScore: 7, recallCorrect: 4, surveyFives: 2 },
  { studentNumber: 23, preCorrect: 7, postCorrect: 10, mainScore: 7, recallCorrect: 3, surveyFives: 2 },
  { studentNumber: 24, preCorrect: 7, postCorrect: 10, mainScore: 7, recallCorrect: 3, surveyFives: 2 },
  { studentNumber: 25, preCorrect: 4, postCorrect: 6, mainScore: 7, recallCorrect: 3, surveyFives: 2 },
  { studentNumber: 26, preCorrect: 5, postCorrect: 6, mainScore: 10, recallCorrect: 3, surveyFives: 1 },
  // Unchanged (3 positions) ─────────────────────────────────────────────────────────────────────
  { studentNumber: 27, preCorrect: 6, postCorrect: 6, mainScore: 10, recallCorrect: 3, surveyFives: 0 },
  { studentNumber: 28, preCorrect: 5, postCorrect: 5, mainScore: 10, recallCorrect: 3, surveyFives: 0 },
  { studentNumber: 29, preCorrect: 7, postCorrect: 7, mainScore: 6, recallCorrect: 3, surveyFives: 0 },
  // Declined (1 position) ───────────────────────────────────────────────────────────────────────
  { studentNumber: 30, preCorrect: 8, postCorrect: 6, mainScore: 6, recallCorrect: 3, surveyFives: 0 },
]

const wrongFor = (question: { choices: Array<{ id: string }>; correctChoiceId: string }): string =>
  question.choices.find((choice) => choice.id !== question.correctChoiceId)?.id ?? ''

const performanceFor = (studentNumber: number): ShowcasePerformance => {
  const found = SHOWCASE_PERFORMANCE.find((entry) => entry.studentNumber === studentNumber)
  if (!found) throw new Error(`missing showcase performance for studentNumber ${studentNumber}`)
  return found
}

/** team-1 … team-5, six students each, in roster order. */
export const showcaseTeamIdFor = (studentNumber: number): string =>
  `team-${Math.floor((studentNumber - 1) / TEAM_SIZE) + 1}`

export const showcaseTeamNameFor = (teamId: string): string => {
  const index = SHOWCASE_TEAMS.findIndex((team) => team.id === teamId)
  return index >= 0 ? SHOWCASE_TEAM_NAMES[index] : teamId
}

/** Rejects any roster the generator is not calibrated for, before a single document is built. */
export const assertShowcaseRoster = (roster: RosterStudent[]): void => {
  if (roster.length !== SHOWCASE_STUDENT_COUNT) {
    throw new Error(`showcase roster must hold exactly ${SHOWCASE_STUDENT_COUNT} students, got ${roster.length}`)
  }
  const numbers = roster.map((student) => student.studentNumber).sort((a, b) => a - b)
  const expected = Array.from({ length: SHOWCASE_STUDENT_COUNT }, (_, index) => index + 1)
  if (numbers.some((value, index) => value !== expected[index])) {
    throw new Error('showcase roster must carry studentNumber 1–30 exactly once each')
  }
  if (new Set(roster.map((student) => student.studentId)).size !== roster.length) {
    throw new Error('showcase roster has duplicate studentId values')
  }
}

/**
 * One fully-formed Player per roster student, exactly as a finished round would leave it.
 *
 * The roster is supplied by the caller — synthetic in tests, parsed from the teacher's external
 * CSV at seed time. Answers are REAL selections against the REAL banks, so correctness — and
 * therefore every average and percentage the report shows — is derived by production code, never
 * asserted here.
 */
export const buildShowcasePlayers = (roster: RosterStudent[]): Player[] => {
  assertShowcaseRoster(roster)
  return [...roster]
    .sort((a, b) => a.studentNumber - b.studentNumber)
    .map((student) => {
      const performance = performanceFor(student.studentNumber)
      const answers = SHOWCASE_QUESTION_IDS.map((questionId, index) => {
        const question = questions.find((entry) => entry.id === questionId)
        if (!question) throw new Error(`unknown showcase question id ${questionId}`)
        const isCorrect = index < performance.mainScore
        return {
          questionId,
          selectedChoiceId: isCorrect ? question.correctChoiceId : wrongFor(question),
          isCorrect,
          answeredAt: SHOWCASE_COMPLETED_AT,
        }
      })
      return {
        id: student.studentId,
        displayName: rosterDisplayName(student),
        studentNumber: String(student.studentNumber),
        teamId: showcaseTeamIdFor(student.studentNumber),
        joinedAt: SHOWCASE_COMPLETED_AT,
        currentRound: SHOWCASE_ROUND,
        currentQuestionIndex: SHOWCASE_QUESTION_IDS.length,
        score: performance.mainScore,
        answers,
        // Boss stays empty: the showcase round demonstrates the evidence pipeline, and Boss (/3) is
        // reported separately from Main (/10). Leaving it empty makes it impossible for a boss
        // figure to contaminate the knowledge evidence.
        bossAnswers: [],
        recallAnswers: RECALL_QUESTIONS.map((question, index) => ({
          conceptId: question.id,
          selectedChoiceId: index < performance.recallCorrect ? question.correctChoiceId : wrongFor(question),
          isCorrect: index < performance.recallCorrect,
          answeredAt: SHOWCASE_COMPLETED_AT,
        })),
        preTestAnswers: PRE_TEST_QUESTIONS.map((question, index) => ({
          questionId: question.id,
          selectedChoiceId: index < performance.preCorrect ? question.correctChoiceId : wrongFor(question),
          answeredAt: SHOWCASE_COMPLETED_AT,
        })),
        postTestAnswers: POST_TEST_QUESTIONS.map((question, index) => ({
          questionId: question.id,
          selectedChoiceId: index < performance.postCorrect ? question.correctChoiceId : wrongFor(question),
          answeredAt: SHOWCASE_COMPLETED_AT,
        })),
        preTestProgress: PRE_TEST_QUESTIONS.length,
        postTestProgress: POST_TEST_QUESTIONS.length,
        preTestQuestionStartedAt: null,
        postTestQuestionStartedAt: null,
        surveyResponses: SURVEY_ITEMS.map((item, index) => ({
          itemId: item.id,
          value: index < performance.surveyFives ? '5' : '4',
          answeredAt: SHOWCASE_COMPLETED_AT,
        })),
        submitted: true,
        finishedAt: SHOWCASE_COMPLETED_AT,
        elapsedMs: 600_000,
        status: 'submitted',
        ownerUid: `showcase-${student.studentId}`,
      } as unknown as Player
    })
}
