import { RECALL_QUESTIONS, recallQuestionsById } from '../data/recallQuestions'
import { buildXlsx, type SheetData } from './xlsx'
import type { RoundHistoryEntry } from '../types/game'

// Spreadsheet export of the teacher's round history. Deliberately split into pure row-building
// (testable without touching the DOM or the zip layer) and a thin browser download trigger.
//
// Column headings are plain classroom Thai on purpose — no Baseline / In-game Evidence /
// Learning Gain / conceptId / "Main" leaking into a teacher-facing file.

const MAIN_QUESTION_COUNT = 10

const conceptLabel = (conceptId: string): string => recallQuestionsById.get(conceptId)?.label ?? conceptId

const yesNo = (value: boolean): string => (value ? 'ถูก' : 'ผิด')

export const buildStudentSummarySheet = (entries: RoundHistoryEntry[]): SheetData => ({
  name: 'สรุปนักเรียน',
  rows: [
    ['ชื่อ', 'เลขที่', 'รอบ', 'ทีม', 'ก่อนเล่น', 'หลังเล่น', 'เข้าใจเพิ่มขึ้นกี่เรื่อง', 'ควรทบทวนกี่เรื่อง', 'คะแนนความรู้ /100'],
    ...entries.map((entry) => [
      entry.displayName,
      entry.studentNumber,
      entry.round,
      entry.teamName,
      entry.beforeCorrectCount,
      entry.afterCorrectCount,
      entry.improvedCount,
      entry.reviewCount,
      entry.knowledgeScore100,
    ] as (string | number)[]),
  ],
})

export const buildPerQuestionSheet = (entries: RoundHistoryEntry[]): SheetData => {
  const conceptColumns = RECALL_QUESTIONS.flatMap((question) => [
    `${question.label} (ก่อนเล่น)`,
    `${question.label} (หลังเล่น)`,
  ])
  const mainColumns = Array.from({ length: MAIN_QUESTION_COUNT }, (_, index) => `ข้อ ${index + 1}`)
  return {
    name: 'รายละเอียดรายข้อ',
    rows: [
      ['ชื่อ', 'เลขที่', 'รอบ', ...conceptColumns, ...mainColumns],
      ...entries.map((entry) => {
        const resultByConcept = new Map(entry.conceptResults.map((result) => [result.conceptId, result]))
        const conceptCells = RECALL_QUESTIONS.flatMap((question) => {
          const result = resultByConcept.get(question.id)
          return [yesNo(Boolean(result?.beforeCorrect)), yesNo(Boolean(result?.afterCorrect))]
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
      ['รอบ', 'จำนวนนักเรียน', 'ก่อนเล่น (เฉลี่ย)', 'หลังเล่น (เฉลี่ย)', 'เรื่องที่เข้าใจดีที่สุด', 'เรื่องที่ควรทบทวน'],
      ...rounds.map((round) => {
        const roundEntries = entries.filter((entry) => entry.round === round)
        // Rank concepts by how many students got them right AFTER playing — the same
        // strongest/weakest signal the teacher sees live.
        const afterCorrectByConcept = new Map<string, number>()
        roundEntries.forEach((entry) => {
          entry.conceptResults.forEach((result) => {
            afterCorrectByConcept.set(result.conceptId, (afterCorrectByConcept.get(result.conceptId) ?? 0) + (result.afterCorrect ? 1 : 0))
          })
        })
        const ranked = [...afterCorrectByConcept.entries()].sort((a, b) => b[1] - a[1])
        const best = ranked.length > 0 ? ranked[0][1] : 0
        const worst = ranked.length > 0 ? ranked[ranked.length - 1][1] : 0
        // Ties are all listed rather than arbitrarily picking one, so the teacher sees the real
        // shape of the class result instead of a misleading single winner.
        const strongest = ranked.filter(([, count]) => count === best).map(([conceptId]) => conceptLabel(conceptId))
        const weakest = ranked.filter(([, count]) => count === worst).map(([conceptId]) => conceptLabel(conceptId))
        return [
          round,
          roundEntries.length,
          average(roundEntries.map((entry) => entry.beforeCorrectCount)),
          average(roundEntries.map((entry) => entry.afterCorrectCount)),
          best === worst ? '-' : strongest.join(', '),
          best === worst ? '-' : weakest.join(', '),
        ] as (string | number)[]
      }),
    ],
  }
}

export const buildLearningWorkbook = (entries: RoundHistoryEntry[]): Uint8Array => {
  const ordered = [...entries].sort((a, b) => a.round - b.round || a.studentNumber.localeCompare(b.studentNumber))
  return buildXlsx([
    buildStudentSummarySheet(ordered),
    buildPerQuestionSheet(ordered),
    buildClassSummarySheet(ordered),
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
