import type { AnswerProgressEntry, CaptainVote, CaptainVoteProgress, JoinInput, JoinResult, MagicEvent, MagicItemType, Player, Room, RoundHistoryEntry, TeacherRoomSummary, TeamGuardianName, TeamMagicState, TeamRosterSummary, Unsubscribe, Winner } from '../types/game'

export interface AnswerInput {
  questionId: string
  selectedChoiceId: string
  expectedQuestionIndex: number
}

export interface AnswerResult {
  player: Player
  winner: Winner | null
}

// Learning Layer: deliberately shaped like AnswerInput/BossAnswerInput but with
// `expectedRecallIndex` instead of a question-index field — Recall has its own individual 0..4
// sequence (player.recallAnswers.length), never conflated with the main round's
// currentQuestionIndex or the boss phase's bossQuestionIndex. conceptId doubles as the
// RecallQuestion id being answered (see data/recallQuestions.ts).
export interface RecallAnswerInput {
  conceptId: string
  selectedChoiceId: string
  expectedRecallIndex: number
}

// Milestone 4: deliberately shaped like AnswerInput but with `expectedBossIndex` instead of
// `expectedQuestionIndex` — boss questions have their own separate 0..2 index, never conflated
// with the main round's currentQuestionIndex.
export interface BossAnswerInput {
  questionId: string
  selectedChoiceId: string
  expectedBossIndex: number
}

// Assessment Layer. Deliberately shaped like RecallAnswerInput: an `expected*Index` token makes a
// duplicate/stale submit a safe no-op rather than a double-write, the same idempotency pattern
// every other answer path here already uses. No responseTimeMs — neither test is ever
// speed-scored.
//
// Note there is NO isCorrect field. Correctness is derived by the service from the question bank
// (data/assessmentQuestions.ts) via evaluateChoice, exactly as saveRecallAnswer and saveAnswer
// already do — a client cannot report its own score.
export interface PreTestAnswerInput {
  questionId: string
  selectedChoiceId: string
  expectedIndex: number
}

export interface PostTestAnswerInput {
  questionId: string
  selectedChoiceId: string
  expectedIndex: number
}

// No correctness field: a survey item has no right answer, so there is nothing for a scoring path
// to read even accidentally.
export interface SurveyResponseInput {
  itemId: string
  value: string
  expectedIndex: number
}

export interface GameService {
  readonly isDemo: boolean
  readonly demoRoomCode?: string
  resetDemoRoom?(): Promise<Room>
  ensureSession(): Promise<string>
  createRoom(teacherSessionId: string): Promise<Room>
  joinRoom(input: JoinInput, ownerUid: string): Promise<JoinResult>
  subscribeRoom(roomCode: string, listener: (room: Room | null) => void, onError: (message: string) => void): Unsubscribe
  subscribePlayers(roomCode: string, listener: (players: Player[]) => void, onError: (message: string) => void): Unsubscribe
  subscribePlayer(roomCode: string, playerId: string, listener: (player: Player | null) => void, onError: (message: string) => void): Unsubscribe
  // bossQuestionDurationSeconds is optional so existing callers keep working; when omitted the
  // room's current boss duration is left as-is.
  startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number, bossQuestionDurationSeconds?: number): Promise<void>
  // Pre-game stage transitions, in order: lobby -> teamSetup -> preTest -> recall -> (startRoom)
  // -> main. Each is teacher-only and a no-op when the room is already past that stage, so a
  // stale/duplicate click never restarts an activity or rewinds team setup.
  // lobby -> teamSetup. No-op unless the room is still in 'lobby'.
  startTeamSetup(roomCode: string, teacherSessionId: string): Promise<void>
  // teamSetup -> preTest. Refused until team setup is fully complete (locked, every team has a
  // captain, a starting item and a guardian name) — the same readiness startRoom used to check
  // immediately before Main, now checked here instead since Main is two stages further away.
  // assessmentDurationSeconds is optional so existing callers keep working; when omitted the room
  // keeps its current (default) assessment duration.
  startPreTest(roomCode: string, teacherSessionId: string, assessmentDurationSeconds?: number): Promise<void>
  // preTest -> recall. Same teacher-only, stage-guarded shape; a stale click is a safe no-op.
  // recallQuestionDurationSeconds is optional so existing callers keep working; when omitted the
  // room keeps its current (default) Recall duration.
  startRecall(roomCode: string, teacherSessionId: string, recallQuestionDurationSeconds?: number): Promise<void>
  // Room-synchronized Recall advance, mirroring advanceQuestion: expectedRecallIndex makes a
  // duplicate timer callback a safe no-op instead of a skipped question.
  advanceRecallQuestion(roomCode: string, teacherSessionId: string, expectedRecallIndex: number): Promise<void>
  saveRecallAnswer(roomCode: string, playerId: string, answer: RecallAnswerInput): Promise<void>
  // Assessment Layer (Milestone 1): data-foundation writes. Each one requires the room to be in
  // its own matching phase and appends exactly one record to its own round-scoped array, using
  // the same expected-index guard Recall/Main already use. Nothing calls these yet — no UI and no
  // transition into 'preTest'/'postTest'/'survey' exists in this milestone.
  savePreTestAnswer(roomCode: string, playerId: string, answer: PreTestAnswerInput): Promise<void>
  savePostTestAnswer(roomCode: string, playerId: string, answer: PostTestAnswerInput): Promise<void>
  // Timeout advance for the assessments. Writes NO answer — it only moves the student past an
  // expired question, so an unanswered item can never become a dead end. Idempotent: keyed on the
  // expected index, so a duplicate call or a reconnect that re-detects the same expiry is a no-op.
  advancePreTestQuestion(roomCode: string, playerId: string, expectedIndex: number): Promise<void>
  advancePostTestQuestion(roomCode: string, playerId: string, expectedIndex: number): Promise<void>
  saveSurveyResponse(roomCode: string, playerId: string, response: SurveyResponseInput): Promise<void>
  advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void>
  closeQuestionEarly(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void>
  saveBossAnswer(roomCode: string, playerId: string, answer: BossAnswerInput): Promise<void>
  advanceBossQuestion(roomCode: string, teacherSessionId: string, expectedBossIndex: number): Promise<void>
  // Pause-and-continue gate: advanceBossQuestion resolving the 3rd boss question sets
  // bossAwaitingContinue=true instead of also advancing phase/currentQuestionIndex — this is
  // the only method that ever clears it, and only ever fired by the teacher's "เล่นต่อ" button
  // (never a polling effect), which is what makes "resume only on explicit teacher action" true.
  // expectedRound is the same idempotent "expected token" shape as advanceQuestion/
  // advanceBossQuestion's expected-index guards, so a stale/duplicate call is a safe no-op.
  continueAfterBoss(roomCode: string, teacherSessionId: string, expectedRound: number): Promise<void>
  // postTest -> survey. Teacher-only; no-op unless the room is in the post-test stage.
  // Explicit teacher gate: reaching the postTest stage does not open the test. Until this runs,
  // students wait and every post-test write is rejected.
  startPostTest(roomCode: string, teacherSessionId: string, assessmentDurationSeconds?: number): Promise<void>
  startSurvey(roomCode: string, teacherSessionId: string): Promise<void>
  // survey -> completed. Teacher-only; no-op unless the room is in the survey stage. Snapshots
  // this round's history before completing, so assessment data is durable immediately.
  completeRound(roomCode: string, teacherSessionId: string): Promise<void>
  stopRound(roomCode: string, teacherSessionId: string): Promise<void>
  prepareNextRound(roomCode: string, teacherSessionId: string): Promise<void>
  closeRoom(roomCode: string, teacherSessionId: string): Promise<void>
  saveAnswer(roomCode: string, playerId: string, answer: AnswerInput): Promise<AnswerResult>
  randomizeTeams(roomCode: string, teacherSessionId: string, teamCount: number): Promise<void>
  lockTeams(roomCode: string, teacherSessionId: string): Promise<void>
  unlockTeams(roomCode: string, teacherSessionId: string): Promise<void>
  subscribeTeamMagic(roomCode: string, teamId: string, listener: (magic: TeamMagicState | null) => void, onError: (message: string) => void): Unsubscribe
  subscribeAllTeamMagic(roomCode: string, listener: (magic: TeamMagicState[]) => void, onError: (message: string) => void): Unsubscribe
  subscribeMagicEvents(roomCode: string, listener: (events: MagicEvent[]) => void, onError: (message: string) => void): Unsubscribe
  chooseStartingItem(roomCode: string, teamId: string, playerId: string, itemType: MagicItemType): Promise<void>
  activateItem(roomCode: string, teamId: string, playerId: string, itemType: 'power_surge' | 'score_seal' | 'illusion', targetTeamId?: string): Promise<void>
  subscribeTeamRoster(roomCode: string, teamId: string, listener: (roster: TeamRosterSummary | null) => void, onError: (message: string) => void): Unsubscribe
  subscribeTeamAnswerProgress(roomCode: string, teamId: string, listener: (entries: AnswerProgressEntry[]) => void, onError: (message: string) => void): Unsubscribe
  // Milestone 4.1: team captain election. castCaptainVote is student-authored (self-vote only,
  // target must be a member of the voter's own locked team); finalize/reset are teacher-only.
  // "Auto-finalize once everyone has voted" is deliberately driven by the TEACHER's client
  // polling vote progress (mirroring how main-question/boss auto-advance are already
  // teacher-client-driven, never student-triggered) rather than embedding a tally-dependent
  // write inside castCaptainVote itself — see firestore.rules for why a student-triggered
  // finalize could never be safely validated (rules cannot aggregate/count).
  castCaptainVote(roomCode: string, playerId: string, targetPlayerId: string): Promise<void>
  finalizeCaptainElection(roomCode: string, teacherSessionId: string, teamId: string): Promise<void>
  resetCaptainElection(roomCode: string, teacherSessionId: string, teamId: string): Promise<void>
  subscribeCaptainVote(roomCode: string, playerId: string, listener: (vote: CaptainVote | null) => void, onError: (message: string) => void): Unsubscribe
  subscribeTeamCaptainVoteProgress(roomCode: string, teamId: string, listener: (entries: CaptainVoteProgress[]) => void, onError: (message: string) => void): Unsubscribe
  subscribeAllCaptainVoteProgress(roomCode: string, listener: (entries: CaptainVoteProgress[]) => void, onError: (message: string) => void): Unsubscribe
  // Team guardian name: captain-editable, teacher-resettable/overridable. Names reset every
  // lockTeams call (same lifecycle as captainElectionAttempt/inventory) — see lockTeams' doc
  // comment in firebaseService.ts. setTeamGuardianName is the captain-authored path (rules
  // verify playerId is the team's finalized captain); reset/override are teacher-only.
  subscribeAllTeamGuardianNames(roomCode: string, listener: (names: TeamGuardianName[]) => void, onError: (message: string) => void): Unsubscribe
  // Teacher-only: immutable per-round learning snapshots for this room, written by the
  // round-ending operations before player data is reset.
  // Read-only room history. Returns ONLY rooms whose teacherSessionId is this teacher, newest
  // first. There is deliberately no counterpart that reopens or mutates an old room — the history
  // screen can look, print and export, and nothing else.
  listTeacherRooms(teacherSessionId: string): Promise<TeacherRoomSummary[]>
  subscribeRoundHistory(roomCode: string, listener: (entries: RoundHistoryEntry[]) => void, onError: (message: string) => void): Unsubscribe
  setTeamGuardianName(roomCode: string, teamId: string, playerId: string, name: string): Promise<void>
  resetTeamGuardianName(roomCode: string, teacherSessionId: string, teamId: string): Promise<void>
  overrideTeamGuardianName(roomCode: string, teacherSessionId: string, teamId: string, name: string): Promise<void>
}

// Used by FirebaseGameService.joinRoom's catch block when the transaction's read of the
// deterministic player doc is denied by security rules (a genuinely new player can't be
// distinguished from a duplicate at the rules layer, since the doc doesn't exist yet). Given
// the room state re-read *outside* the transaction, decide whether that denial was actually
// caused by a locked room (the one case the rules intentionally deny for a brand-new player)
// — returning null means "not that specific cause," so the caller must rethrow the original
// Firebase error rather than ever inventing a false duplicate-student-number claim.
export const resolveJoinPermissionDeniedMessage = (room: Pick<Room, 'teamsLocked'> | null): string | null =>
  room?.teamsLocked ? 'ผู้ใช้:ทีมถูกล็อกแล้ว กรุณาติดต่อครู' : null

export const friendlyError = (error: unknown): string => {
  if (error instanceof Error && error.message.startsWith('ผู้ใช้:')) return error.message.replace('ผู้ใช้:', '')
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'auth/too-many-requests') return 'มีผู้เข้าใช้งานพร้อมกันจำนวนมาก กรุณารอสักครู่แล้วลองใหม่'
  if (code === 'auth/network-request-failed' || code === 'unavailable' || code === 'deadline-exceeded') {
    return 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ กรุณาตรวจสอบสัญญาณแล้วลองใหม่'
  }
  if (code === 'permission-denied' || code === 'unauthenticated') {
    return 'เซสชันหมดอายุหรือไม่มีสิทธิ์ดำเนินการ กรุณารีเฟรชหน้าแล้วลองใหม่'
  }
  return 'การเชื่อมต่อขัดข้อง กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'
}
