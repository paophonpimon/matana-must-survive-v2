import type { Player, RoundHistoryEntry } from '../types/game'

// Pure helpers for the read-only room-history screen. Everything here derives from
// RoundHistoryEntry — the immutable per-round snapshot that already exists — so the history
// screen never needs a second store, and its numbers can only ever come from the same
// computeEvidenceSummaryFromHistory the live panel, the printout and the workbook already use.

export interface RoundHistorySummary {
  round: number
  studentCount: number
  // Latest snapshot timestamp in the round. Rounds recorded before completedAt existed report 0,
  // which the UI renders as "-" rather than as the epoch.
  completedAt: number
}

// One entry per recorded round, newest first. Student count is the number of DISTINCT players
// snapshotted in that round — history ids are `${round}-${playerId}`, so a re-snapshot of the
// same round cannot inflate it.
export const summarizeRoundHistory = (entries: RoundHistoryEntry[]): RoundHistorySummary[] => {
  const byRound = new Map<number, { players: Set<string>; completedAt: number }>()
  for (const entry of entries) {
    const bucket = byRound.get(entry.round) ?? { players: new Set<string>(), completedAt: 0 }
    bucket.players.add(entry.playerId)
    bucket.completedAt = Math.max(bucket.completedAt, entry.completedAt ?? 0)
    byRound.set(entry.round, bucket)
  }
  return [...byRound.entries()]
    .map(([round, bucket]) => ({ round, studentCount: bucket.players.size, completedAt: bucket.completedAt }))
    .sort((a, b) => b.round - a.round)
}

export const entriesForRound = (entries: RoundHistoryEntry[], round: number): RoundHistoryEntry[] =>
  entries
    .filter((entry) => entry.round === round)
    .sort((a, b) => a.studentNumber.localeCompare(b.studentNumber))

// Distinct students across the whole room, for the room list. Null when nothing was ever
// recorded — the list must show "-" there, never 0.
export const distinctStudentCount = (entries: RoundHistoryEntry[]): number | null => {
  if (entries.length === 0) return null
  return new Set(entries.map((entry) => entry.playerId)).size
}

// The main-question ids of a recorded round, in the order they were answered. Room.questionIds
// is the live field, but a historical round must not read it: the room has since moved on and
// re-rolled its questions. The snapshot's own mainAnswers are the only faithful record, so the
// printed column order comes from the round that was actually played.
export const questionIdsFromHistory = (entries: RoundHistoryEntry[]): string[] => {
  const ordered: string[] = []
  const seen = new Set<string>()
  // Take the longest answer list as the spine so a student who dropped out early cannot shorten
  // the table, then union in anything the others answered that it happens to miss.
  const spine = [...entries].sort((a, b) => b.mainAnswers.length - a.mainAnswers.length)
  for (const entry of spine) {
    for (const answer of entry.mainAnswers) {
      if (seen.has(answer.questionId)) continue
      seen.add(answer.questionId)
      ordered.push(answer.questionId)
    }
  }
  return ordered
}

// What TeacherReportPrintView needs from a "player". Declared as a Pick of the real Player so the
// live caller keeps type-checking unchanged, while a historical round can satisfy it from a
// snapshot without inventing the fields (teamId, magic, submitted...) it does not have.
export type PrintablePlayer = Pick<Player, 'id' | 'displayName' | 'studentNumber' | 'teamId' | 'score'>
  & { answers: Array<{ questionId: string; isCorrect: boolean }> }

// Adapts recorded snapshots into the printable shape. teamId is synthesized from the recorded
// teamName so the existing teamNameById lookup keeps working for history too — the original
// teamId may since have been re-randomized away, but the name recorded at snapshot time is the
// one that was true for that round.
export const historyToPrintablePlayers = (entries: RoundHistoryEntry[]): PrintablePlayer[] =>
  entries.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    studentNumber: entry.studentNumber,
    teamId: entry.teamId,
    score: entry.knowledgeScore,
    answers: entry.mainAnswers,
  }))

// teamId -> recorded team name for one round. Built from the snapshot, not from the live room,
// for the same reason questionIdsFromHistory is.
export const teamNamesFromHistory = (entries: RoundHistoryEntry[]): Map<string, string> => {
  const names = new Map<string, string>()
  for (const entry of entries) {
    if (entry.teamId && entry.teamName) names.set(entry.teamId, entry.teamName)
  }
  return names
}

// ── Reconstructing the Result view from a stored round ─────────────────────────────────────────
//
// A recorded round holds everything the Teacher Result screen needs, so the polished command
// centre can be reused for history without keeping the live player documents alive — and without
// ever creating player docs just to render a past round.
//
// Nothing here re-implements a formula. Each helper rebuilds the minimal player-shaped object the
// EXISTING aggregators already accept (computeTeamStats, computeTeamCompetitionStats,
// computeClassRecallSummary), so the historical screen and the live screen cannot drift.

// The live aggregators only ever read these fields off a player. Reconstructing exactly them —
// and nothing else — keeps it obvious that no invented value is being fed in.
export type HistoryDerivedPlayer = Pick<
  Player,
  'id' | 'displayName' | 'studentNumber' | 'teamId' | 'score' | 'answers' | 'recallAnswers' | 'submitted'
>

// Rebuilds the player-shaped rows the team/recall aggregators consume.
//
// `answers` carries the recorded per-question correctness; `selectedChoiceId` is deliberately
// blank because a snapshot records WHETHER an answer was right, never which choice was picked,
// and no consumer of these rows reads it. `submitted` is true for every recorded row: being in
// the snapshot at all is what "finished the round" means.
export const historyToDerivedPlayers = (entries: RoundHistoryEntry[]): HistoryDerivedPlayer[] =>
  entries.map((entry) => ({
    id: entry.playerId,
    displayName: entry.displayName,
    studentNumber: entry.studentNumber,
    teamId: entry.teamId,
    score: entry.knowledgeScore,
    answers: entry.mainAnswers.map((answer) => ({
      questionId: answer.questionId,
      selectedChoiceId: '',
      isCorrect: answer.isCorrect,
      answeredAt: entry.completedAt,
      // Never recorded in a snapshot, and never read by scoring or ranking — 0 is the honest
      // "not captured" value here, not a real measurement.
      responseTimeMs: 0,
    })),
    // Rounds recorded before per-item recall detail existed have no recallResults; they
    // reconstruct as "nothing answered", which is what the recall summary already treats an
    // absent item as. Never as a wrong answer.
    recallAnswers: (entry.recallResults ?? [])
      .filter((result) => result.answered)
      .map((result) => ({
        conceptId: result.conceptId,
        selectedChoiceId: '',
        isCorrect: result.isCorrect,
        answeredAt: entry.completedAt,
      })),
    submitted: true,
  }))

// The teams that actually appear in a recorded round, in stable id order. Built from the snapshot
// rather than the live room, whose teams may since have been re-randomized away.
export const teamsFromHistory = (entries: RoundHistoryEntry[]): Array<{ id: string; name: string }> => {
  const names = teamNamesFromHistory(entries)
  return [...names.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'))
}
