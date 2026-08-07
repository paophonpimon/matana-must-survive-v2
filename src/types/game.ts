export type QuestionCategory = 'basic' | 'characters' | 'plot' | 'poetry' | 'theme'
export type Difficulty = 'easy' | 'medium' | 'hard'

export interface QuestionChoice {
  id: string
  text: string
}

export interface Question {
  id: string
  category: QuestionCategory
  question: string
  choices: QuestionChoice[]
  correctChoiceId: string
  explanation: string
  difficulty: Difficulty
}

export type RoomStatus = 'waiting' | 'playing' | 'completed' | 'closed'
export type PlayerStatus = 'waiting' | 'playing' | 'submitted' | 'stopped'

export interface AnswerRecord {
  questionId: string
  selectedChoiceId: string
  isCorrect: boolean
  answeredAt: number
  // Derived from the client clock at answer time. Informational only in Milestone 1 —
  // never read by scoring/ranking. A future fastest-answer round needs server-side timing.
  responseTimeMs: number
}

// Milestone 4: boss-phase answers. Deliberately the same shape as AnswerRecord but a
// completely separate array on Player — this is what makes "boss answers do not affect the
// 100-point knowledge score" true by construction: nothing in the boss save path ever touches
// player.answers or player.score, and nothing in the main scoring path ever reads bossAnswers.
export interface BossAnswerRecord {
  questionId: string
  selectedChoiceId: string
  isCorrect: boolean
  answeredAt: number
  responseTimeMs: number
}

export interface Winner {
  teamId: string
  teamName: string
  guardianName: string
  score: number
  finishedAt: number
  elapsedMs: number
  round: number
}

// Milestone 4: denormalized onto Room (like Winner above) rather than left as a bare
// playerId — once teams are locked, a student can only `get` their OWN player doc under
// firestore.rules (no `list`, no arbitrary-id `get`), so there is no rules-legal way for a
// student's client to resolve an opposing team's winner's displayName/teamName from a bare id.
// Room itself is broadly readable, so storing the announcement fields directly here is what
// makes "announce the winner and reward on every screen" actually implementable for students.
export interface BossWinner {
  playerId: string
  displayName: string
  studentNumber: string
  teamId: string | null
  teamName: string | null
  correctCount: number
  totalTimeMs: number
  rewardItemType: MagicItemType
}

export interface TeamMeta {
  id: string
  name: string
}

// Milestone 4: 'main' is the normal 10-question flow; 'boss' is the 3-question
// "ศึกด่านชิงมนตรา" side-phase inserted between main question 5 and main question 6.
// room.status stays 'playing' throughout both — phase only distinguishes which question
// pool/timer fields are currently live, so every existing status==='playing' gate (magic
// activation eligibility, broadcast mode, saveAnswer, etc.) keeps working unchanged for boss
// too, without needing a new RoomStatus value threaded through the whole codebase.
export type GamePhase = 'main' | 'boss'

export const BOSS_QUESTION_COUNT = 3
export const DEFAULT_BOSS_QUESTION_DURATION_SECONDS = 10
// Boss is inserted after finishing this main question index (0-based) — "before main question
// 6" means after question 5 (index 4).
export const BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX = 4

export interface Room {
  roomCode: string
  status: RoomStatus
  currentRound: number
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  currentQuestionIndex: number
  questionDurationSeconds: number
  questionStartedAt: number | null
  // Milestone 2.2: set by the teacher's "ปิดรับคำตอบและเฉลยทันที" early-close action. When set,
  // it overrides the normal questionStartedAt + questionDurationSeconds deadline as the
  // effective deadline (see lib/gameFlow.ts's getQuestionDeadline) — answers lock immediately,
  // reveal begins immediately, and the reveal countdown runs from this timestamp instead. Reset
  // to null whenever a question starts or the room advances to the next one.
  questionClosedAt: number | null
  questionIds: string[]
  previousQuestionIds: string[]
  winner: Winner | null
  teacherSessionId: string
  teamCount: number
  teamsLocked: boolean
  teams: TeamMeta[]
  // Milestone 4: boss-phase state. bossQuestionIds/bossQuestionIndex/bossQuestionStartedAt
  // mirror questionIds/currentQuestionIndex/questionStartedAt so the SAME gameFlow.ts timer
  // helpers apply to boss questions unchanged (reusing the synchronized question/timer
  // architecture literally, not just conceptually). bossCompleted is the round-scoped
  // idempotency guard for ranking+reward resolution — set exactly once, on the transaction that
  // resolves the 3rd boss question, and reset to false on every new round.
  phase: GamePhase
  bossQuestionIds: string[]
  bossQuestionIndex: number
  bossQuestionStartedAt: number | null
  bossQuestionDurationSeconds: number
  bossCompleted: boolean
  bossWinner: BossWinner | null
  // Pause-and-continue gate: set true in the same write that resolves the 3rd boss question
  // (alongside bossCompleted/bossWinner), and left true until the teacher explicitly presses
  // "เล่นต่อ" (continueAfterBoss). While true, phase stays 'boss' — advanceBossQuestion's own
  // polling effect and service-side guard both no-op — so "next-question entry blocked for
  // every client" falls out of the existing phase==='boss' render gate for free, rather than
  // needing a separate flag threaded through GamePage/TeacherPage's phase checks.
  bossAwaitingContinue: boolean
}

export interface Player {
  id: string
  displayName: string
  studentNumber: string
  teamId: string | null
  joinedAt: number
  currentRound: number
  currentQuestionIndex: number
  // Raw correct-answer count out of 10 (unchanged Milestone 1 format — never rescaled in
  // storage). Every "X/100 knowledge score" display multiplies this by 10 at render time only,
  // so every existing rule/bound (score <= 10) and computation keeps working unchanged.
  score: number
  answers: AnswerRecord[]
  // Milestone 4: boss-phase answers, round-scoped (reset to [] on every new round). Never read
  // by knowledge-score or competition-score computations.
  bossAnswers: BossAnswerRecord[]
  submitted: boolean
  finishedAt: number | null
  elapsedMs: number | null
  status: PlayerStatus
  ownerUid: string
}

export interface PlayerSession {
  roomCode: string
  playerId: string
  displayName: string
  studentNumber: string
  role: 'student'
}

export interface TeacherSession {
  teacherSessionId: string
  roomCode?: string
  role: 'teacher'
}

export interface JoinInput {
  roomCode: string
  displayName: string
  studentNumber: string
}

export interface JoinResult {
  room: Room
  player: Player
}

export type Unsubscribe = () => void

// Milestone 2: team magic items. These affect only the competition score shown on the
// teacher leaderboard — never player.score, answer.isCorrect, or any individual record.
// Milestone 4.1: illusion is the exception to "affects only competition score" — it affects
// neither score nor correctness at all, only which choices are *displayed* to the holder's own
// team on the targeted question (see QueuedMagicEffect.hiddenChoiceId below).
export type MagicItemType = 'power_surge' | 'score_seal' | 'rose_shield' | 'illusion'
// power_surge  = มนตร์ทวีพลัง (own team, next eligible question: x2 — Milestone 4)
// score_seal   = มนตร์ผนึกคะแนน (chosen opponent, next eligible question: x0.5, stacks multiplicatively)
// rose_shield  = เกราะกุหลาบ (passive: blocks + consumes one incoming score_seal, one shield per seal)
// illusion     = มนตร์ลวงตา (own team, next eligible main question: hides one incorrect choice for
//                every team member — Milestone 4.1; never affects boss questions or scoring)

export type MagicEventStatus = 'queued' | 'applied' | 'blocked' | 'expired' | 'rejected'

// Milestone 4: counts, not individual instances. A team can now hold more than one of the same
// item (the boss mini-game can award a duplicate), and `available`/`consumed` are plain counts
// per item type rather than an array of {consumed: boolean} entries. This is also what makes
// firestore.rules able to validate "does this team have an unconsumed item of type X" at all —
// a fixed-shape map with a known field per item type is checkable with a direct field-path
// comparison; an arbitrary-length array of instances is not expressible in the rules language
// without an unbounded/unsound search.
export interface MagicInventoryEntry {
  available: number
  consumed: number
}

export type MagicInventory = Record<MagicItemType, MagicInventoryEntry>

export const createEmptyMagicInventory = (): MagicInventory => ({
  power_surge: { available: 0, consumed: 0 },
  score_seal: { available: 0, consumed: 0 },
  rose_shield: { available: 0, consumed: 0 },
  illusion: { available: 0, consumed: 0 },
})

export interface QueuedMagicEffect {
  id: string
  itemType: 'power_surge' | 'score_seal' | 'illusion'
  sourceTeamId: string
  targetTeamId: string
  affectedQuestionIndex: number
  createdAt: number
  // Milestone 4.1: only meaningful when itemType === 'illusion'. Chosen ONCE, server/service
  // side, at activation time (never recomputed on read, never independently randomized per
  // client) — this is what makes every team member see the exact same hidden choice, and makes
  // a refresh/retry unable to reroll it. Undefined for every other item type.
  hiddenChoiceId?: string
}

// Milestone 4: "after reveal, show a clear calculation" (raw team score / magic multiplier /
// competition score) must be visible to every team member, but a student can only ever `get`
// their OWN player doc under firestore.rules (no `list`), so correctness can't be aggregated
// across teammates client-side the way the teacher's dashboard already does. Persisting the
// resolved breakdown here — on the team's own already-broadly-readable magic doc, reset to null
// every round alongside inventory/queuedEffect — is what makes that requirement satisfiable
// without granting students any new access to other players' individual answers/correctness.
export interface TeamMagicBreakdown {
  questionIndex: number
  memberCount: number
  correctCount: number
  rawScore: number
  ownMultiplier: number
  sealCount: number
  hostileMultiplier: number
  competitionScore: number
}

export interface TeamMagicState {
  teamId: string
  // Milestone 4.1: no longer assigned randomly at lockTeams time — this is now the team's
  // ELECTED CAPTAIN, written only once voting finalizes (see CaptainVote/CaptainVoteProgress
  // below). null means "election still open, no captain yet" — every holder-gated action
  // (chooseStartingItem, activateItem) already rejects a null/mismatched holder, so this alone
  // is what makes those actions naturally unavailable until a captain is elected.
  magicHolderPlayerId: string | null
  // Milestone 4.1: monotonically increasing per team, bumped by lockTeams (including re-locks),
  // prepareNextRound/stopRound (a new round needs a fresh election), and a teacher's manual
  // reset. CaptainVote/CaptainVoteProgress docs carry the attempt they were cast under, so a
  // bump alone (no deletion of old vote docs) is what makes "reopen/reset the election" and "a
  // new round resets election state" both correct — stale votes from a superseded attempt are
  // simply never counted again, matching this codebase's existing round-scoping-by-field
  // pattern (see AnswerProgressEntry.currentRound) rather than introducing document deletion.
  captainElectionAttempt: number
  inventory: MagicInventory
  queuedEffect: QueuedMagicEffect | null
  lastResolvedBreakdown: TeamMagicBreakdown | null
}

// Milestone 4.1: one doc per VOTER (not per team) — mirrors AnswerProgressEntry's shape/rationale
// exactly. This is the PRIVATE record of who a student actually voted for: readable by the
// teacher and the voter themselves only (never broadly readable), which is what makes "students
// see only โหวตแล้ว X/Y คน, not live candidate totals" enforceable — a classmate's client has no
// rules-legal way to read this collection at all.
export interface CaptainVote {
  playerId: string
  teamId: string
  targetPlayerId: string
  electionAttempt: number
  votedAt: number
}

// Milestone 4.1: the broadly-readable counterpart to CaptainVote — same two-tier split already
// established by players (private) vs answerProgress (safe/broad). Deliberately carries no
// targetPlayerId, only "this player has voted" — this is what powers the X/Y voted-count display
// for every team member without revealing anyone's actual choice.
export interface CaptainVoteProgress {
  playerId: string
  teamId: string
  electionAttempt: number
  votedAt: number
}

export interface MagicEvent {
  id: string
  itemType: MagicItemType
  actorPlayerId: string
  sourceTeamId: string
  targetTeamId: string | null
  affectedQuestionIndex: number | null
  status: MagicEventStatus
  // The room.currentRound at the moment this event was created. Competition scoring filters on
  // this so an 'applied' event from a finished round (players.answers is wiped each round, but
  // the magicEvents log is kept for history) can never leak a multiplier into a later round.
  round: number
  createdAt: number
  resolvedAt: number | null
}

// Safe, display-only aggregates for the student lobby/game — built atomically by
// randomizeTeams/saveAnswer, never carrying ownerUid, answers, score, selected choices,
// correctness, or any other private player field. Students cannot `list` the private
// `players` collection, so these are what the live team roster and "teammates answered"
// counter are built from instead.
export interface TeamRosterMember {
  playerId: string
  displayName: string
}

export interface TeamRosterSummary {
  teamId: string
  teamName: string
  members: TeamRosterMember[]
}

// Team guardian name: captain-editable, teacher-resettable/overridable identity for a locked
// team, replacing the generic "ทีม N" label everywhere once set. Lives in its own collection
// (rooms/{roomCode}/teamNames/{teamId}) rather than on TeamMeta/TeamRosterSummary so a new,
// narrowly-scoped Firestore rule can grant the finalized captain write access without touching
// the existing rooms/rosters rules (both of which stay teacher-only) — see firestore.rules.
export interface TeamGuardianName {
  teamId: string
  name: string
  updatedAt: number
  updatedByPlayerId: string
}

export interface AnswerProgressEntry {
  playerId: string
  teamId: string
  questionId: string
  // The room.currentRound this entry was written under. Consumers must filter on this in
  // addition to questionId — a question can recur in a later round (selectRoundQuestions
  // doesn't guarantee exclusion once the pool is exhausted), and this collection is not wiped
  // on round transitions the way player.answers is, so a stale entry from an earlier round can
  // otherwise be misread as "already answered" for the new round's identical questionId.
  currentRound: number
  answeredAt: number
}
