import { computePostTestResult, computePreTestResult } from './assessment'
import { computeStudentRecallItems, computeStudentRecallResult } from './learning'
import type { Player, RoundHistoryEntry } from '../types/game'

// Deterministic snapshot id. Making it a pure function of (round, playerId) is what gives the
// snapshot its idempotency: re-running a round's snapshot targets the exact same id, so the
// service layer can skip an already-recorded round instead of writing a duplicate.
export const roundHistoryEntryId = (round: number, playerId: string): string => `${round}-${playerId}`

// Builds the immutable record for one student's finished round. Shared by DemoGameService and
// FirebaseGameService so the two can never disagree about what a round's history contains.
//
// Reads ONLY raw individual correctness — player.recallAnswers, player.answers, player.score and
// the assessment arrays. Team score, magic, boss, speed, ranking and competition score are all
// deliberately absent.
//
// Recall and Main are recorded as two INDEPENDENT results. This builder no longer emits the
// legacy beforeCorrectCount / afterCorrectCount / improvedCount / reviewCount / conceptResults
// fields: pairing a review activity against the main game was never a learning measurement. Those
// fields remain declared on RoundHistoryEntry as optional, read-only leftovers so previously
// written documents keep parsing — nothing produces them any more.
export const buildRoundHistoryEntry = (
  player: Player,
  round: number,
  teamName: string,
  completedAt: number,
): RoundHistoryEntry => {
  const recall = computeStudentRecallResult(player)
  const recallItems = computeStudentRecallItems(player)
  // Scores DERIVED from the approved banks — never read from the stored records, which carry no
  // correctness field at all.
  const preTest = computePreTestResult(player.preTestAnswers)
  const postTest = computePostTestResult(player.postTestAnswers)
  return {
    id: roundHistoryEntryId(round, player.id),
    round,
    playerId: player.id,
    displayName: player.displayName,
    studentNumber: player.studentNumber,
    teamId: player.teamId,
    teamName,
    // Story Recall result, standalone — the counts plus the durable per-item detail behind
    // them, captured here before the round reset clears player.recallAnswers.
    recallCorrectCount: recall.correctCount,
    recallTotalCount: recall.totalCount,
    recallResults: recallItems.map((item) => ({
      conceptId: item.conceptId,
      isCorrect: item.isCorrect,
      answered: item.answered,
    })),
    // Main-game knowledge score, standalone. Stored both as the canonical /10 count and the /100
    // display figure, so exports never have to re-derive (and can't drift from) the shown value.
    knowledgeScore: player.score,
    knowledgeScore100: player.score * 10,
    mainAnswers: player.answers.map((answer) => ({ questionId: answer.questionId, isCorrect: answer.isCorrect })),
    // Assessment Layer, captured before the round reset clears the player's arrays. The counts are
    // computed from the question banks here; the raw selections are stored as-is so any later
    // report can re-derive per-item correctness from the same banks. Totals are the bank size, not
    // the number answered, so an unfinished test scores against the full test.
    preTestCorrectCount: preTest.correctCount,
    preTestTotalCount: preTest.totalCount,
    preTestAnswers: player.preTestAnswers.map((answer) => ({
      questionId: answer.questionId,
      selectedChoiceId: answer.selectedChoiceId,
    })),
    postTestCorrectCount: postTest.correctCount,
    postTestTotalCount: postTest.totalCount,
    postTestAnswers: player.postTestAnswers.map((answer) => ({
      questionId: answer.questionId,
      selectedChoiceId: answer.selectedChoiceId,
    })),
    surveyResponses: player.surveyResponses.map((response) => ({ itemId: response.itemId, value: response.value })),
    completedAt,
  }
}
