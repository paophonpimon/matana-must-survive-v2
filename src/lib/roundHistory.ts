import { computeStudentConceptResults, computeStudentLearningEvidence } from './learning'
import type { Player, RoundHistoryEntry } from '../types/game'

// Deterministic snapshot id. Making it a pure function of (round, playerId) is what gives the
// snapshot its idempotency: re-running a round's snapshot targets the exact same id, so the
// service layer can skip an already-recorded round instead of writing a duplicate.
export const roundHistoryEntryId = (round: number, playerId: string): string => `${round}-${playerId}`

// Builds the immutable record for one student's finished round. Shared by DemoGameService and
// FirebaseGameService so the two can never disagree about what a round's history contains.
//
// Reads ONLY raw individual correctness — player.recallAnswers, player.answers and player.score.
// Team score, magic, boss, speed, ranking and competition score are all deliberately absent, the
// same constraint lib/learning.ts documents for the live summary.
export const buildRoundHistoryEntry = (
  player: Player,
  round: number,
  teamName: string,
  completedAt: number,
): RoundHistoryEntry => {
  const evidence = computeStudentLearningEvidence(player)
  const conceptResults = computeStudentConceptResults(player)
  // "Needs review" is scoped to concepts still wrong AFTER playing — that's what the teacher
  // acts on. It is the same set the live student summary already labels as still-incorrect.
  const reviewConceptIds = evidence.stillIncorrectConceptIds
  return {
    id: roundHistoryEntryId(round, player.id),
    round,
    playerId: player.id,
    displayName: player.displayName,
    studentNumber: player.studentNumber,
    teamId: player.teamId,
    teamName,
    beforeCorrectCount: evidence.recallCorrectCount,
    afterCorrectCount: evidence.mainEvidenceCorrectCount,
    improvedCount: evidence.improvedConceptIds.length,
    reviewCount: reviewConceptIds.length,
    improvedConceptIds: evidence.improvedConceptIds,
    reviewConceptIds,
    conceptResults: conceptResults.map((result) => ({
      conceptId: result.conceptId,
      beforeCorrect: result.beforeCorrect,
      afterCorrect: result.afterCorrect,
    })),
    knowledgeScore: player.score,
    knowledgeScore100: player.score * 10,
    mainAnswers: player.answers.map((answer) => ({ questionId: answer.questionId, isCorrect: answer.isCorrect })),
    completedAt,
  }
}
