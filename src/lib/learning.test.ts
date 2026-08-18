import { describe, expect, it } from 'vitest'
import { questions } from '../data/questions'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { computeClassRecallSummary, computeStudentRecallResult } from './learning'
import type { Player, RecallAnswerRecord } from '../types/game'

const makeRecallAnswer = (conceptId: string, isCorrect: boolean): RecallAnswerRecord => ({
  conceptId,
  selectedChoiceId: isCorrect ? 'x-correct' : 'x-wrong',
  isCorrect,
  answeredAt: 0,
})

type RecallPlayer = Pick<Player, 'recallAnswers'>

const makeRecallPlayer = (recallAnswers: RecallAnswerRecord[]): RecallPlayer => ({ recallAnswers })

// Data-integrity guard: every Recall item previously had its correct answer in position A, so
// "tap ก. five times" scored 5/5 and the review result measured nothing.
describe('Story Recall answer positions', () => {
  it('does not place every correct answer in the same choice position', () => {
    const positions = RECALL_QUESTIONS.map((question) => question.choices.findIndex((choice) => choice.id === question.correctChoiceId))
    // Every correct answer must actually exist among that question's choices.
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(new Set(positions).size).toBeGreaterThan(1)
  })

  // Main is four-option, so "never C or D" would still let a student who only ever guesses among
  // the first two options score ~50% instead of 25%. Every position must actually be used.
  it('spreads Main correct answers across all four choice positions', () => {
    const positions = questions.map((question) => question.choices.findIndex((choice) => choice.id === question.correctChoiceId))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(questions.every((question) => question.choices.length === 4)).toBe(true)
    expect(new Set(positions).size).toBe(4)
    // No single position may dominate the ten-question bank.
    const maxUses = Math.max(...[0, 1, 2, 3].map((slot) => positions.filter((position) => position === slot).length))
    expect(maxUses).toBeLessThanOrEqual(4)
  })
})

describe('computeStudentRecallResult', () => {
  it('counts only the review answers — a perfect review is correctCount === totalCount', () => {
    const player = makeRecallPlayer(RECALL_QUESTIONS.map((question) => makeRecallAnswer(question.id, true)))
    const result = computeStudentRecallResult(player)
    expect(result.correctCount).toBe(RECALL_QUESTIONS.length)
    expect(result.totalCount).toBe(RECALL_QUESTIONS.length)
    expect(result.answeredCount).toBe(RECALL_QUESTIONS.length)
  })

  it('a student who answered nothing scores 0 and never crashes on missing records', () => {
    const result = computeStudentRecallResult(makeRecallPlayer([]))
    expect(result.correctCount).toBe(0)
    expect(result.answeredCount).toBe(0)
    expect(result.totalCount).toBe(RECALL_QUESTIONS.length)
  })

  it('distinguishes unanswered from answered-incorrectly', () => {
    const [first, second] = RECALL_QUESTIONS
    const result = computeStudentRecallResult(makeRecallPlayer([
      makeRecallAnswer(first.id, true),
      makeRecallAnswer(second.id, false),
    ]))
    expect(result.correctCount).toBe(1)
    expect(result.answeredCount).toBe(2)
  })

  // The core guarantee of this milestone: the review result is computed from recallAnswers ALONE.
  // Main answers are not an input, so no before/after or gain figure can be produced here.
  it('never reads the main-game answers — recall is not a baseline for anything', () => {
    const recallAnswers = RECALL_QUESTIONS.map((question) => makeRecallAnswer(question.id, false))
    const withoutMain = computeStudentRecallResult({ recallAnswers })
    // A player object carrying main answers cannot change the result: the function's own
    // parameter type admits only recallAnswers.
    expect(withoutMain.correctCount).toBe(0)
    expect(Object.keys(withoutMain)).toEqual(['correctCount', 'totalCount', 'answeredCount'])
  })
})

describe('computeClassRecallSummary', () => {
  it('aggregates review correctness per concept across the class', () => {
    const conceptA = RECALL_QUESTIONS[0]
    const conceptB = RECALL_QUESTIONS[1]
    const players: RecallPlayer[] = [
      makeRecallPlayer([makeRecallAnswer(conceptA.id, true)]),
      makeRecallPlayer([makeRecallAnswer(conceptA.id, false)]),
    ]
    const summary = computeClassRecallSummary(players)
    expect(summary.concepts.find((concept) => concept.conceptId === conceptA.id))
      .toMatchObject({ recallCorrectCount: 1, totalStudents: 2 })
    expect(summary.concepts.find((concept) => concept.conceptId === conceptB.id))
      .toMatchObject({ recallCorrectCount: 0, totalStudents: 2 })
  })

  it('averages correct items per student', () => {
    const [first, second] = RECALL_QUESTIONS
    const players: RecallPlayer[] = [
      makeRecallPlayer([makeRecallAnswer(first.id, true), makeRecallAnswer(second.id, true)]),
      makeRecallPlayer([makeRecallAnswer(first.id, true)]),
    ]
    // 3 correct items across 2 students.
    expect(computeClassRecallSummary(players).averageCorrectCount).toBeCloseTo(1.5, 5)
  })

  it('an empty class never crashes — 0 average, no strongest/weakest concept', () => {
    const summary = computeClassRecallSummary([])
    expect(summary.averageCorrectCount).toBe(0)
    expect(summary.strongestConceptId).toBeNull()
    expect(summary.weakestConceptId).toBeNull()
  })

  it('ranks strongest/weakest by review accuracy alone', () => {
    const [strong, weak, ...rest] = RECALL_QUESTIONS
    const players: RecallPlayer[] = [
      makeRecallPlayer([
        makeRecallAnswer(strong.id, true),
        makeRecallAnswer(weak.id, false),
        ...rest.map((question) => makeRecallAnswer(question.id, false)),
      ]),
    ]
    const summary = computeClassRecallSummary(players)
    expect(summary.strongestConceptId).toBe(strong.id)
    expect(summary.weakestConceptId).toBe(weak.id)
  })
})
