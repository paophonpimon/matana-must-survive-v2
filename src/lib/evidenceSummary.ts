import { ASSESSMENT_QUESTION_COUNT } from '../data/assessmentQuestions'
import { SURVEY_ITEMS, SURVEY_ITEM_COUNT } from '../data/surveyItems'
import { computePostTestResult, computePreTestResult, type SelectedAssessmentAnswer } from './assessment'
import { computeStudentRecallResult } from './learning'
import { RECALL_QUESTION_COUNT, type Player, type RoundHistoryEntry } from '../types/game'

// Teacher evidence summary for a finished round, computed from LIVE player data so the screen
// works the moment the round completes — it never waits on the round-history snapshot.
//
// Deliberately descriptive, never causal. Pre/post is reported as "how many students scored higher
// after than before", not as an effect of the activity: this is one classroom, with no control
// group and no randomisation, so nothing here can support a causal claim. No inferential statistic
// is computed for the same reason.
//
// Recall is reported on its own and is NEVER compared against Main or against pre/post — it is a
// review activity, not a measurement.

// Main round length. Mirrors the 10-item main bank; kept local rather than reaching into another
// module's private constant.
export const MAIN_QUESTION_COUNT = 10

const average = (values: number[]): number =>
  (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length)

// Null, never 0, when there is nothing to average — an absent measurement must never read as a
// score of zero.
const averageOrNull = (values: number[]): number | null =>
  (values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length)

// THE shared percentage rule. Every ratio in the evidence report goes through this, so a
// percentage can never be computed against a different denominator in one place than another.
// An empty denominator yields null ("unavailable"), never 0% — 0% would assert that nobody
// improved, when in fact nobody was eligible to be measured.
export const percentOf = (numerator: number, denominator: number): number | null =>
  (denominator <= 0 ? null : (numerator / denominator) * 100)

// THE shared percentage formatter. Rounds to 1 decimal for presentation only — the stored value
// stays exact. 26/30 -> "86.7%", 30/30 -> "100%", unavailable -> "-".
export const formatPercent = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '-'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

// Shared average formatter. Unavailable reads "-", never "0.0". Digits stay a caller choice so
// each figure keeps the precision it already used.
export const formatAverage = (value: number | null, digits = 2): string =>
  (value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits))

// Signed form for the pre/post difference, so a gain reads "+1.5" and a drop "-1.5".
export const formatSignedAverage = (value: number | null, digits = 2): string =>
  (value === null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`)

// Count + denominator + percentage, the traceable form every headline figure is reported in:
// "26/30 คน · 86.7%" rather than a bare "86.7%".
export const formatCountWithPercent = (numerator: number, denominator: number, unit = 'คน'): string =>
  (denominator <= 0
    ? '-'
    : `${numerator}/${denominator} ${unit} · ${formatPercent(percentOf(numerator, denominator))}`)

export interface PrePostSummary {
  // Only students who finished BOTH tests. Anyone who did not is excluded entirely rather than
  // counted as zero, which would fabricate a drop. This is the DENOMINATOR for every pre/post
  // percentage below — never totalStudents.
  comparedCount: number
  totalStudents: number
  // null when comparedCount is 0: with nobody eligible there is no average, and reporting 0/10
  // would read as a real score of zero.
  preAverage: number | null
  postAverage: number | null
  averageDifference: number | null
  improvedCount: number
  unchangedCount: number
  declinedCount: number
  // All three are shares of comparedCount (NOT totalStudents), and null when comparedCount is 0.
  // They sum to 100% whenever they are available, which is what lets the three counts be
  // reconciled against the per-student table.
  improvedPercent: number | null
  unchangedPercent: number | null
  declinedPercent: number | null
  totalCount: number
}

export interface MainSummary {
  averageScore: number
  totalCount: number
  completedCount: number
  totalStudents: number
  // completedCount / totalStudents. Null when the room has no students.
  completionPercent: number | null
}

export interface RecallSummary {
  averageCorrect: number
  totalCount: number
  completedCount: number
  totalStudents: number
  // completedCount / totalStudents. Null when the room has no students. Review/readiness only —
  // never a baseline, never compared with Main or pre/post.
  completionPercent: number | null
}

export interface SurveyItemSummary {
  itemId: string
  statement: string
  // Mean over COMPLETED surveys only (see SurveySummary).
  average: number
  responseCount: number
}

export interface SurveySummary {
  // Denominator for the satisfaction figures below: only students who answered all 6 items.
  completedCount: number
  totalStudents: number
  // completedCount / totalStudents — how much of the class is represented by the averages.
  // Null when the room has no students.
  completionPercent: number | null
  // Mean across every response from a COMPLETED survey. A partially finished survey is excluded
  // entirely rather than contributing its first few answers — otherwise a student who quit after
  // item 1 would weight that item more heavily than the rest and skew satisfaction.
  overallAverage: number
  responseCount: number
  items: SurveyItemSummary[]
}

export interface StudentEvidenceRow {
  playerId: string
  displayName: string
  studentNumber: string
  // null when that test was not completed — the UI renders "-" rather than a misleading number.
  preScore: number | null
  postScore: number | null
  difference: number | null
  mainScore: number
  mainAnsweredCount: number
  mainCompleted: boolean
  surveyAnsweredCount: number
  surveyCompleted: boolean
}

export interface EvidenceSummary {
  totalStudents: number
  prePost: PrePostSummary
  main: MainSummary
  recall: RecallSummary
  survey: SurveySummary
  students: StudentEvidenceRow[]
}

// Normalized input row. Both the live-player path and the round-history path map onto this, so
// the aggregation below runs ONCE and the on-screen panel, the printed report and the spreadsheet
// can never drift apart on a formula.
export interface EvidenceSource {
  playerId: string
  displayName: string
  studentNumber: string
  preAnswers: SelectedAssessmentAnswer[]
  postAnswers: SelectedAssessmentAnswer[]
  mainScore: number
  mainAnsweredCount: number
  recallCorrectCount: number
  recallAnsweredCount: number
  surveyResponses: Array<{ itemId: string; value: string }>
}

export const toEvidenceSource = (player: Player): EvidenceSource => {
  const recall = computeStudentRecallResult(player)
  return {
    playerId: player.id,
    displayName: player.displayName,
    studentNumber: player.studentNumber,
    preAnswers: player.preTestAnswers,
    postAnswers: player.postTestAnswers,
    mainScore: player.score,
    mainAnsweredCount: player.answers.length,
    recallCorrectCount: recall.correctCount,
    recallAnsweredCount: recall.answeredCount,
    surveyResponses: player.surveyResponses,
  }
}

// Round-history rows carry the same raw material: the selections themselves, plus the standalone
// recall figure. Correctness is still derived from the banks below, never read from the record.
//
// Rounds recorded before per-item recall detail existed have no recallResults, so their recall
// COMPLETION cannot be known and is reported as 0 answered; the recall average still reads from
// the stored count (falling back to the legacy field) so those rounds are not blank.
export const historyEntryToEvidenceSource = (entry: RoundHistoryEntry): EvidenceSource => ({
  playerId: entry.playerId,
  displayName: entry.displayName,
  studentNumber: entry.studentNumber,
  preAnswers: entry.preTestAnswers ?? [],
  postAnswers: entry.postTestAnswers ?? [],
  mainScore: entry.knowledgeScore,
  mainAnsweredCount: entry.mainAnswers.length,
  recallCorrectCount: entry.recallCorrectCount ?? entry.beforeCorrectCount ?? 0,
  recallAnsweredCount: (entry.recallResults ?? []).filter((result) => result.answered).length,
  surveyResponses: entry.surveyResponses ?? [],
})

export const computeEvidenceSummary = (players: Player[]): EvidenceSummary =>
  computeEvidenceSummaryFromSources(players.map(toEvidenceSource))

// Durable path: the same formulas, applied to snapshotted history instead of live players.
export const computeEvidenceSummaryFromHistory = (entries: RoundHistoryEntry[]): EvidenceSummary =>
  computeEvidenceSummaryFromSources(entries.map(historyEntryToEvidenceSource))

export const computeEvidenceSummaryFromSources = (players: EvidenceSource[]): EvidenceSummary => {
  const totalStudents = players.length

  const students: StudentEvidenceRow[] = players.map((player) => {
    const pre = computePreTestResult(player.preAnswers)
    const post = computePostTestResult(player.postAnswers)
    // "Completed" means every item was answered. A partially finished test has no comparable
    // score, so it is reported as absent rather than as a low score.
    const preCompleted = player.preAnswers.length >= ASSESSMENT_QUESTION_COUNT
    const postCompleted = player.postAnswers.length >= ASSESSMENT_QUESTION_COUNT
    const preScore = preCompleted ? pre.correctCount : null
    const postScore = postCompleted ? post.correctCount : null
    return {
      playerId: player.playerId,
      displayName: player.displayName,
      studentNumber: player.studentNumber,
      preScore,
      postScore,
      difference: preScore !== null && postScore !== null ? postScore - preScore : null,
      mainScore: player.mainScore,
      mainAnsweredCount: player.mainAnsweredCount,
      mainCompleted: player.mainAnsweredCount >= MAIN_QUESTION_COUNT,
      surveyAnsweredCount: player.surveyResponses.length,
      surveyCompleted: player.surveyResponses.length >= SURVEY_ITEM_COUNT,
    }
  })

  // --- pre/post, over the compared subset only ---
  const compared = students.filter((student) => student.preScore !== null && student.postScore !== null)
  const improvedCount = compared.filter((student) => (student.difference as number) > 0).length
  const unchangedCount = compared.filter((student) => (student.difference as number) === 0).length
  const declinedCount = compared.filter((student) => (student.difference as number) < 0).length
  const prePost: PrePostSummary = {
    comparedCount: compared.length,
    totalStudents,
    preAverage: averageOrNull(compared.map((student) => student.preScore as number)),
    postAverage: averageOrNull(compared.map((student) => student.postScore as number)),
    averageDifference: averageOrNull(compared.map((student) => student.difference as number)),
    improvedCount,
    unchangedCount,
    declinedCount,
    // Denominator is compared.length — the paired-complete subset — never totalStudents.
    improvedPercent: percentOf(improvedCount, compared.length),
    unchangedPercent: percentOf(unchangedCount, compared.length),
    declinedPercent: percentOf(declinedCount, compared.length),
    totalCount: ASSESSMENT_QUESTION_COUNT,
  }

  // --- main game, over every student ---
  const mainCompletedCount = students.filter((student) => student.mainCompleted).length
  const main: MainSummary = {
    // Raw individual knowledge only: player.mainScore is the /10 answer score. Boss (/3), team
    // competition scores and every magic-item modifier are computed elsewhere and never reach
    // this figure.
    averageScore: average(players.map((player) => player.mainScore)),
    totalCount: MAIN_QUESTION_COUNT,
    completedCount: mainCompletedCount,
    totalStudents,
    completionPercent: percentOf(mainCompletedCount, totalStudents),
  }

  // --- recall, reported entirely on its own ---
  const recallCompletedCount = players.filter((player) => player.recallAnsweredCount >= RECALL_QUESTION_COUNT).length
  const recall: RecallSummary = {
    averageCorrect: average(players.map((player) => player.recallCorrectCount)),
    totalCount: RECALL_QUESTION_COUNT,
    completedCount: recallCompletedCount,
    totalStudents,
    completionPercent: percentOf(recallCompletedCount, totalStudents),
  }

  // --- survey, over COMPLETED surveys only ---
  // Every satisfaction figure is computed from students who answered all 6 items. A partial
  // survey contributes nothing: including it would let whoever quit early weight the first items
  // more than the last ones, which is a sampling artefact rather than a real signal.
  const completedSurveyPlayers = players.filter((player) => player.surveyResponses.length >= SURVEY_ITEM_COUNT)
  const completedResponses = completedSurveyPlayers.flatMap((player) => player.surveyResponses)
  const numericValue = (value: string): number => Number(value)
  const items: SurveyItemSummary[] = SURVEY_ITEMS.map((item) => {
    const responses = completedResponses.filter((response) => response.itemId === item.id)
    return {
      itemId: item.id,
      statement: item.statement,
      average: average(responses.map((response) => numericValue(response.value))),
      responseCount: responses.length,
    }
  })
  const survey: SurveySummary = {
    completedCount: completedSurveyPlayers.length,
    totalStudents,
    completionPercent: percentOf(completedSurveyPlayers.length, totalStudents),
    overallAverage: average(completedResponses.map((response) => numericValue(response.value))),
    responseCount: completedResponses.length,
    items,
  }

  return { totalStudents, prePost, main, recall, survey, students }
}
