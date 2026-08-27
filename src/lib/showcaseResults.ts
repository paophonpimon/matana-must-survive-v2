import { buildRoundHistoryEntry } from './roundHistory'
import {
  SHOWCASE_QUESTION_IDS,
  buildShowcasePlayers,
  showcaseTeamNameFor,
  type RosterStudent,
  type ShowcasePerformance,
} from './showcaseRound'
import type { RoundHistoryEntry } from '../types/game'

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  CLASS REPORTING SAMPLE — 30 RECONSTRUCTED PARTICIPANTS (P01–P30)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
//  A complete finished round for 30 anonymous participants, used ONLY to demonstrate the Teacher
//  Result reporting system (command centre + print + spreadsheet) at full class scale.
//
//  PROVENANCE, stated plainly:
//   • The class-level aggregate targets it reproduces are treated as confirmed real classroom-use
//     results. The 30 per-participant rows below are RECONSTRUCTED so those aggregates derive
//     cleanly through the production pipeline — the original per-student raw records are not
//     available. These rows are NOT original measured student records.
//   • Identities are P01–P30 only. No real student name is attached to any score here or anywhere
//     downstream of this file.
//
//  Every displayed figure is DERIVED by the shared aggregators (computeEvidenceSummaryFromHistory,
//  computeClassRecallSummary, computeTeamCompetitionStats). Nothing is asserted on screen. The
//  reconstructed rows reproduce, by construction:
//     pre 5.43 · post 8.33 · difference +2.90 · improved 26 · unchanged 3 · declined 1
//     main complete 30/30 · main average 8.17 · recall average 4.13 · survey average 4.63
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const SAMPLE_RESULTS_PARTICIPANT_COUNT = 30
export const SAMPLE_RESULTS_ROUND = 1
/** Not a room. A stable label the print header / spreadsheet name can use. */
export const SAMPLE_RESULTS_LABEL = 'ตัวอย่างระดับชั้น-30คน'
/** Fixed instant so the sample is byte-identical on every render. */
export const SAMPLE_RESULTS_COMPLETED_AT = Date.UTC(2026, 7, 24, 3, 30, 0)

// The provenance strings the reporting UI shows on this sample. Kept here so the page, the print
// view and the workbook all use exactly the same wording.
export const SAMPLE_RESULTS_HEADLINE = 'ตัวอย่างผลลัพธ์ระดับชั้น 30 คน'
export const SAMPLE_RESULTS_SUBHEAD = 'ข้อมูลสร้างขึ้นเพื่อสาธิตระบบรายงานผล'
export const SAMPLE_RESULTS_INDIVIDUAL_NOTE = 'ข้อมูลรายบุคคลที่สร้างขึ้นเพื่อให้สอดคล้องกับผลสรุประดับชั้น'

// Anonymous participants P01…P30. studentNumber 1–30 is a POSITION, not a person; firstName is the
// visible id and lastName is empty (rosterDisplayName trims), so the tables read "P01" … "P30".
const SAMPLE_ROSTER: RosterStudent[] = Array.from({ length: SAMPLE_RESULTS_PARTICIPANT_COUNT }, (_, index) => {
  const studentNumber = index + 1
  const id = `P${String(studentNumber).padStart(2, '0')}`
  return { studentId: id, firstName: id, lastName: '', className: 'ชุดข้อมูลตัวอย่าง', studentNumber }
})

// RECONSTRUCTED per-participant rows. `mainWrongIndexes` / `recallWrongIndexes` name the exact
// questions each participant misses so the per-question detail in the printout and the spreadsheet
// varies (harder questions missed more often); `surveyResponses` is the exact 6-value Likert row.
// Every row's wrong-index count equals (bank length − its score), so the derived averages and the
// per-item detail agree.
// In studentNumber order. Status column (improved / unchanged / declined) is what PRE vs POST
// produces for that row — the aggregator derives it, it is not stored.
const SAMPLE_RESULTS_PERFORMANCE: ShowcasePerformance[] = [
  { studentNumber: 1, preCorrect: 6, postCorrect: 10, mainScore: 8, recallCorrect: 4, mainWrongIndexes: [6, 8], recallWrongIndexes: [1], surveyResponses: [5, 4, 4, 4, 5, 5] }, // improved
  { studentNumber: 2, preCorrect: 5, postCorrect: 9, mainScore: 8, recallCorrect: 4, mainWrongIndexes: [8, 9], recallWrongIndexes: [1], surveyResponses: [5, 5, 4, 4, 5, 5] }, // improved
  { studentNumber: 3, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, mainWrongIndexes: [8, 9], recallWrongIndexes: [4], surveyResponses: [5, 5, 3, 4, 4, 5] }, // improved
  { studentNumber: 4, preCorrect: 5, postCorrect: 9, mainScore: 8, recallCorrect: 4, mainWrongIndexes: [6, 9], recallWrongIndexes: [1], surveyResponses: [5, 5, 5, 5, 4, 4] }, // improved
  { studentNumber: 5, preCorrect: 6, postCorrect: 6, mainScore: 10, recallCorrect: 5, mainWrongIndexes: [], recallWrongIndexes: [], surveyResponses: [5, 5, 5, 5, 5, 5] }, // unchanged
  { studentNumber: 6, preCorrect: 6, postCorrect: 9, mainScore: 9, recallCorrect: 4, mainWrongIndexes: [7], recallWrongIndexes: [2], surveyResponses: [4, 4, 5, 5, 5, 5] }, // improved
  { studentNumber: 7, preCorrect: 6, postCorrect: 10, mainScore: 10, recallCorrect: 5, mainWrongIndexes: [], recallWrongIndexes: [], surveyResponses: [5, 4, 4, 5, 5, 5] }, // improved
  { studentNumber: 8, preCorrect: 7, postCorrect: 10, mainScore: 10, recallCorrect: 5, mainWrongIndexes: [], recallWrongIndexes: [], surveyResponses: [5, 5, 5, 5, 5, 5] }, // improved
  { studentNumber: 9, preCorrect: 4, postCorrect: 8, mainScore: 7, recallCorrect: 3, mainWrongIndexes: [5, 6, 8], recallWrongIndexes: [1, 4], surveyResponses: [3, 5, 5, 5, 4, 4] }, // improved
  { studentNumber: 10, preCorrect: 5, postCorrect: 9, mainScore: 6, recallCorrect: 4, mainWrongIndexes: [4, 5, 6, 7], recallWrongIndexes: [1], surveyResponses: [5, 5, 5, 4, 4, 5] }, // improved
  { studentNumber: 11, preCorrect: 5, postCorrect: 3, mainScore: 8, recallCorrect: 5, mainWrongIndexes: [8, 9], recallWrongIndexes: [], surveyResponses: [5, 5, 4, 5, 5, 3] }, // declined
  { studentNumber: 12, preCorrect: 6, postCorrect: 10, mainScore: 9, recallCorrect: 3, mainWrongIndexes: [9], recallWrongIndexes: [2, 3], surveyResponses: [4, 5, 5, 5, 5, 4] }, // improved
  { studentNumber: 13, preCorrect: 5, postCorrect: 8, mainScore: 9, recallCorrect: 4, mainWrongIndexes: [8], recallWrongIndexes: [4], surveyResponses: [5, 5, 4, 4, 5, 5] }, // improved
  { studentNumber: 14, preCorrect: 4, postCorrect: 8, mainScore: 9, recallCorrect: 4, mainWrongIndexes: [6], recallWrongIndexes: [1], surveyResponses: [5, 5, 5, 5, 4, 4] }, // improved
  { studentNumber: 15, preCorrect: 5, postCorrect: 8, mainScore: 8, recallCorrect: 3, mainWrongIndexes: [4, 7], recallWrongIndexes: [2, 3], surveyResponses: [4, 4, 4, 5, 5, 5] }, // improved
  { studentNumber: 16, preCorrect: 6, postCorrect: 6, mainScore: 8, recallCorrect: 3, mainWrongIndexes: [2, 5], recallWrongIndexes: [0, 4], surveyResponses: [5, 4, 4, 5, 5, 5] }, // unchanged
  { studentNumber: 17, preCorrect: 5, postCorrect: 9, mainScore: 7, recallCorrect: 4, mainWrongIndexes: [3, 5, 6], recallWrongIndexes: [0], surveyResponses: [5, 5, 5, 4, 4, 5] }, // improved
  { studentNumber: 18, preCorrect: 7, postCorrect: 10, mainScore: 8, recallCorrect: 5, mainWrongIndexes: [1, 7], recallWrongIndexes: [], surveyResponses: [4, 4, 5, 5, 5, 5] }, // improved
  { studentNumber: 19, preCorrect: 6, postCorrect: 10, mainScore: 8, recallCorrect: 5, mainWrongIndexes: [8, 9], recallWrongIndexes: [], surveyResponses: [5, 5, 4, 4, 5, 5] }, // improved
  { studentNumber: 20, preCorrect: 5, postCorrect: 8, mainScore: 9, recallCorrect: 5, mainWrongIndexes: [3], recallWrongIndexes: [], surveyResponses: [4, 5, 5, 5, 5, 4] }, // improved
  { studentNumber: 21, preCorrect: 5, postCorrect: 7, mainScore: 6, recallCorrect: 5, mainWrongIndexes: [0, 1, 2, 4], recallWrongIndexes: [], surveyResponses: [5, 5, 5, 5, 4, 4] }, // improved
  { studentNumber: 22, preCorrect: 5, postCorrect: 9, mainScore: 8, recallCorrect: 3, mainWrongIndexes: [3, 4], recallWrongIndexes: [1, 4], surveyResponses: [5, 3, 5, 4, 5, 4] }, // improved
  { studentNumber: 23, preCorrect: 4, postCorrect: 7, mainScore: 6, recallCorrect: 4, mainWrongIndexes: [5, 6, 7, 8], recallWrongIndexes: [2], surveyResponses: [5, 4, 4, 5, 5, 5] }, // improved
  { studentNumber: 24, preCorrect: 5, postCorrect: 9, mainScore: 9, recallCorrect: 4, mainWrongIndexes: [9], recallWrongIndexes: [3], surveyResponses: [5, 5, 5, 4, 4, 5] }, // improved
  { studentNumber: 25, preCorrect: 5, postCorrect: 9, mainScore: 8, recallCorrect: 4, mainWrongIndexes: [0, 2], recallWrongIndexes: [0], surveyResponses: [4, 4, 5, 5, 5, 5] }, // improved
  { studentNumber: 26, preCorrect: 4, postCorrect: 6, mainScore: 6, recallCorrect: 3, mainWrongIndexes: [1, 2, 3, 4], recallWrongIndexes: [1, 2], surveyResponses: [5, 5, 4, 4, 4, 5] }, // improved
  { studentNumber: 27, preCorrect: 6, postCorrect: 9, mainScore: 8, recallCorrect: 4, mainWrongIndexes: [5, 6], recallWrongIndexes: [3], surveyResponses: [4, 5, 5, 5, 5, 4] }, // improved
  { studentNumber: 28, preCorrect: 7, postCorrect: 10, mainScore: 10, recallCorrect: 4, mainWrongIndexes: [], recallWrongIndexes: [4], surveyResponses: [5, 5, 5, 5, 4, 4] }, // improved
  { studentNumber: 29, preCorrect: 7, postCorrect: 10, mainScore: 9, recallCorrect: 5, mainWrongIndexes: [7], recallWrongIndexes: [], surveyResponses: [3, 5, 5, 4, 5, 5] }, // improved
  { studentNumber: 30, preCorrect: 5, postCorrect: 5, mainScore: 8, recallCorrect: 5, mainWrongIndexes: [8, 9], recallWrongIndexes: [], surveyResponses: [5, 5, 4, 4, 5, 5] }, // unchanged
]

/**
 * The 30 immutable round-history entries the reporting sample is rendered from.
 *
 * Built through the SAME `buildShowcasePlayers` → `buildRoundHistoryEntry` path a real recorded
 * round uses, so `computeEvidenceSummaryFromHistory` and every other aggregator see exactly the
 * shape they see for an authentic historical round opened from ประวัติห้อง.
 */
export const buildSampleResultsHistory = (): RoundHistoryEntry[] =>
  buildShowcasePlayers(SAMPLE_ROSTER, SAMPLE_RESULTS_PERFORMANCE).map((player) =>
    buildRoundHistoryEntry(
      player,
      SAMPLE_RESULTS_ROUND,
      player.teamId ? showcaseTeamNameFor(player.teamId) : '',
      SAMPLE_RESULTS_COMPLETED_AT,
    ))

export const SAMPLE_RESULTS_QUESTION_COUNT = SHOWCASE_QUESTION_IDS.length
