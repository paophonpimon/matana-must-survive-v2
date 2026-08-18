import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { computeEvidenceSummaryFromHistory } from './evidenceSummary'
import { buildXlsx, type SheetData } from './xlsx'
import type { RoundHistoryEntry } from '../types/game'

// Spreadsheet export of the teacher's round history. Deliberately split into pure row-building
// (testable without touching the DOM or the zip layer) and a thin browser download trigger.
//
// Column headings are plain classroom Thai on purpose — no Baseline / In-game Evidence /
// Learning Gain / conceptId / "Main" leaking into a teacher-facing file.

const MAIN_QUESTION_COUNT = 10

const yesNo = (value: boolean): string => (value ? 'ถูก' : 'ผิด')

export const buildStudentSummarySheet = (entries: RoundHistoryEntry[]): SheetData => ({
  name: 'สรุปนักเรียน',
  rows: [
    ['ชื่อ', 'เลขที่', 'รอบ', 'ทีม', 'ผลการทบทวน', 'ผลการเล่นเกมหลัก /100'],
    ...entries.map((entry) => [
      entry.displayName,
      entry.studentNumber,
      entry.round,
      entry.teamName,
      entry.recallCorrectCount ?? entry.beforeCorrectCount ?? 0,
      entry.knowledgeScore100,
    ] as (string | number)[]),
  ],
})

export const buildPerQuestionSheet = (entries: RoundHistoryEntry[]): SheetData => {
  // Review items and main questions are listed as two separate groups of columns — never paired
  // into a before/after column per concept.
  const conceptColumns = RECALL_QUESTIONS.map((question) => `ทบทวน: ${question.label}`)
  const mainColumns = Array.from({ length: MAIN_QUESTION_COUNT }, (_, index) => `ข้อ ${index + 1}`)
  return {
    name: 'รายละเอียดรายข้อ',
    rows: [
      ['ชื่อ', 'เลขที่', 'รอบ', ...conceptColumns, ...mainColumns],
      ...entries.map((entry) => {
        // New rounds carry durable per-item review detail in recallResults. Older rounds have
        // only the legacy conceptResults block, whose beforeCorrect field held the same review
        // correctness — read as a fallback so historical exports keep their per-item cells. A
        // round with neither reads '-' rather than a fabricated ผิด.
        const recallByConcept = new Map((entry.recallResults ?? []).map((result) => [result.conceptId, result]))
        const legacyByConcept = new Map((entry.conceptResults ?? []).map((result) => [result.conceptId, result]))
        const conceptCells = RECALL_QUESTIONS.map((question) => {
          const result = recallByConcept.get(question.id)
          if (result) return result.answered ? yesNo(result.isCorrect) : 'ไม่ได้ตอบ'
          const legacy = legacyByConcept.get(question.id)
          return legacy ? yesNo(legacy.beforeCorrect) : '-'
        })
        // Main answers are stored in answer order; a question the student never reached simply
        // has no record, which reads as "ไม่ได้ตอบ" rather than being silently counted wrong.
        const mainCells = Array.from({ length: MAIN_QUESTION_COUNT }, (_, index) => {
          const answer = entry.mainAnswers[index]
          return answer ? yesNo(answer.isCorrect) : 'ไม่ได้ตอบ'
        })
        return [entry.displayName, entry.studentNumber, entry.round, ...conceptCells, ...mainCells] as (string | number)[]
      }),
    ],
  }
}

export const buildClassSummarySheet = (entries: RoundHistoryEntry[]): SheetData => {
  const rounds = [...new Set(entries.map((entry) => entry.round))].sort((a, b) => a - b)
  const average = (values: number[]): number =>
    (values.length === 0 ? 0 : Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100)

  return {
    name: 'สรุปชั้นเรียน',
    rows: [
      ['รอบ', 'จำนวนนักเรียน', 'ผลการทบทวน (เฉลี่ย)', 'ผลการเล่นเกมหลัก (เฉลี่ย /100)'],
      // Two independent class averages per round: how the review went, and how the main game
      // went. They are never differenced, ranked against each other, or labelled before/after.
      ...rounds.map((round) => {
        const roundEntries = entries.filter((entry) => entry.round === round)
        return [
          round,
          roundEntries.length,
          average(roundEntries.map((entry) => entry.recallCorrectCount ?? entry.beforeCorrectCount ?? 0)),
          average(roundEntries.map((entry) => entry.knowledgeScore100)),
        ] as (string | number)[]
      }),
    ],
  }
}


// --- Evidence sheets ---
// All three are computed by computeEvidenceSummaryFromHistory, the SAME function the teacher's
// on-screen panel and the printed report use. There is deliberately no second implementation of
// any denominator here: a formula defined once cannot drift between the screen and the file.
//
// Rounds are summarised independently, since each is its own measurement occasion.

const roundsOf = (entries: RoundHistoryEntry[]): number[] =>
  [...new Set(entries.map((entry) => entry.round))].sort((a, b) => a - b)

const round2 = (value: number): number => Math.round(value * 100) / 100

export const buildEvidenceSummarySheet = (entries: RoundHistoryEntry[]): SheetData => ({
  name: 'สรุปหลักฐาน',
  rows: [
    [
      'รอบ', 'นักเรียนทั้งหมด',
      'เทียบก่อน/หลังได้ (คน)', 'ก่อนเรียน เฉลี่ย /10', 'หลังเรียน เฉลี่ย /10', 'ผลต่างเฉลี่ย',
      'หลังสูงกว่าก่อน (คน)', 'หลังสูงกว่าก่อน (%)', 'เท่าเดิม (คน)', 'ต่ำกว่า (คน)',
      'เกมหลัก เฉลี่ย /10', 'เกมหลักครบ 10 ข้อ (คน)',
      'ผลการทบทวน เฉลี่ย /5', 'ทบทวนครบ 5 ข้อ (คน)',
      'ทำแบบประเมินครบ (คน)', 'ความพึงพอใจเฉลี่ย /5',
    ],
    ...roundsOf(entries).map((round) => {
      const summary = computeEvidenceSummaryFromHistory(entries.filter((entry) => entry.round === round))
      return [
        round,
        summary.totalStudents,
        summary.prePost.comparedCount,
        round2(summary.prePost.preAverage),
        round2(summary.prePost.postAverage),
        round2(summary.prePost.averageDifference),
        summary.prePost.improvedCount,
        round2(summary.prePost.improvedPercent),
        summary.prePost.unchangedCount,
        summary.prePost.declinedCount,
        round2(summary.main.averageScore),
        summary.main.completedCount,
        round2(summary.recall.averageCorrect),
        summary.recall.completedCount,
        summary.survey.completedCount,
        round2(summary.survey.overallAverage),
      ] as (string | number)[]
    }),
  ],
})

export const buildStudentEvidenceSheet = (entries: RoundHistoryEntry[]): SheetData => ({
  name: 'รายบุคคล (หลักฐาน)',
  rows: [
    ['รอบ', 'ชื่อ', 'เลขที่', 'ก่อนเรียน /10', 'หลังเรียน /10', 'ผลต่าง', 'เกมหลัก /10', 'ทำเกมครบ', 'ประเมินครบ'],
    ...roundsOf(entries).flatMap((round) => {
      const summary = computeEvidenceSummaryFromHistory(entries.filter((entry) => entry.round === round))
      return summary.students.map((student) => [
        round,
        student.displayName,
        student.studentNumber,
        // An unfinished test has no comparable score, so it exports as "-" rather than a number
        // that would read as a real result.
        student.preScore === null ? '-' : student.preScore,
        student.postScore === null ? '-' : student.postScore,
        student.difference === null ? '-' : student.difference,
        student.mainScore,
        student.mainCompleted ? 'ครบ' : `${student.mainAnsweredCount}/10`,
        student.surveyCompleted ? 'ครบ' : `${student.surveyAnsweredCount}/6`,
      ] as (string | number)[])
    }),
  ],
})

export const buildSurveyItemSheet = (entries: RoundHistoryEntry[]): SheetData => ({
  name: 'แบบประเมินรายข้อ',
  rows: [
    ['รอบ', 'ข้อ', 'ข้อความ', 'ค่าเฉลี่ย /5', 'จำนวนผู้ตอบ (ทำครบ)'],
    ...roundsOf(entries).flatMap((round) => {
      const summary = computeEvidenceSummaryFromHistory(entries.filter((entry) => entry.round === round))
      return summary.survey.items.map((item, index) => [
        round,
        index + 1,
        item.statement,
        // Only completed surveys contribute; an item with no responses exports "-".
        item.responseCount === 0 ? '-' : round2(item.average),
        item.responseCount,
      ] as (string | number)[])
    }),
  ],
})

export const buildLearningWorkbook = (entries: RoundHistoryEntry[]): Uint8Array => {
  const ordered = [...entries].sort((a, b) => a.round - b.round || a.studentNumber.localeCompare(b.studentNumber))
  return buildXlsx([
    // Existing Main/Recall sheets keep their original positions so anything already reading
    // sheet 1-3 is unaffected; the evidence sheets are appended after them.
    buildStudentSummarySheet(ordered),
    buildPerQuestionSheet(ordered),
    buildClassSummarySheet(ordered),
    buildEvidenceSummarySheet(ordered),
    buildStudentEvidenceSheet(ordered),
    buildSurveyItemSheet(ordered),
  ])
}

// Browser-only download trigger, kept out of the pure builders above so those stay testable.
export const downloadLearningWorkbook = (entries: RoundHistoryEntry[], roomCode: string): void => {
  const bytes = buildLearningWorkbook(entries)
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `ผลการเรียน-${roomCode}.xlsx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
