import { describe, expect, it } from 'vitest'
import { POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { SURVEY_ITEMS } from '../data/surveyItems'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { computeEvidenceSummary, computeEvidenceSummaryFromHistory } from './evidenceSummary'
import { buildRoundHistoryEntry } from './roundHistory'
import type { Player } from '../types/game'

// Answers the first `correctCount` items correctly and the next `wrongCount` incorrectly, leaving
// the rest unanswered — so a test can be finished-and-scored, or deliberately left partial.
const assessmentAnswers = (
  bank: typeof PRE_TEST_QUESTIONS,
  correctCount: number,
  wrongCount = bank.length - correctCount,
): Array<{ questionId: string; selectedChoiceId: string; answeredAt: number }> =>
  bank.slice(0, correctCount + wrongCount).map((question, index) => ({
    questionId: question.id,
    selectedChoiceId: index < correctCount
      ? question.correctChoiceId
      : question.choices.find((choice) => choice.id !== question.correctChoiceId)?.id ?? '',
    answeredAt: 0,
  }))

const makePlayer = (overrides: Partial<Player> & { id: string }): Player => ({
  displayName: `นักเรียน ${overrides.id}`,
  studentNumber: overrides.id,
  teamId: null,
  joinedAt: 0,
  currentRound: 1,
  currentQuestionIndex: 0,
  score: 0,
  answers: [],
  bossAnswers: [],
  recallAnswers: [],
  preTestAnswers: [],
  postTestAnswers: [],
  surveyResponses: [],
  submitted: true,
  finishedAt: null,
  elapsedMs: null,
  status: 'submitted',
  ownerUid: 'uid',
  ...overrides,
})

describe('computeEvidenceSummary', () => {
  it('an empty class produces zeroes everywhere and never divides by zero', () => {
    const summary = computeEvidenceSummary([])
    expect(summary.totalStudents).toBe(0)
    expect(summary.prePost.comparedCount).toBe(0)
    expect(summary.prePost.preAverage).toBe(0)
    expect(summary.prePost.improvedPercent).toBe(0)
    expect(summary.main.averageScore).toBe(0)
    expect(summary.recall.averageCorrect).toBe(0)
    expect(summary.survey.overallAverage).toBe(0)
    expect(summary.students).toEqual([])
  })

  // The core guarantee: a student who did not finish BOTH tests is excluded from the comparison
  // rather than counted as zero, which would invent a drop that never happened.
  it('compares only students who completed both tests, and reports the others as "-"', () => {
    const both = makePlayer({
      id: '01',
      preTestAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 4),
      postTestAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 7),
    })
    // Pre only — post left partial, so this student cannot be compared.
    const preOnly = makePlayer({
      id: '02',
      preTestAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 9),
      postTestAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 2, 1),
    })
    const neither = makePlayer({ id: '03' })

    const summary = computeEvidenceSummary([both, preOnly, neither])
    expect(summary.totalStudents).toBe(3)
    expect(summary.prePost.comparedCount).toBe(1)
    expect(summary.prePost.preAverage).toBe(4)
    expect(summary.prePost.postAverage).toBe(7)
    expect(summary.prePost.averageDifference).toBe(3)

    const rows = new Map(summary.students.map((student) => [student.playerId, student]))
    expect(rows.get('01')).toMatchObject({ preScore: 4, postScore: 7, difference: 3 })
    expect(rows.get('02')).toMatchObject({ preScore: 9, postScore: null, difference: null })
    expect(rows.get('03')).toMatchObject({ preScore: null, postScore: null, difference: null })
  })

  it('counts higher / equal / lower after-versus-before, with the percentage over compared students', () => {
    const up = makePlayer({
      id: '01',
      preTestAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 3),
      postTestAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 8),
    })
    const same = makePlayer({
      id: '02',
      preTestAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 5),
      postTestAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 5),
    })
    const down = makePlayer({
      id: '03',
      preTestAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 6),
      postTestAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 2),
    })
    const summary = computeEvidenceSummary([up, same, down])
    expect(summary.prePost).toMatchObject({ comparedCount: 3, improvedCount: 1, unchangedCount: 1, declinedCount: 1 })
    expect(summary.prePost.improvedPercent).toBeCloseTo(33.333, 2)
    // (5 + 0 + -4) / 3
    expect(summary.prePost.averageDifference).toBeCloseTo(1 / 3, 5)
  })

  it('scores pre/post from the bank, never from what the client submitted', () => {
    // Every answer names a real question but picks a wrong choice, so a bank-derived score is 0.
    const guessing = makePlayer({
      id: '01',
      preTestAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 0),
      postTestAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 0),
    })
    const summary = computeEvidenceSummary([guessing])
    expect(summary.prePost.comparedCount).toBe(1)
    expect(summary.prePost.preAverage).toBe(0)
    expect(summary.prePost.postAverage).toBe(0)
  })

  it('reports Main average and completion over every student', () => {
    const finished = makePlayer({
      id: '01',
      score: 8,
      answers: Array.from({ length: 10 }, (_, index) => ({
        questionId: `main-${index}`, selectedChoiceId: 'x', isCorrect: index < 8, answeredAt: 0, responseTimeMs: 0,
      })),
    })
    const partial = makePlayer({
      id: '02',
      score: 2,
      answers: Array.from({ length: 4 }, (_, index) => ({
        questionId: `main-${index}`, selectedChoiceId: 'x', isCorrect: index < 2, answeredAt: 0, responseTimeMs: 0,
      })),
    })
    const summary = computeEvidenceSummary([finished, partial])
    expect(summary.main.averageScore).toBe(5)
    expect(summary.main.completedCount).toBe(1)
    expect(summary.main.totalStudents).toBe(2)
  })

  it('reports Recall entirely on its own, with its own completion denominator', () => {
    const done = makePlayer({
      id: '01',
      recallAnswers: RECALL_QUESTIONS.map((question, index) => ({
        conceptId: question.id, selectedChoiceId: 'x', isCorrect: index < 4, answeredAt: 0,
      })),
    })
    const partial = makePlayer({
      id: '02',
      recallAnswers: RECALL_QUESTIONS.slice(0, 2).map((question) => ({
        conceptId: question.id, selectedChoiceId: 'x', isCorrect: true, answeredAt: 0,
      })),
    })
    const summary = computeEvidenceSummary([done, partial])
    // 4 correct + 2 correct over 2 students.
    expect(summary.recall.averageCorrect).toBe(3)
    expect(summary.recall.completedCount).toBe(1)
    expect(summary.recall.totalCount).toBe(RECALL_QUESTIONS.length)
  })

  // Satisfaction is reported from finished surveys only. A student who quit after item 1 is
  // excluded entirely — otherwise their single answer would weight item 1 more than items 2-6.
  it('averages survey responses over COMPLETED surveys only, per item and overall', () => {
    const full = makePlayer({
      id: '01',
      surveyResponses: SURVEY_ITEMS.map((item) => ({ itemId: item.id, value: '5', answeredAt: 0 })),
    })
    const partial = makePlayer({
      id: '02',
      surveyResponses: [{ itemId: SURVEY_ITEMS[0].id, value: '1', answeredAt: 0 }],
    })
    const summary = computeEvidenceSummary([full, partial])
    // Completion is still reported against the whole class.
    expect(summary.survey.completedCount).toBe(1)
    expect(summary.survey.totalStudents).toBe(2)
    // Only the finished survey's 6 responses count.
    expect(summary.survey.responseCount).toBe(6)
    expect(summary.survey.overallAverage).toBe(5)
    const first = summary.survey.items.find((item) => item.itemId === SURVEY_ITEMS[0].id)
    const second = summary.survey.items.find((item) => item.itemId === SURVEY_ITEMS[1].id)
    // The abandoned "1" is absent from item 1: it neither lowers the average nor is counted.
    expect(first).toMatchObject({ average: 5, responseCount: 1 })
    expect(second).toMatchObject({ average: 5, responseCount: 1 })
  })

  // The durability guarantee: a snapshot taken before the reset must reproduce the same evidence
  // after the live arrays are wiped.
  it('history reproduces the same evidence after prepareNextRound wipes the live players', () => {
    const player = makePlayer({
      id: '01',
      score: 7,
      answers: Array.from({ length: 10 }, (_, index) => ({
        questionId: `main-${index}`, selectedChoiceId: 'x', isCorrect: index < 7, answeredAt: 0, responseTimeMs: 0,
      })),
      recallAnswers: RECALL_QUESTIONS.map((question, index) => ({
        conceptId: question.id, selectedChoiceId: 'x', isCorrect: index < 3, answeredAt: 0,
      })),
      preTestAnswers: assessmentAnswers(PRE_TEST_QUESTIONS, 4),
      postTestAnswers: assessmentAnswers(POST_TEST_QUESTIONS, 9),
      surveyResponses: SURVEY_ITEMS.map((item) => ({ itemId: item.id, value: '4', answeredAt: 0 })),
    })

    const live = computeEvidenceSummary([player])
    // The service snapshots BEFORE resetting, so history is built from the intact player.
    const entry = buildRoundHistoryEntry(player, 1, 'ทีมทดสอบ', 1_000)

    // prepareNextRound's reset: every round-scoped array wiped, score zeroed.
    const reset = makePlayer({ id: '01' })
    expect(computeEvidenceSummary([reset]).prePost.comparedCount).toBe(0)

    // ...but the stored round still reports exactly what it did before the reset.
    const fromHistory = computeEvidenceSummaryFromHistory([entry])
    expect(fromHistory.prePost).toMatchObject({
      comparedCount: live.prePost.comparedCount,
      preAverage: live.prePost.preAverage,
      postAverage: live.prePost.postAverage,
      averageDifference: live.prePost.averageDifference,
      improvedCount: live.prePost.improvedCount,
    })
    expect(fromHistory.main.averageScore).toBe(live.main.averageScore)
    expect(fromHistory.main.completedCount).toBe(live.main.completedCount)
    expect(fromHistory.recall.averageCorrect).toBe(live.recall.averageCorrect)
    expect(fromHistory.recall.completedCount).toBe(live.recall.completedCount)
    expect(fromHistory.survey.overallAverage).toBe(live.survey.overallAverage)
    expect(fromHistory.survey.completedCount).toBe(live.survey.completedCount)
    expect(fromHistory.students[0]).toMatchObject({ preScore: 4, postScore: 9, difference: 5 })
  })

  // Rounds recorded before the assessment layer have none of these fields.
  it('a legacy history row without Pre/Post/Survey reads as unavailable, never as zero performance', () => {
    const legacy = {
      id: '1-99',
      round: 1,
      playerId: '99',
      displayName: 'นักเรียนเก่า',
      studentNumber: '99',
      teamId: null,
      teamName: 'ทีมเก่า',
      // Legacy Recall-vs-Main fields only; no recallResults, no pre/post/survey.
      beforeCorrectCount: 2,
      afterCorrectCount: 4,
      knowledgeScore: 6,
      knowledgeScore100: 60,
      mainAnswers: Array.from({ length: 10 }, (_, index) => ({ questionId: `main-${index}`, isCorrect: index < 6 })),
      completedAt: 0,
    }
    const summary = computeEvidenceSummaryFromHistory([legacy])
    expect(summary.totalStudents).toBe(1)
    // No pre/post data at all -> excluded from the comparison rather than scored 0.
    expect(summary.prePost.comparedCount).toBe(0)
    expect(summary.students[0]).toMatchObject({ preScore: null, postScore: null, difference: null })
    // Main still reads, and the legacy recall count is used rather than showing a blank.
    expect(summary.main.averageScore).toBe(6)
    expect(summary.main.completedCount).toBe(1)
    expect(summary.recall.averageCorrect).toBe(2)
    // Per-item recall detail never existed for this row, so completion is unknown -> not counted.
    expect(summary.recall.completedCount).toBe(0)
    expect(summary.survey.responseCount).toBe(0)
  })

  it('a class where nobody finished the survey reports no satisfaction figures at all', () => {
    const partialA = makePlayer({
      id: '01',
      surveyResponses: SURVEY_ITEMS.slice(0, 5).map((item) => ({ itemId: item.id, value: '1', answeredAt: 0 })),
    })
    const partialB = makePlayer({
      id: '02',
      surveyResponses: [{ itemId: SURVEY_ITEMS[0].id, value: '2', answeredAt: 0 }],
    })
    const summary = computeEvidenceSummary([partialA, partialB])
    expect(summary.survey.completedCount).toBe(0)
    expect(summary.survey.responseCount).toBe(0)
    expect(summary.survey.overallAverage).toBe(0)
    expect(summary.survey.items.every((item) => item.responseCount === 0 && item.average === 0)).toBe(true)
  })

  it('an item nobody answered reports 0 responses rather than a fabricated average', () => {
    const summary = computeEvidenceSummary([makePlayer({ id: '01' })])
    expect(summary.survey.items.every((item) => item.responseCount === 0 && item.average === 0)).toBe(true)
    expect(summary.survey.overallAverage).toBe(0)
  })
})
