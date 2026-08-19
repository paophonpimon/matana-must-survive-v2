import { describe, expect, it } from 'vitest'
import { PRE_TEST_QUESTIONS, POST_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { SURVEY_ITEMS } from '../data/surveyItems'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import {
  computeEvidenceSummaryFromHistory,
  computeEvidenceSummaryFromSources,
  formatCountWithPercent,
  formatPercent,
  percentOf,
  type EvidenceSource,
} from './evidenceSummary'
import type { RoundHistoryEntry } from '../types/game'

// Every percentage in the competition report must be traceable to real student-level data: a
// numerator, an explicit denominator, and a per-student table the counts reconcile against.
//
// The fixture numbers below (30 students, 26 improved, …) exist ONLY in this file. They are never
// defaults, fallbacks or placeholders in production code — the aggregation always derives from the
// selected real room/round.

const wrongFor = (question: { choices: Array<{ id: string }>; correctChoiceId: string }): string =>
  question.choices.find((choice) => choice.id !== question.correctChoiceId)?.id ?? ''

// `correct` items answered correctly, the rest wrong; `answered` controls completeness.
const assessmentAnswers = (
  bank: typeof PRE_TEST_QUESTIONS,
  correct: number,
  answered: number = bank.length,
): Array<{ questionId: string; selectedChoiceId: string }> =>
  bank.slice(0, answered).map((question, index) => ({
    questionId: question.id,
    selectedChoiceId: index < correct ? question.correctChoiceId : wrongFor(question),
  }))

const source = (overrides: Partial<EvidenceSource> & { playerId: string }): EvidenceSource => ({
  displayName: overrides.playerId,
  studentNumber: overrides.playerId.slice(-2),
  preAnswers: [],
  postAnswers: [],
  mainScore: 0,
  mainAnsweredCount: 0,
  recallCorrectCount: 0,
  recallAnsweredCount: 0,
  surveyResponses: [],
  ...overrides,
})

const fullSurvey = () => SURVEY_ITEMS.map((item) => ({ itemId: item.id, value: '4' }))

// 30 students: 26 improved, 2 unchanged, 2 declined — all paired-complete.
const thirtyPairedStudents = (): EvidenceSource[] => [
  ...Array.from({ length: 26 }, (_, i) => source({
    playerId: `up-${String(i + 1).padStart(2, '0')}`,
    preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 4),
    postAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 7),
  })),
  ...Array.from({ length: 2 }, (_, i) => source({
    playerId: `same-${i + 1}`,
    preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 6),
    postAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 6),
  })),
  ...Array.from({ length: 2 }, (_, i) => source({
    playerId: `down-${i + 1}`,
    preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 8),
    postAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 5),
  })),
]

describe('shared percentage helpers', () => {
  it('rounds to one decimal only for presentation, and shows whole values plainly', () => {
    expect(formatPercent(percentOf(26, 30))).toBe('86.7%')
    expect(formatPercent(percentOf(30, 30))).toBe('100%')
    expect(formatPercent(percentOf(1, 3))).toBe('33.3%')
    // The stored value stays exact — only the display is rounded.
    expect(percentOf(26, 30)).toBeCloseTo(86.6666666, 5)
  })

  it('reports an empty denominator as unavailable, never as 0%', () => {
    expect(percentOf(0, 0)).toBeNull()
    expect(formatPercent(null)).toBe('-')
    expect(formatCountWithPercent(0, 0)).toBe('-')
  })

  it('formats the traceable count + denominator + percentage form', () => {
    expect(formatCountWithPercent(26, 30)).toBe('26/30 คน · 86.7%')
    expect(formatCountWithPercent(30, 30)).toBe('30/30 คน · 100%')
  })
})

describe('pre/post traceability', () => {
  it('26 improved of 30 paired reads 86.7%, and the three shares sum to 100%', () => {
    const summary = computeEvidenceSummaryFromSources(thirtyPairedStudents())
    expect(summary.totalStudents).toBe(30)
    expect(summary.prePost.comparedCount).toBe(30)
    expect(summary.prePost.improvedCount).toBe(26)
    expect(summary.prePost.unchangedCount).toBe(2)
    expect(summary.prePost.declinedCount).toBe(2)
    expect(formatPercent(summary.prePost.improvedPercent)).toBe('86.7%')
    expect(formatPercent(summary.prePost.unchangedPercent)).toBe('6.7%')
    expect(formatPercent(summary.prePost.declinedPercent)).toBe('6.7%')
    const total = (summary.prePost.improvedPercent as number)
      + (summary.prePost.unchangedPercent as number)
      + (summary.prePost.declinedPercent as number)
    expect(total).toBeCloseTo(100, 6)
  })

  it('uses pairedCompleteCount as the denominator, NOT the class total', () => {
    // 30 students, but only 10 finished both tests; 8 of those improved.
    const students = [
      ...Array.from({ length: 8 }, (_, i) => source({
        playerId: `paired-up-${i}`,
        preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 3),
        postAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 9),
      })),
      ...Array.from({ length: 2 }, (_, i) => source({
        playerId: `paired-same-${i}`,
        preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 5),
        postAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 5),
      })),
      // 20 students who never finished the post-test — excluded entirely.
      ...Array.from({ length: 20 }, (_, i) => source({
        playerId: `partial-${i}`,
        preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 5),
        postAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 3, 4),
      })),
    ]
    const summary = computeEvidenceSummaryFromSources(students)
    expect(summary.totalStudents).toBe(30)
    expect(summary.prePost.comparedCount).toBe(10)
    expect(summary.prePost.improvedCount).toBe(8)
    // 8/10 = 80%, NOT 8/30 = 26.7%.
    expect(formatPercent(summary.prePost.improvedPercent)).toBe('80%')
    expect(formatPercent(percentOf(8, 30))).toBe('26.7%')
  })

  it('excludes incomplete pre/post students and never scores them 0', () => {
    const summary = computeEvidenceSummaryFromSources([
      source({
        playerId: 'complete',
        preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 4),
        postAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 8),
      }),
      source({
        playerId: 'incomplete',
        preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 2, 3),
        postAnswers: [],
      }),
    ])
    expect(summary.prePost.comparedCount).toBe(1)
    // The incomplete student is still listed, with "-" values rather than zeros.
    const incomplete = summary.students.find((student) => student.playerId === 'incomplete')
    expect(incomplete).toBeDefined()
    expect(incomplete?.preScore).toBeNull()
    expect(incomplete?.postScore).toBeNull()
    expect(incomplete?.difference).toBeNull()
    // Averages reflect only the compared student, not a 0 dragged in by the incomplete one.
    expect(summary.prePost.preAverage).toBe(4)
    expect(summary.prePost.postAverage).toBe(8)
  })

  it('reports unavailable, not 0%, when nobody completed both tests', () => {
    const summary = computeEvidenceSummaryFromSources([
      source({ playerId: 'a', preAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 3, 5), postAnswers: [] }),
      source({ playerId: 'b' }),
    ])
    expect(summary.prePost.comparedCount).toBe(0)
    expect(summary.prePost.improvedPercent).toBeNull()
    expect(summary.prePost.unchangedPercent).toBeNull()
    expect(summary.prePost.declinedPercent).toBeNull()
    expect(summary.prePost.preAverage).toBeNull()
    expect(summary.prePost.postAverage).toBeNull()
    expect(summary.prePost.averageDifference).toBeNull()
    expect(formatPercent(summary.prePost.improvedPercent)).toBe('-')
  })
})

describe('main activity traceability', () => {
  it('30 of 30 complete reads 100%, over the class total', () => {
    const students = Array.from({ length: 30 }, (_, i) => source({
      playerId: `p-${i}`,
      mainScore: 7,
      mainAnsweredCount: 10,
    }))
    const summary = computeEvidenceSummaryFromSources(students)
    expect(summary.main.completedCount).toBe(30)
    expect(summary.main.totalStudents).toBe(30)
    expect(formatPercent(summary.main.completionPercent)).toBe('100%')
    expect(formatCountWithPercent(summary.main.completedCount, summary.totalStudents)).toBe('30/30 คน · 100%')
  })

  it('counts only students who answered all 10, denominator stays the class total', () => {
    const students = [
      ...Array.from({ length: 24 }, (_, i) => source({ playerId: `full-${i}`, mainScore: 6, mainAnsweredCount: 10 })),
      ...Array.from({ length: 6 }, (_, i) => source({ playerId: `part-${i}`, mainScore: 2, mainAnsweredCount: 4 })),
    ]
    const summary = computeEvidenceSummaryFromSources(students)
    expect(summary.main.completedCount).toBe(24)
    // 24/30 = 80% — denominator is every student, not just the ones who finished.
    expect(formatPercent(summary.main.completionPercent)).toBe('80%')
  })

  it('never lets Boss, team competition or item-modified scores into the Main knowledge average', () => {
    // mainScore is the raw individual /10. A Boss score or team modifier would have to arrive
    // through a different field — EvidenceSource simply has nowhere to put one.
    const summary = computeEvidenceSummaryFromSources([
      source({ playerId: 'a', mainScore: 8, mainAnsweredCount: 10 }),
      source({ playerId: 'b', mainScore: 6, mainAnsweredCount: 10 }),
    ])
    expect(summary.main.averageScore).toBe(7)
    expect(summary.main.totalCount).toBe(10)
    expect(Object.keys(source({ playerId: 'x' }))).not.toContain('bossScore')
    expect(Object.keys(source({ playerId: 'x' }))).not.toContain('competitionScore')
  })
})

describe('recall and survey traceability', () => {
  it('recall completion counts full 5-item participation against the class total', () => {
    const students = [
      ...Array.from({ length: 27 }, (_, i) => source({ playerId: `r-${i}`, recallCorrectCount: 4, recallAnsweredCount: RECALL_QUESTIONS.length })),
      ...Array.from({ length: 3 }, (_, i) => source({ playerId: `rp-${i}`, recallCorrectCount: 1, recallAnsweredCount: 2 })),
    ]
    const summary = computeEvidenceSummaryFromSources(students)
    expect(summary.recall.completedCount).toBe(27)
    expect(summary.recall.totalCount).toBe(5)
    expect(formatPercent(summary.recall.completionPercent)).toBe('90%')
  })

  it('only fully completed 6/6 surveys count, and completion is over the class total', () => {
    const students = [
      ...Array.from({ length: 30 }, (_, i) => source({ playerId: `s-${i}`, surveyResponses: fullSurvey() })),
      source({ playerId: 'partial', surveyResponses: fullSurvey().slice(0, 3) }),
    ]
    const summary = computeEvidenceSummaryFromSources(students)
    expect(summary.totalStudents).toBe(31)
    expect(summary.survey.completedCount).toBe(30)
    // 30/31 — the partial survey is excluded from the numerator but still a student.
    expect(formatPercent(summary.survey.completionPercent)).toBe('96.8%')
    expect(summary.survey.overallAverage).toBe(4)
  })
})

describe('history derives identical traceability metrics', () => {
  const toHistory = (players: EvidenceSource[], round = 1): RoundHistoryEntry[] =>
    players.map((player) => ({
      id: `${round}-${player.playerId}`,
      round,
      playerId: player.playerId,
      displayName: player.displayName,
      studentNumber: player.studentNumber,
      teamId: 'team-1',
      teamName: 'ทีม 1',
      knowledgeScore: player.mainScore,
      knowledgeScore100: player.mainScore * 10,
      mainAnswers: Array.from({ length: player.mainAnsweredCount }, (_, i) => ({
        questionId: `q-${i}`, selectedChoiceId: 'a', isCorrect: false,
      })),
      completedAt: 1_000,
      preTestAnswers: player.preAnswers,
      postTestAnswers: player.postAnswers,
      surveyResponses: player.surveyResponses,
      recallCorrectCount: player.recallCorrectCount,
      recallResults: Array.from({ length: player.recallAnsweredCount }, (_, i) => ({
        conceptId: `c-${i}`, answered: true, isCorrect: true,
      })),
    })) as RoundHistoryEntry[]

  it('a stored round yields the same counts and percentages as the live computation', () => {
    const live = computeEvidenceSummaryFromSources(thirtyPairedStudents())
    const stored = computeEvidenceSummaryFromHistory(toHistory(thirtyPairedStudents()))
    expect(stored.totalStudents).toBe(live.totalStudents)
    expect(stored.prePost.comparedCount).toBe(live.prePost.comparedCount)
    expect(stored.prePost.improvedCount).toBe(live.prePost.improvedCount)
    expect(stored.prePost.unchangedCount).toBe(live.prePost.unchangedCount)
    expect(stored.prePost.declinedCount).toBe(live.prePost.declinedCount)
    expect(formatPercent(stored.prePost.improvedPercent)).toBe(formatPercent(live.prePost.improvedPercent))
    expect(stored.prePost.preAverage).toBe(live.prePost.preAverage)
    expect(stored.prePost.postAverage).toBe(live.prePost.postAverage)
  })

  it('legacy rounds with no assessment data read as unavailable, never as zero', () => {
    const legacy = [{
      id: '1-legacy', round: 1, playerId: 'legacy', displayName: 'Legacy', studentNumber: '01',
      teamId: 'team-1', teamName: 'ทีม 1', knowledgeScore: 5, knowledgeScore100: 50,
      mainAnswers: [], completedAt: 1_000,
    }] as unknown as RoundHistoryEntry[]
    const summary = computeEvidenceSummaryFromHistory(legacy)
    expect(summary.prePost.comparedCount).toBe(0)
    expect(summary.prePost.improvedPercent).toBeNull()
    expect(summary.prePost.preAverage).toBeNull()
    expect(summary.students[0].preScore).toBeNull()
    expect(summary.students[0].postScore).toBeNull()
  })
})

describe('aggregate counts reconcile with the per-student table', () => {
  it('improvedCount equals the number of listed students whose post exceeds pre', () => {
    const summary = computeEvidenceSummaryFromSources(thirtyPairedStudents())
    const listedImproved = summary.students.filter(
      (student) => student.preScore !== null && student.postScore !== null && (student.postScore as number) > (student.preScore as number),
    ).length
    const listedSame = summary.students.filter(
      (student) => student.difference !== null && student.difference === 0,
    ).length
    const listedDeclined = summary.students.filter(
      (student) => student.difference !== null && (student.difference as number) < 0,
    ).length
    expect(listedImproved).toBe(summary.prePost.improvedCount)
    expect(listedSame).toBe(summary.prePost.unchangedCount)
    expect(listedDeclined).toBe(summary.prePost.declinedCount)
    expect(listedImproved + listedSame + listedDeclined).toBe(summary.prePost.comparedCount)
    // And the table itself really does hold 26 improved rows.
    expect(listedImproved).toBe(26)
  })

  it('mainCompleteCount equals the number of rows flagged ทำเกมครบ', () => {
    const students = [
      ...Array.from({ length: 24 }, (_, i) => source({ playerId: `full-${i}`, mainScore: 6, mainAnsweredCount: 10 })),
      ...Array.from({ length: 6 }, (_, i) => source({ playerId: `part-${i}`, mainScore: 2, mainAnsweredCount: 4 })),
    ]
    const summary = computeEvidenceSummaryFromSources(students)
    expect(summary.students.filter((student) => student.mainCompleted).length).toBe(summary.main.completedCount)
  })

  it('surveyCompleteCount equals the number of rows flagged ประเมินครบ', () => {
    const students = [
      ...Array.from({ length: 30 }, (_, i) => source({ playerId: `s-${i}`, surveyResponses: fullSurvey() })),
      source({ playerId: 'partial', surveyResponses: fullSurvey().slice(0, 3) }),
    ]
    const summary = computeEvidenceSummaryFromSources(students)
    expect(summary.students.filter((student) => student.surveyCompleted).length).toBe(summary.survey.completedCount)
  })
})
