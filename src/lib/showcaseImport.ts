import { buildRoundHistoryEntry, roundHistoryEntryId } from './roundHistory'
import {
  SHOWCASE_COMPLETED_AT,
  SHOWCASE_MODE_FIELD,
  SHOWCASE_QUESTION_IDS,
  SHOWCASE_ROUND,
  SHOWCASE_TEAMS,
  assertShowcaseRoster,
  buildShowcasePlayers,
  showcaseTeamNameFor,
  type RosterStudent,
} from './showcaseRound'
import type { RoundHistoryEntry, TeamRosterSummary } from '../types/game'

// The complete set of documents a showcase round needs, built once and shared by BOTH backends so
// the Firebase and demo implementations cannot drift.
//
// Deliberately NO player documents. A recorded round already reconstructs every individual result
// from roundHistory (see historyToDerivedPlayers), so creating 30 player docs would add nothing
// except forged student ownership — which the Firestore rules rightly refuse, and which no
// showcase is worth weakening them for.

export interface ShowcaseDocuments {
  /** Written on create. Rules require a new room to start 'waiting'. */
  initialRoom: Record<string, unknown>
  /** Applied immediately afterwards, as the owning teacher, to reach the finished state. */
  completedRoomUpdate: Record<string, unknown>
  historyEntries: RoundHistoryEntry[]
  rosters: Array<{ teamId: string; roster: TeamRosterSummary }>
  teamNames: Array<{ teamId: string; name: string; updatedAt: number; updatedByPlayerId: string }>
}

export const buildShowcaseDocuments = (
  roomCode: string,
  teacherSessionId: string,
  roster: RosterStudent[],
): ShowcaseDocuments => {
  assertShowcaseRoster(roster)
  const players = buildShowcasePlayers(roster)

  const historyEntries = players.map((player) =>
    buildRoundHistoryEntry(
      player,
      SHOWCASE_ROUND,
      player.teamId ? showcaseTeamNameFor(player.teamId) : '',
      SHOWCASE_COMPLETED_AT,
    ))

  // Rules pin a newly created room to status 'waiting' and to teacherSessionId == the caller, so
  // the import creates a legal empty room first and then updates it as its owner.
  const initialRoom: Record<string, unknown> = {
    roomCode,
    status: 'waiting',
    phase: 'lobby',
    currentRound: SHOWCASE_ROUND,
    createdAt: SHOWCASE_COMPLETED_AT,
    startedAt: null,
    completedAt: null,
    currentQuestionIndex: 0,
    questionDurationSeconds: 30,
    questionStartedAt: null,
    questionClosedAt: null,
    recallQuestionDurationSeconds: 15,
    recallQuestionIndex: 0,
    recallQuestionStartedAt: null,
    assessmentSecondsPerQuestion: 30,
    preTestStartedAt: null,
    postTestStartedAt: null,
    bossQuestionIds: [],
    bossQuestionIndex: 0,
    bossQuestionStartedAt: null,
    bossQuestionDurationSeconds: 12,
    bossCompleted: false,
    bossWinner: null,
    bossAwaitingContinue: false,
    questionIds: SHOWCASE_QUESTION_IDS,
    previousQuestionIds: [],
    winner: null,
    teacherSessionId,
    teamCount: 0,
    teamsLocked: false,
    teams: [],
    // Provenance, set from the very first write so the room is never briefly indistinguishable
    // from a real classroom room.
    [SHOWCASE_MODE_FIELD]: true,
  }

  const completedRoomUpdate: Record<string, unknown> = {
    status: 'completed',
    phase: 'survey',
    startedAt: SHOWCASE_COMPLETED_AT,
    completedAt: SHOWCASE_COMPLETED_AT,
    currentQuestionIndex: SHOWCASE_QUESTION_IDS.length,
    recallQuestionIndex: 5,
    preTestStartedAt: SHOWCASE_COMPLETED_AT,
    postTestStartedAt: SHOWCASE_COMPLETED_AT,
    teamCount: SHOWCASE_TEAMS.length,
    teamsLocked: true,
    teams: SHOWCASE_TEAMS,
    [SHOWCASE_MODE_FIELD]: true,
  }

  const rosters = SHOWCASE_TEAMS.map((team) => ({
    teamId: team.id,
    roster: {
      teamId: team.id,
      teamName: team.name,
      members: players
        .filter((player) => player.teamId === team.id)
        .map((player) => ({ playerId: player.id, displayName: player.displayName })),
    } satisfies TeamRosterSummary,
  }))

  const teamNames = SHOWCASE_TEAMS.map((team) => ({
    teamId: team.id,
    name: showcaseTeamNameFor(team.id),
    updatedAt: SHOWCASE_COMPLETED_AT,
    updatedByPlayerId: teacherSessionId,
  }))

  return { initialRoom, completedRoomUpdate, historyEntries, rosters, teamNames }
}

export const showcaseHistoryDocId = (entry: RoundHistoryEntry): string =>
  roundHistoryEntryId(SHOWCASE_ROUND, entry.playerId)

/** Thrown when the target code already holds a room that is not a showcase room. */
export const showcaseCollisionMessage = (roomCode: string): string =>
  `ผู้ใช้:ห้อง ${roomCode} มีอยู่แล้วและไม่ใช่ห้องสาธิต จึงไม่เขียนทับ`
