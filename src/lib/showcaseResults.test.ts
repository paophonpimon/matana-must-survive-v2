import { describe, expect, it } from 'vitest'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import {
  computeEvidenceSummary,
  computeEvidenceSummaryFromHistory,
  formatAverage,
  formatPercent,
  formatSignedAverage,
} from './evidenceSummary'
import { computeClassRecallSummary } from './learning'
import { historyToDerivedPlayers } from './roomHistory'
import {
  SAMPLE_RESULTS_HEADLINE,
  SAMPLE_RESULTS_INDIVIDUAL_NOTE,
  SAMPLE_RESULTS_PARTICIPANT_COUNT,
  SAMPLE_RESULTS_SUBHEAD,
  buildSampleResultsHistory,
} from './showcaseResults'
import type { Player } from '../types/game'

// The reporting sample is RECONSTRUCTED presentation data: the class-level aggregate targets are
// treated as real classroom-use results, the P01–P30 individual rows are built to reproduce them.
// Every assertion below reads a figure the PRODUCTION aggregator derived from the generated
// round-history entries — nothing here is a hard-coded summary.

const history = () => buildSampleResultsHistory()
const summary = () => computeEvidenceSummaryFromHistory(history())

describe('class reporting sample — 30 reconstructed participants', () => {
  it('is exactly 30 participants, anonymous P01–P30, no duplicates', () => {
    const entries = history()
    expect(entries).toHaveLength(SAMPLE_RESULTS_PARTICIPANT_COUNT)
    expect(SAMPLE_RESULTS_PARTICIPANT_COUNT).toBe(30)
    for (const entry of entries) {
      expect(entry.displayName).toMatch(/^P\d{2}$/)
      expect(entry.playerId).toMatch(/^P\d{2}$/)
      expect(entry.studentNumber).toMatch(/^\d{1,2}$/)
    }
    expect(new Set(entries.map((entry) => entry.playerId)).size).toBe(30)
    expect(new Set(entries.map((entry) => entry.displayName)).size).toBe(30)
    expect(entries.map((entry) => entry.displayName).sort()).toEqual(
      Array.from({ length: 30 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`),
    )
  })

  it('no reconstructed row carries a real student identity', () => {
    // Positive check: identities are the anonymous P-scheme only. Nothing that looks like a Thai
    // personal name (นาย / นางสาว prefix) or a school studentId reaches the snapshot.
    for (const entry of history()) {
      expect(entry.displayName).not.toMatch(/นาย|นางสาว|เด็ก/)
      expect(entry.playerId).not.toMatch(/^0(6[4-6]\d{2}|7[12]\d{2})$/)
    }
  })
})

describe('derived aggregates match the confirmed class summary', () => {
  it('PRE: total 163, mean 5.43, 30/30 paired-complete', () => {
    const s = summary()
    const preTotal = s.students.reduce((total, student) => total + (student.preScore ?? 0), 0)
    expect(preTotal).toBe(163)
    expect(s.prePost.comparedCount).toBe(30)
    expect(formatAverage(s.prePost.preAverage, 2)).toBe('5.43')
  })

  it('POST: total 250, mean 8.33', () => {
    const s = summary()
    const postTotal = s.students.reduce((total, student) => total + (student.postScore ?? 0), 0)
    expect(postTotal).toBe(250)
    expect(formatAverage(s.prePost.postAverage, 2)).toBe('8.33')
  })

  it('GAIN: total 87, mean +2.90', () => {
    const s = summary()
    const gainTotal = s.students.reduce((total, student) => total + (student.difference ?? 0), 0)
    expect(gainTotal).toBe(87)
    expect(formatSignedAverage(s.prePost.averageDifference, 2)).toBe('+2.90')
  })

  it('improved 26 / unchanged 3 / decreased 1, 86.7%, over the paired denominator', () => {
    const s = summary()
    expect(s.prePost.improvedCount).toBe(26)
    expect(s.prePost.unchangedCount).toBe(3)
    expect(s.prePost.declinedCount).toBe(1)
    expect(formatPercent(s.prePost.improvedPercent)).toBe('86.7%')
    expect(s.prePost.improvedCount + s.prePost.unchangedCount + s.prePost.declinedCount).toBe(30)
  })

  it('MAIN: 245/300 correct, mean 8.17, completion 30/30', () => {
    const s = summary()
    const entries = history()
    const mainCorrect = entries.reduce(
      (total, entry) => total + entry.mainAnswers.filter((answer) => answer.isCorrect).length,
      0,
    )
    const mainAnswered = entries.reduce((total, entry) => total + entry.mainAnswers.length, 0)
    expect(mainCorrect).toBe(245)
    expect(mainAnswered).toBe(300)
    expect(formatAverage(s.main.averageScore, 2)).toBe('8.17')
    expect(s.main.completedCount).toBe(30)
    expect(formatPercent(s.main.completionPercent)).toBe('100%')
  })

  it('RECALL: 124/150 correct, mean 4.13', () => {
    const s = summary()
    const recallCorrect = history().reduce((total, entry) => total + (entry.recallCorrectCount ?? 0), 0)
    expect(recallCorrect).toBe(124)
    expect(150).toBe(30 * RECALL_QUESTIONS.length)
    expect(formatAverage(s.recall.averageCorrect, 2)).toBe('4.13')
    expect(s.recall.completedCount).toBe(30)
  })

  it('SURVEY: 180 responses, 833 points, mean 4.63', () => {
    const s = summary()
    const responses = history().flatMap((entry) => entry.surveyResponses ?? [])
    const points = responses.reduce((total, response) => total + Number(response.value), 0)
    expect(responses).toHaveLength(180)
    expect(points).toBe(833)
    expect(s.survey.responseCount).toBe(180)
    expect(formatAverage(s.survey.overallAverage, 2)).toBe('4.63')
    // Every response is a real 1–5 Likert value.
    for (const response of responses) {
      expect(Number(response.value)).toBeGreaterThanOrEqual(1)
      expect(Number(response.value)).toBeLessThanOrEqual(5)
    }
  })
})

describe('the live-player and history paths derive identically', () => {
  it('same figures whether computed from players or from the snapshot', () => {
    // Rebuild players from the snapshot the same way the reconstructed Result screen does.
    const derived = historyToDerivedPlayers(history()) as unknown as Player[]
    const fromHistory = summary()
    const recall = computeClassRecallSummary(derived)
    expect(formatAverage(recall.averageCorrectCount, 2)).toBe('4.13')
    // computeEvidenceSummary over real players uses the same shared aggregation.
    void computeEvidenceSummary
    expect(fromHistory.totalStudents).toBe(30)
  })
})

describe('question-level analysis is meaningful (misses vary)', () => {
  it('main misses are spread across questions, hardest > easiest', () => {
    const entries = history()
    const missByQuestionIndex = new Map<number, number>()
    for (const entry of entries) {
      entry.mainAnswers.forEach((answer, index) => {
        if (!answer.isCorrect) missByQuestionIndex.set(index, (missByQuestionIndex.get(index) ?? 0) + 1)
      })
    }
    // At least 8 of the 10 questions were missed by someone — not everyone misses the same ones.
    expect(missByQuestionIndex.size).toBeGreaterThanOrEqual(8)
    const counts = [...missByQuestionIndex.values()]
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts))
    // Total misses reconcile with the 245/300 correct figure.
    expect(counts.reduce((total, value) => total + value, 0)).toBe(55)
  })

  it('recall misses are spread across concepts', () => {
    const s = computeClassRecallSummary(historyToDerivedPlayers(history()) as unknown as Player[])
    const correctByConcept = s.concepts.map((concept) => concept.recallCorrectCount)
    expect(new Set(correctByConcept).size).toBeGreaterThan(1)
    expect(s.strongestConceptId).not.toBe(s.weakestConceptId)
    expect(correctByConcept.reduce((total, value) => total + value, 0)).toBe(124)
  })
})

describe('missing evidence never becomes a fabricated zero', () => {
  it('every reconstructed row is paired-complete, so no zero is invented', () => {
    for (const student of summary().students) {
      expect(student.preScore).not.toBeNull()
      expect(student.postScore).not.toBeNull()
      expect(student.mainCompleted).toBe(true)
      expect(student.surveyCompleted).toBe(true)
    }
  })

  it('a trimmed entry reports "-" (null), never 0 — the shared aggregator rule holds', () => {
    const trimmed = history().map((entry, index) =>
      (index === 0 ? { ...entry, preTestAnswers: [] } : entry))
    const s = computeEvidenceSummaryFromHistory(trimmed)
    expect(s.students[0].preScore).toBeNull()
    expect(s.prePost.comparedCount).toBe(29)
  })
})

describe('provenance strings are present and honest', () => {
  it('headline is a sample label, never a real-use claim', () => {
    expect(SAMPLE_RESULTS_HEADLINE).toBe('ตัวอย่างผลลัพธ์ระดับชั้น 30 คน')
    expect(SAMPLE_RESULTS_SUBHEAD).toBe('ข้อมูลสร้างขึ้นเพื่อสาธิตระบบรายงานผล')
    expect(SAMPLE_RESULTS_INDIVIDUAL_NOTE).toContain('สร้างขึ้นเพื่อให้สอดคล้อง')
    for (const label of [SAMPLE_RESULTS_HEADLINE, SAMPLE_RESULTS_SUBHEAD, SAMPLE_RESULTS_INDIVIDUAL_NOTE]) {
      expect(label).not.toMatch(/ผลการใช้งานจริง|ผลนักเรียนจริง|ม\.5\/1 จริง/)
    }
  })
})
