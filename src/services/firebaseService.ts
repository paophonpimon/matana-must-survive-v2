import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import {
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type Timestamp,
} from 'firebase/firestore'
import { questions, questionsById } from '../data/questions'
import { bossQuestions } from '../data/bossQuestions'
import { ASSESSMENT_QUESTION_COUNT, POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { isValidSurveyValue, SURVEY_ITEMS, SURVEY_ITEM_COUNT } from '../data/surveyItems'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { evaluateChoice, generateRoomCode, selectRoundQuestions } from '../lib/game'
import { getRemainingMilliseconds } from '../lib/gameFlow'
import { computeBossRanking, pickRandomMagicItem, selectBossQuestions } from '../lib/boss'
import { computeTeamQuestionBreakdown, getMagicActivationWindow, hasAnyMagicItem, pickElectedCaptain, pickIllusionHiddenChoice } from '../lib/magic'
import { buildRoundHistoryEntry, roundHistoryEntryId } from '../lib/roundHistory'
import { buildTeamMetas, distributeTeamsEvenly, normalizeTeamGuardianName, validateTeamGuardianName } from '../lib/teamScoring'
import { ensureAnonymousUser, resolveOwnerUid } from './firebaseAuth'
import { resolveJoinPermissionDeniedMessage, type AnswerInput, type AnswerResult, type BossAnswerInput, type GameService, type PostTestAnswerInput, type PreTestAnswerInput, type RecallAnswerInput, type SurveyResponseInput } from './gameService'
import {
  BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX,
  DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  GAME_PHASES,
  MAX_BOSS_SECONDS_PER_QUESTION,
  MAX_RECALL_SECONDS_PER_ITEM,
  MIN_BOSS_SECONDS_PER_QUESTION,
  MIN_RECALL_SECONDS_PER_ITEM,
  RECALL_QUESTION_COUNT,
  RECALL_SECONDS_PER_ITEM,
  RECALL_TIMEOUT_CHOICE_ID,
  createEmptyMagicInventory,
} from '../types/game'
import type {
  AnswerProgressEntry,
  AnswerRecord,
  BossAnswerRecord,
  BossWinner,
  CaptainVote,
  CaptainVoteProgress,
  GamePhase,
  JoinInput,
  JoinResult,
  MagicEvent,
  MagicEventStatus,
  MagicInventory,
  MagicItemType,
  Player,
  QueuedMagicEffect,
  PreTestAnswerRecord,
  RoundHistoryAssessmentAnswer,
  RecallAnswerRecord,
  SurveyResponseRecord,
  Room,
  RoundHistoryEntry,
  TeamGuardianName,
  TeamMagicBreakdown,
  TeamMagicState,
  TeamMeta,
  TeamRosterSummary,
  Unsubscribe,
  Winner,
} from '../types/game'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

// Realtime staleness fix (remote-device boss/main-question transitions not rendering until a
// manual reload): iOS/iPadOS Safari aggressively suspends a backgrounded tab's underlying
// network connection (app-switch, screen lock, or just sitting idle long enough) and, unlike an
// explicit offline/online transition, the Firestore SDK does not always reliably detect that the
// suspended WebChannel stream died and needs to be torn down and re-opened — so every onSnapshot
// listener on that tab can silently stop receiving new server data indefinitely, even though the
// underlying documents keep changing correctly (confirmed: a manual reload immediately shows the
// current server state, proving the WRITE path and persisted data were never the problem — only
// this tab's live stream was). A `visibilitychange` handler that forces the network off and back
// on the moment the tab regains focus is the standard, documented mitigation for this exact class
// of bug: it makes the SDK actually re-establish its stream and re-deliver the current state to
// every active listener. This is event-driven (fires only on a real foreground transition), not a
// polling loop or a page reload.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void disableNetwork(db).then(() => enableNetwork(db))
  })
}

const toMillis = (value: unknown): number | null => {
  if (typeof value === 'number') return value
  if (value && typeof (value as Timestamp).toMillis === 'function') return (value as Timestamp).toMillis()
  return null
}

const mapBossWinner = (value: unknown): BossWinner | null => {
  if (!value || typeof value !== 'object') return null
  const winner = value as Record<string, unknown>
  return {
    playerId: String(winner.playerId ?? ''),
    displayName: String(winner.displayName ?? ''),
    studentNumber: String(winner.studentNumber ?? ''),
    teamId: winner.teamId == null ? null : String(winner.teamId),
    teamName: winner.teamName == null ? null : String(winner.teamName),
    correctCount: Number(winner.correctCount ?? 0),
    totalTimeMs: Number(winner.totalTimeMs ?? 0),
    rewardItemType: winner.rewardItemType as MagicItemType,
  }
}

const mapWinner = (value: unknown): Winner | null => {
  if (!value || typeof value !== 'object') return null
  const winner = value as Record<string, unknown>
  return {
    teamId: String(winner.teamId ?? ''),
    teamName: String(winner.teamName ?? ''),
    guardianName: String(winner.guardianName ?? ''),
    score: Number(winner.score ?? 0),
    finishedAt: toMillis(winner.finishedAt) ?? Date.now(),
    elapsedMs: Number(winner.elapsedMs ?? 0),
    round: Number(winner.round ?? 1),
  }
}

const mapTeamMeta = (value: unknown): TeamMeta => {
  const meta = (value ?? {}) as Record<string, unknown>
  return { id: String(meta.id ?? ''), name: String(meta.name ?? '') }
}

// A phase this build does not recognize is a real version mismatch — a room written by a newer
// client, or a stale allow-list here. Falling back silently is what made the preTest bug invisible
// in the browser, so the fallback now announces itself in the console instead of hiding.
const mapPhase = (rawPhase: unknown, rawStatus: unknown): GamePhase => {
  const phase = String(rawPhase)
  if ((GAME_PHASES as readonly string[]).includes(phase)) return phase as GamePhase
  if (rawPhase != null) console.warn(`[matana] unrecognized room phase "${phase}" — falling back by status`)
  return rawStatus === 'playing' ? 'main' : 'lobby'
}

const mapRoom = (data: DocumentData): Room => ({
  roomCode: String(data.roomCode),
  status: data.status as Room['status'],
  currentRound: Number(data.currentRound ?? 1),
  createdAt: toMillis(data.createdAt) ?? Date.now(),
  startedAt: toMillis(data.startedAt),
  completedAt: toMillis(data.completedAt),
  currentQuestionIndex: Number(data.currentQuestionIndex ?? 0),
  questionDurationSeconds: Number(data.questionDurationSeconds ?? 30),
  questionStartedAt: toMillis(data.questionStartedAt),
  questionClosedAt: toMillis(data.questionClosedAt),
  questionIds: Array.isArray(data.questionIds) ? data.questionIds.map(String) : [],
  previousQuestionIds: Array.isArray(data.previousQuestionIds) ? data.previousQuestionIds.map(String) : [],
  winner: mapWinner(data.winner),
  teacherSessionId: String(data.teacherSessionId ?? ''),
  teamCount: Number(data.teamCount ?? 0),
  teamsLocked: Boolean(data.teamsLocked),
  teams: Array.isArray(data.teams) ? data.teams.map(mapTeamMeta) : [],
  // Unknown/absent phase falls back by status, so a room written before the stage model existed
  // still resolves to a sane stage instead of silently reading as 'lobby' mid-game.
  //
  // The allow-list is GAME_PHASES, not a hand-maintained copy: when this was a literal array it
  // went stale the moment preTest/postTest/survey were added, so a room whose phase had genuinely
  // been written as 'preTest' read back as 'lobby' and the whole class appeared not to advance.
  phase: mapPhase(data.phase, data.status),
  recallQuestionDurationSeconds: Number(data.recallQuestionDurationSeconds ?? RECALL_SECONDS_PER_ITEM),
  recallQuestionIndex: Number(data.recallQuestionIndex ?? 0),
  recallQuestionStartedAt: toMillis(data.recallQuestionStartedAt),
  bossQuestionIds: Array.isArray(data.bossQuestionIds) ? data.bossQuestionIds.map(String) : [],
  bossQuestionIndex: Number(data.bossQuestionIndex ?? 0),
  bossQuestionStartedAt: toMillis(data.bossQuestionStartedAt),
  bossQuestionDurationSeconds: Number(data.bossQuestionDurationSeconds ?? DEFAULT_BOSS_QUESTION_DURATION_SECONDS),
  bossCompleted: Boolean(data.bossCompleted),
  bossWinner: mapBossWinner(data.bossWinner),
  bossAwaitingContinue: Boolean(data.bossAwaitingContinue),
})

// Shared by player.answers and player.bossAnswers (Milestone 4) — identical shape.
const mapAnswerRecordLike = (answer: Record<string, unknown>): AnswerRecord | BossAnswerRecord => ({
  questionId: String(answer.questionId),
  selectedChoiceId: String(answer.selectedChoiceId),
  isCorrect: Boolean(answer.isCorrect),
  answeredAt: toMillis(answer.answeredAt) ?? Number(answer.answeredAt ?? Date.now()),
  responseTimeMs: Number(answer.responseTimeMs ?? 0),
})

// Learning Layer: player.recallAnswers — leaner than mapAnswerRecordLike (no responseTimeMs,
// Recall is never speed-scored), keyed by conceptId instead of questionId.
const mapRecallAnswerRecord = (answer: Record<string, unknown>): RecallAnswerRecord => ({
  conceptId: String(answer.conceptId),
  selectedChoiceId: String(answer.selectedChoiceId),
  isCorrect: Boolean(answer.isCorrect),
  answeredAt: toMillis(answer.answeredAt) ?? Number(answer.answeredAt ?? Date.now()),
})

// Assessment Layer: pre/post-test records. Same lean shape as mapRecallAnswerRecord (no
// responseTimeMs — neither test is speed-scored) but keyed by questionId.
const mapAssessmentAnswerRecord = (answer: Record<string, unknown>): PreTestAnswerRecord => ({
  questionId: String(answer.questionId),
  selectedChoiceId: String(answer.selectedChoiceId),
  answeredAt: toMillis(answer.answeredAt) ?? Number(answer.answeredAt ?? Date.now()),
})

// No correctness field is read here at all — a survey response has no right answer.
const mapSurveyResponseRecord = (response: Record<string, unknown>): SurveyResponseRecord => ({
  itemId: String(response.itemId),
  value: String(response.value ?? ''),
  answeredAt: toMillis(response.answeredAt) ?? Number(response.answeredAt ?? Date.now()),
})

const mapPlayer = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): Player => {
  const data = snapshot.data()
  return {
    id: snapshot.id,
    displayName: String(data.displayName ?? ''),
    studentNumber: String(data.studentNumber ?? ''),
    teamId: data.teamId == null ? null : String(data.teamId),
    joinedAt: toMillis(data.joinedAt) ?? Date.now(),
    currentRound: Number(data.currentRound ?? 1),
    currentQuestionIndex: Number(data.currentQuestionIndex ?? 0),
    score: Number(data.score ?? 0),
    answers: Array.isArray(data.answers) ? data.answers.map(mapAnswerRecordLike) : [],
    bossAnswers: Array.isArray(data.bossAnswers) ? data.bossAnswers.map(mapAnswerRecordLike) : [],
    recallAnswers: Array.isArray(data.recallAnswers) ? data.recallAnswers.map(mapRecallAnswerRecord) : [],
    // Assessment Layer: absent on every player document written before this milestone, so an
    // empty array is the correct read — never a missing-field error.
    preTestAnswers: Array.isArray(data.preTestAnswers) ? data.preTestAnswers.map(mapAssessmentAnswerRecord) : [],
    postTestAnswers: Array.isArray(data.postTestAnswers) ? data.postTestAnswers.map(mapAssessmentAnswerRecord) : [],
    surveyResponses: Array.isArray(data.surveyResponses) ? data.surveyResponses.map(mapSurveyResponseRecord) : [],
    submitted: Boolean(data.submitted),
    finishedAt: toMillis(data.finishedAt),
    elapsedMs: data.elapsedMs == null ? null : Number(data.elapsedMs),
    status: data.status as Player['status'],
    ownerUid: String(data.ownerUid ?? ''),
  }
}

const stablePlayerId = (studentNumber: string): string => {
  let hash = 2166136261
  for (const character of studentNumber.trim().toLocaleLowerCase('th')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `player-${(hash >>> 0).toString(36)}`
}

const createMagicId = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`

// Milestone 4: inventory is a fixed-shape count map, not an array of instances — see
// types/game.ts's MagicInventory for why (mainly: firestore.rules can only validate a
// fixed-path field, not an unbounded array search).
const mapMagicInventory = (value: unknown): MagicInventory => {
  const raw = (value ?? {}) as Record<string, { available?: unknown; consumed?: unknown } | undefined>
  const empty = createEmptyMagicInventory()
  const result = createEmptyMagicInventory()
  ;(Object.keys(empty) as MagicItemType[]).forEach((itemType) => {
    const entry = raw[itemType]
    result[itemType] = {
      available: Number(entry?.available ?? 0),
      consumed: Number(entry?.consumed ?? 0),
    }
  })
  return result
}

const mapQueuedMagicEffect = (value: unknown): QueuedMagicEffect | null => {
  if (!value || typeof value !== 'object') return null
  const effect = value as Record<string, unknown>
  return {
    id: String(effect.id ?? ''),
    itemType: effect.itemType as 'power_surge' | 'score_seal' | 'illusion',
    sourceTeamId: String(effect.sourceTeamId ?? ''),
    targetTeamId: String(effect.targetTeamId ?? ''),
    affectedQuestionIndex: Number(effect.affectedQuestionIndex ?? 0),
    createdAt: Number(effect.createdAt ?? 0),
    ...(typeof effect.hiddenChoiceId === 'string' ? { hiddenChoiceId: effect.hiddenChoiceId } : {}),
  }
}

const mapCaptainVote = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): CaptainVote => {
  const data = snapshot.data()
  return {
    playerId: snapshot.id,
    teamId: String(data.teamId ?? ''),
    targetPlayerId: String(data.targetPlayerId ?? ''),
    electionAttempt: Number(data.electionAttempt ?? 0),
    votedAt: toMillis(data.votedAt) ?? Date.now(),
  }
}

const mapCaptainVoteProgress = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): CaptainVoteProgress => {
  const data = snapshot.data()
  return {
    playerId: snapshot.id,
    teamId: String(data.teamId ?? ''),
    electionAttempt: Number(data.electionAttempt ?? 0),
    votedAt: toMillis(data.votedAt) ?? Date.now(),
  }
}

const mapTeamMagicBreakdown = (value: unknown): TeamMagicBreakdown | null => {
  if (!value || typeof value !== 'object') return null
  const breakdown = value as Record<string, unknown>
  return {
    questionIndex: Number(breakdown.questionIndex ?? 0),
    memberCount: Number(breakdown.memberCount ?? 0),
    correctCount: Number(breakdown.correctCount ?? 0),
    rawScore: Number(breakdown.rawScore ?? 0),
    ownMultiplier: Number(breakdown.ownMultiplier ?? 1),
    sealCount: Number(breakdown.sealCount ?? 0),
    hostileMultiplier: Number(breakdown.hostileMultiplier ?? 1),
    competitionScore: Number(breakdown.competitionScore ?? 0),
  }
}

const mapTeamMagic = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): TeamMagicState => {
  const data = snapshot.data()
  return {
    teamId: snapshot.id,
    magicHolderPlayerId: data.magicHolderPlayerId == null ? null : String(data.magicHolderPlayerId),
    captainElectionAttempt: Number(data.captainElectionAttempt ?? 1),
    inventory: mapMagicInventory(data.inventory),
    queuedEffect: mapQueuedMagicEffect(data.queuedEffect),
    lastResolvedBreakdown: mapTeamMagicBreakdown(data.lastResolvedBreakdown),
  }
}

const mapMagicEvent = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): MagicEvent => {
  const data = snapshot.data()
  return {
    id: snapshot.id,
    itemType: data.itemType as MagicItemType,
    actorPlayerId: String(data.actorPlayerId ?? ''),
    sourceTeamId: String(data.sourceTeamId ?? ''),
    targetTeamId: data.targetTeamId == null ? null : String(data.targetTeamId),
    affectedQuestionIndex: data.affectedQuestionIndex == null ? null : Number(data.affectedQuestionIndex),
    status: data.status as MagicEventStatus,
    // Events written before round-tracking existed have no `round` field — default to 1 (the
    // only round that could have produced them), matching demoService's normalizeState.
    round: data.round == null ? 1 : Number(data.round),
    createdAt: toMillis(data.createdAt) ?? Date.now(),
    resolvedAt: toMillis(data.resolvedAt),
  }
}

const mapTeamRoster = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): TeamRosterSummary => {
  const data = snapshot.data()
  return {
    teamId: snapshot.id,
    teamName: String(data.teamName ?? ''),
    members: Array.isArray(data.members)
      ? data.members.map((member: Record<string, unknown>) => ({
          playerId: String(member.playerId ?? ''),
          displayName: String(member.displayName ?? ''),
        }))
      : [],
  }
}

// Teacher-configured durations are clamped service-side, not just in the form, so a
// hand-crafted request can't set a 0-second or absurdly long timer.
const clampRecallDuration = (seconds: number): number =>
  Math.max(MIN_RECALL_SECONDS_PER_ITEM, Math.min(MAX_RECALL_SECONDS_PER_ITEM, Math.round(seconds)))
const clampBossDuration = (seconds: number): number =>
  Math.max(MIN_BOSS_SECONDS_PER_QUESTION, Math.min(MAX_BOSS_SECONDS_PER_QUESTION, Math.round(seconds)))

const mapHistoryAssessmentAnswer = (entry: DocumentData): RoundHistoryAssessmentAnswer => ({
  questionId: String(entry.questionId ?? ''),
  selectedChoiceId: String(entry.selectedChoiceId ?? ''),
})

const mapRoundHistoryEntry = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): RoundHistoryEntry => {
  const data = snapshot.data()
  const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
  return {
    id: snapshot.id,
    round: Number(data.round ?? 0),
    playerId: String(data.playerId ?? ''),
    displayName: String(data.displayName ?? ''),
    studentNumber: String(data.studentNumber ?? ''),
    teamId: data.teamId == null ? null : String(data.teamId),
    teamName: String(data.teamName ?? ''),
    // LEGACY Recall-vs-Main fields: mapped ONLY when the stored document actually has them.
    // Coercing an absent field to 0/[] would fabricate the old shape on documents that never had
    // it, which is exactly what "new records must not present legacy learning evidence" forbids.
    ...(data.beforeCorrectCount === undefined ? {} : { beforeCorrectCount: Number(data.beforeCorrectCount) }),
    ...(data.afterCorrectCount === undefined ? {} : { afterCorrectCount: Number(data.afterCorrectCount) }),
    ...(data.improvedCount === undefined ? {} : { improvedCount: Number(data.improvedCount) }),
    ...(data.reviewCount === undefined ? {} : { reviewCount: Number(data.reviewCount) }),
    ...(data.improvedConceptIds === undefined ? {} : { improvedConceptIds: asStringArray(data.improvedConceptIds) }),
    ...(data.reviewConceptIds === undefined ? {} : { reviewConceptIds: asStringArray(data.reviewConceptIds) }),
    ...(Array.isArray(data.conceptResults)
      ? {
        conceptResults: data.conceptResults.map((entry: DocumentData) => ({
          conceptId: String(entry.conceptId ?? ''),
          beforeCorrect: Boolean(entry.beforeCorrect),
          afterCorrect: Boolean(entry.afterCorrect),
        })),
      }
      : {}),
    // Standalone Story Recall result — absent on rounds recorded before it existed, so it stays
    // absent rather than being coerced into an empty/zero shape that would read as a real result.
    ...(data.recallCorrectCount === undefined ? {} : { recallCorrectCount: Number(data.recallCorrectCount) }),
    ...(data.recallTotalCount === undefined ? {} : { recallTotalCount: Number(data.recallTotalCount) }),
    ...(Array.isArray(data.recallResults)
      ? {
        recallResults: data.recallResults.map((entry: DocumentData) => ({
          conceptId: String(entry.conceptId ?? ''),
          isCorrect: Boolean(entry.isCorrect),
          answered: Boolean(entry.answered),
        })),
      }
      : {}),
    knowledgeScore: Number(data.knowledgeScore ?? 0),
    knowledgeScore100: Number(data.knowledgeScore100 ?? 0),
    mainAnswers: Array.isArray(data.mainAnswers)
      ? data.mainAnswers.map((entry: DocumentData) => ({ questionId: String(entry.questionId ?? ''), isCorrect: Boolean(entry.isCorrect) }))
      : [],
    // Assessment Layer — likewise absent on rounds recorded before it existed.
    ...(data.preTestCorrectCount === undefined ? {} : { preTestCorrectCount: Number(data.preTestCorrectCount) }),
    ...(data.preTestTotalCount === undefined ? {} : { preTestTotalCount: Number(data.preTestTotalCount) }),
    ...(Array.isArray(data.preTestAnswers) ? { preTestAnswers: data.preTestAnswers.map(mapHistoryAssessmentAnswer) } : {}),
    ...(data.postTestCorrectCount === undefined ? {} : { postTestCorrectCount: Number(data.postTestCorrectCount) }),
    ...(data.postTestTotalCount === undefined ? {} : { postTestTotalCount: Number(data.postTestTotalCount) }),
    ...(Array.isArray(data.postTestAnswers) ? { postTestAnswers: data.postTestAnswers.map(mapHistoryAssessmentAnswer) } : {}),
    ...(Array.isArray(data.surveyResponses)
      ? { surveyResponses: data.surveyResponses.map((entry: DocumentData) => ({ itemId: String(entry.itemId ?? ''), value: String(entry.value ?? '') })) }
      : {}),
    completedAt: Number(data.completedAt ?? 0),
  }
}

// Queues this round's learning snapshot into an existing batch, for every player that doesn't
// already have one. Deliberately reads the existing history ids first so a re-run (or a second
// round-ending operation on the same round) is skipped rather than overwriting a finished
// record — the same idempotency the demo service gets from its keyed map.
const queueRoundHistorySnapshot = async (
  batch: ReturnType<typeof writeBatch>,
  roomCode: string,
  room: Room,
  playerSnapshots: QuerySnapshot<DocumentData>,
): Promise<void> => {
  const [existing, guardianNames] = await Promise.all([
    getDocs(collection(db, 'rooms', roomCode, 'roundHistory')),
    getDocs(collection(db, 'rooms', roomCode, 'teamNames')),
  ])
  const existingIds = new Set(existing.docs.map((entry) => entry.id))
  const guardianNameByTeamId = new Map(guardianNames.docs.map((entry) => [entry.id, mapTeamGuardianName(entry).name]))
  const completedAt = Date.now()
  playerSnapshots.docs.forEach((playerDocument) => {
    const player = mapPlayer(playerDocument)
    const id = roundHistoryEntryId(room.currentRound, player.id)
    if (existingIds.has(id)) return
    const teamName = player.teamId
      ? guardianNameByTeamId.get(player.teamId)?.trim() || room.teams.find((team) => team.id === player.teamId)?.name || ''
      : ''
    batch.set(doc(db, 'rooms', roomCode, 'roundHistory', id), buildRoundHistoryEntry(player, room.currentRound, teamName, completedAt))
  })
}

const mapTeamGuardianName = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): TeamGuardianName => {
  const data = snapshot.data()
  return {
    teamId: snapshot.id,
    name: String(data.name ?? ''),
    updatedAt: toMillis(data.updatedAt) ?? Date.now(),
    updatedByPlayerId: String(data.updatedByPlayerId ?? ''),
  }
}

const mapAnswerProgressEntry = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): AnswerProgressEntry => {
  const data = snapshot.data()
  return {
    playerId: snapshot.id,
    teamId: String(data.teamId ?? ''),
    questionId: String(data.questionId ?? ''),
    // Entries written before round-tracking existed have no `currentRound` field — default to
    // 1, matching demoService's normalizeState.
    currentRound: data.currentRound == null ? 1 : Number(data.currentRound),
    answeredAt: toMillis(data.answeredAt) ?? Date.now(),
  }
}

// Pure computation for resolving whatever was queued against `resolvedQuestionIndex` (leaving
// that question, either advancing or completing the round). Deliberately has no Firestore I/O
// of its own — advanceQuestion runs it INSIDE the same transaction that advances the room (via
// per-team transaction.get()/update() calls), so magic resolution and the room's advance either
// both commit or neither does. That closes the previous failure window where the room could
// move on while a queued effect for the question just left silently never got resolved (or the
// reverse: resolution landing but the room failing to advance). A team can be touched both as an
// effect's source (consuming its own item) and as another team's hostile target (its shield
// consumed) in the same pass, so mutations are accumulated here first and the caller applies
// exactly one update per touched doc — never two, which would let the second clobber the first.
//
// Milestone 4: multiple DIFFERENT teams may each have a score_seal queued against the SAME
// target+question (stacking is allowed — there is no "already targeted" restriction at
// activation time anymore), so resolution is split into passes: (1) clear every queued slot +
// consume each source team's own item regardless of outcome, (2) power_surge always applies (a
// team's own buff is never blockable), (3) score_seals are grouped by target team and resolved
// against that team's available shields — each available shield blocks exactly one seal
// (consuming it); any seals beyond the available shield count still apply. Sorted by
// sourceTeamId for deterministic (test-reproducible) shield-consumption order — which specific
// seal ends up 'blocked' vs 'applied' depends on this order, but the FINAL multiplier never
// does, since only the blocked-vs-applied COUNT matters there.
const computeMagicResolution = (
  magicByTeamId: Map<string, TeamMagicState>,
  resolvedQuestionIndex: number,
): { touchedTeamIds: Set<string>; eventOutcomes: Map<string, 'applied' | 'blocked'> } => {
  const touchedTeamIds = new Set<string>()
  const eventOutcomes = new Map<string, 'applied' | 'blocked'>()

  const consumeOne = (teamId: string, itemType: MagicItemType): void => {
    const entry = magicByTeamId.get(teamId)?.inventory[itemType]
    if (entry && entry.available > 0) {
      entry.available -= 1
      entry.consumed += 1
      touchedTeamIds.add(teamId)
    }
  }

  const effectsThisQuestion: Array<{ magic: TeamMagicState; effect: QueuedMagicEffect }> = []
  for (const magic of magicByTeamId.values()) {
    const effect = magic.queuedEffect
    if (!effect || effect.affectedQuestionIndex !== resolvedQuestionIndex) continue
    effectsThisQuestion.push({ magic, effect })
  }
  if (effectsThisQuestion.length === 0) return { touchedTeamIds, eventOutcomes }

  for (const { magic, effect } of effectsThisQuestion) {
    touchedTeamIds.add(magic.teamId)
    magic.queuedEffect = null
    consumeOne(magic.teamId, effect.itemType)
  }

  // power_surge and illusion are both self-only buffs — never blockable, always applied.
  // Illusion contributes no score multiplier at all (computeAppliedMagicMultipliers in
  // lib/magic.ts only branches on power_surge/score_seal, so illusion is correctly ignored
  // there) — marking it 'applied' here only affects event-history/UI visibility, never scoring.
  for (const { effect } of effectsThisQuestion) {
    if (effect.itemType === 'power_surge' || effect.itemType === 'illusion') eventOutcomes.set(effect.id, 'applied')
  }

  const sealsByTarget = new Map<string, QueuedMagicEffect[]>()
  for (const { effect } of effectsThisQuestion) {
    if (effect.itemType !== 'score_seal') continue
    const list = sealsByTarget.get(effect.targetTeamId) ?? []
    list.push(effect)
    sealsByTarget.set(effect.targetTeamId, list)
  }
  sealsByTarget.forEach((seals, targetTeamId) => {
    const targetMagic = magicByTeamId.get(targetTeamId)
    const sorted = [...seals].sort((a, b) => a.sourceTeamId.localeCompare(b.sourceTeamId))
    for (const effect of sorted) {
      const shieldEntry = targetMagic?.inventory.rose_shield
      if (shieldEntry && shieldEntry.available > 0) {
        shieldEntry.available -= 1
        shieldEntry.consumed += 1
        touchedTeamIds.add(targetTeamId)
        eventOutcomes.set(effect.id, 'blocked')
      } else {
        eventOutcomes.set(effect.id, 'applied')
      }
    }
  })

  return { touchedTeamIds, eventOutcomes }
}

// closeRoom: the game is over, so only expire whatever was still queued (audit correctness) —
// no next round to reset inventory for.
const expireQueuedMagicEffects = async (roomCode: string): Promise<void> => {
  const magicSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'magic'))
  const batch = writeBatch(db)
  let hasWrites = false
  magicSnapshots.docs.forEach((document) => {
    const magic = mapTeamMagic(document)
    if (!magic.queuedEffect) return
    hasWrites = true
    batch.update(document.ref, { queuedEffect: null })
    batch.update(doc(db, 'rooms', roomCode, 'magicEvents', magic.queuedEffect.id), { status: 'expired', resolvedAt: serverTimestamp() })
  })
  if (hasWrites) await batch.commit()
}

// prepareNextRound/stopRound: a new round means Q1-Q10 indices reset, so any still-queued
// effect from the old round is meaningless (expired) and every team's inventory resets —
// requirement 2 frames starting-item choice as happening fresh "before the teacher starts the
// game" each time. The holder itself is untouched — only a fresh lockTeams re-picks holders.
const resetMagicForNewRound = async (roomCode: string): Promise<void> => {
  const magicSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'magic'))
  if (magicSnapshots.empty) return
  const batch = writeBatch(db)
  magicSnapshots.docs.forEach((document) => {
    const magic = mapTeamMagic(document)
    // Milestone 4.1: a new round needs a fresh captain election too — the old captain does not
    // automatically carry over (matches "starting-item choice happens fresh each round").
    batch.update(document.ref, {
      inventory: createEmptyMagicInventory(),
      queuedEffect: null,
      lastResolvedBreakdown: null,
      magicHolderPlayerId: null,
      captainElectionAttempt: magic.captainElectionAttempt + 1,
    })
    if (magic.queuedEffect) {
      batch.update(doc(db, 'rooms', roomCode, 'magicEvents', magic.queuedEffect.id), { status: 'expired', resolvedAt: serverTimestamp() })
    }
  })
  await batch.commit()
}

// Dev-only diagnostic for the exact bug class this module guards against: a uid captured
// earlier (React state, a function argument) drifting from the live auth.currentUser by the
// time a write actually happens. Deliberately logs only uids/operation/roomCode — never the
// firebaseConfig, tokens, or any other credential material.
const logPermissionDenied = (operation: string, contextUid: string, roomCode: string): void => {
  if (!import.meta.env.DEV) return
  const authUid = auth.currentUser?.uid ?? null
  console.warn('[firebase-auth] permission-denied', {
    operation,
    contextUid,
    authUid,
    matched: authUid === contextUid,
    roomCode,
  })
}

// Milestone 4: the boss-phase fields a brand-new room always starts with, or that a new round
// resets to — factored out so createRoom / prepareNextRound / stopRound can never drift on
// what "fresh" means.
// Learning Layer: `phase` defaults to 'recall' (not 'main') — the mandatory individual Story
// Recall phase every round now begins with, before startMainAfterRecall ever moves it to 'main'.
const createFreshBossFields = (): Pick<
  Room,
  | 'phase'
  | 'bossQuestionIds'
  | 'bossQuestionIndex'
  | 'bossQuestionStartedAt'
  | 'bossQuestionDurationSeconds'
  | 'bossCompleted'
  | 'bossWinner'
  | 'bossAwaitingContinue'
> => ({
  phase: 'lobby',
  bossQuestionIds: [],
  bossQuestionIndex: 0,
  bossQuestionStartedAt: null,
  bossQuestionDurationSeconds: DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  bossCompleted: false,
  bossWinner: null,
  bossAwaitingContinue: false,
})

export class FirebaseGameService implements GameService {
  readonly isDemo = false

  async ensureSession(): Promise<string> {
    // ensureAnonymousUser is the single, module-level, de-duplicated entry point to
    // anonymous sign-in — it is what makes this safe to call from a GameProvider effect that
    // React (StrictMode) or a fresh page load may invoke more than once without ever
    // producing two competing signInAnonymously calls (and therefore two different uids).
    try {
      const user = await ensureAnonymousUser(auth)
      return user.uid
    } catch {
      throw new Error('ผู้ใช้:ไม่สามารถเริ่มเซสชันแบบไม่ระบุตัวตนได้ กรุณาลองใหม่')
    }
  }

  async createRoom(teacherSessionId: string): Promise<Room> {
    // The teacher's uid captured in React state can drift from the live auth.currentUser
    // (see ensureAnonymousUser) — never trust it as-is for the value written to
    // teacherSessionId, which is what every later isTeacher(roomCode) rule check compares
    // against request.auth.uid.
    const resolvedTeacherSessionId = await resolveOwnerUid(auth, teacherSessionId)
    const COLLISION_MESSAGE = 'ผู้ใช้:รหัสห้องซ้ำ กรุณาลองสร้างอีกครั้ง'
    // 4-digit codes (0000-9999) are a much smaller space than the old 6-character format, so a
    // collision — while still unlikely — is no longer astronomically rare. The getDoc pre-check
    // loop below finds a probably-free code; the transaction is what actually guarantees "never
    // overwrite an existing room" (it re-checks existence and set()s atomically, closing the
    // TOCTOU gap between the pre-check and the write). This outer loop is what turns a
    // transaction-detected collision into "generate another code and retry" end-to-end, instead
    // of surfacing a hard failure to the teacher on the rare unlucky race.
    for (let outerAttempt = 0; outerAttempt < 5; outerAttempt += 1) {
      let roomCode = generateRoomCode()
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!(await getDoc(doc(db, 'rooms', roomCode))).exists()) break
        roomCode = generateRoomCode()
      }
      const room: Room = {
        roomCode,
        status: 'waiting',
        currentRound: 1,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        currentQuestionIndex: 0,
        questionDurationSeconds: 30,
        questionStartedAt: null,
        questionClosedAt: null,
    recallQuestionDurationSeconds: RECALL_SECONDS_PER_ITEM,
    recallQuestionIndex: 0,
    recallQuestionStartedAt: null,
        ...createFreshBossFields(),
        questionIds: selectRoundQuestions(questions),
        previousQuestionIds: [],
        winner: null,
        teacherSessionId: resolvedTeacherSessionId,
        teamCount: 0,
        teamsLocked: false,
        teams: [],
      }
      try {
        await runTransaction(db, async (transaction) => {
          const roomRef = doc(db, 'rooms', roomCode)
          if ((await transaction.get(roomRef)).exists()) throw new Error(COLLISION_MESSAGE)
          transaction.set(roomRef, { ...room, createdAt: serverTimestamp() })
        })
        return room
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'permission-denied') logPermissionDenied('createRoom', resolvedTeacherSessionId, roomCode)
        const isCollision = error instanceof Error && error.message === COLLISION_MESSAGE
        if (!isCollision || outerAttempt === 4) throw error
      }
    }
    throw new Error(COLLISION_MESSAGE)
  }

  async joinRoom(input: JoinInput, requestedOwnerUid: string): Promise<JoinResult> {
    const roomCode = input.roomCode.trim().toUpperCase()
    const studentNumber = input.studentNumber.trim()
    const playerId = stablePlayerId(studentNumber)
    const roomRef = doc(db, 'rooms', roomCode)
    const playerRef = doc(db, 'rooms', roomCode, 'players', playerId)
    // The uid captured in React state (from GameContext) can drift from the live
    // auth.currentUser — never write a stale ownerUid to Firestore, since that's exactly
    // what the security rules compare request.auth.uid against.
    const ownerUid = await resolveOwnerUid(auth, requestedOwnerUid)
    try {
      return await runTransaction(db, async (transaction) => {
        const roomSnapshot = await transaction.get(roomRef)
        if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
        const room = mapRoom(roomSnapshot.data())
        if (room.status === 'closed') throw new Error('ผู้ใช้:ห้องกิจกรรมสิ้นสุดแล้ว')

        // Read the deterministic player doc BEFORE checking teamsLocked, so a returning
        // student is never blocked by a lock that happened after they originally joined.
        const playerSnapshot = await transaction.get(playerRef)
        if (playerSnapshot.exists()) {
          const existing = mapPlayer(playerSnapshot)
          if (existing.ownerUid === ownerUid) return { room, player: existing }
          // A different owner already used this student number — reject explicitly instead
          // of ever returning (or attempting to overwrite) another student's record.
          throw new Error('ผู้ใช้:เลขที่นักเรียนนี้ถูกใช้แล้ว')
        }

        if (room.status !== 'waiting') throw new Error('ผู้ใช้:เกมกำลังดำเนินอยู่ ไม่สามารถเข้าร่วมรอบนี้ได้')
        if (room.teamsLocked) throw new Error('ผู้ใช้:ทีมถูกล็อกแล้ว กรุณาติดต่อครู')

        const player: Player = {
          id: playerId,
          displayName: input.displayName.trim(),
          studentNumber,
          teamId: null,
          joinedAt: Date.now(),
          currentRound: room.currentRound,
          currentQuestionIndex: 0,
          score: 0,
          answers: [],
          bossAnswers: [],
          recallAnswers: [],
          preTestAnswers: [],
          postTestAnswers: [],
          surveyResponses: [],
          submitted: false,
          finishedAt: null,
          elapsedMs: null,
          status: 'waiting',
          ownerUid,
        }
        transaction.set(playerRef, { ...player, joinedAt: serverTimestamp() })
        return { room, player }
      })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'permission-denied') {
        // The transaction's own duplicate-number branch above already throws its own
        // 'ผู้ใช้:...' Error *inside* the transaction before Firestore ever needs to deny
        // anything, so a raw permission-denied reaching here means the security rules
        // themselves refused the read/write — which happens when a genuinely new (never
        // seen before) player's deterministic doc get is attempted while teamsLocked is
        // true (the rules only grant that get to the teacher, the doc's existing owner, or
        // a waiting-and-unlocked room). Re-read the room outside the transaction and let the
        // pure resolver decide the cause instead of assuming a duplicate student number.
        const roomSnapshot = await getDoc(roomRef)
        const room = roomSnapshot.exists() ? mapRoom(roomSnapshot.data()) : null
        logPermissionDenied('joinRoom', ownerUid, roomCode)
        const message = resolveJoinPermissionDeniedMessage(room)
        if (message) throw new Error(message)
      }
      throw error
    }
  }

  subscribeRoom(roomCode: string, listener: (room: Room | null) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      doc(db, 'rooms', roomCode.toUpperCase()),
      (snapshot) => listener(snapshot.exists() ? mapRoom(snapshot.data()) : null),
      () => onError('การเชื่อมต่อขัดข้อง กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribePlayers(roomCode: string, listener: (players: Player[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      collection(db, 'rooms', roomCode.toUpperCase(), 'players'),
      (snapshot) => listener(snapshot.docs.map(mapPlayer).sort((a, b) => a.joinedAt - b.joinedAt)),
      () => onError('ไม่สามารถโหลดรายชื่อผู้เล่นได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribePlayer(roomCode: string, playerId: string, listener: (player: Player | null) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      doc(db, 'rooms', roomCode.toUpperCase(), 'players', playerId),
      (snapshot) => listener(snapshot.exists() ? mapPlayer(snapshot) : null),
      () => onError('ไม่สามารถโหลดข้อมูลผู้เล่นได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeTeamMagic(roomCode: string, teamId: string, listener: (magic: TeamMagicState | null) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      doc(db, 'rooms', roomCode.toUpperCase(), 'magic', teamId),
      (snapshot) => listener(snapshot.exists() ? mapTeamMagic(snapshot) : null),
      () => onError('ไม่สามารถโหลดข้อมูลไอเทมของทีมได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeAllTeamMagic(roomCode: string, listener: (magic: TeamMagicState[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      collection(db, 'rooms', roomCode.toUpperCase(), 'magic'),
      (snapshot) => listener(snapshot.docs.map(mapTeamMagic)),
      () => onError('ไม่สามารถโหลดข้อมูลมนตราของทุกทีมได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeMagicEvents(roomCode: string, listener: (events: MagicEvent[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      collection(db, 'rooms', roomCode.toUpperCase(), 'magicEvents'),
      (snapshot) => listener(snapshot.docs.map(mapMagicEvent).sort((a, b) => b.createdAt - a.createdAt)),
      () => onError('ไม่สามารถโหลดประวัติมนตราได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeTeamRoster(roomCode: string, teamId: string, listener: (roster: TeamRosterSummary | null) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      doc(db, 'rooms', roomCode.toUpperCase(), 'rosters', teamId),
      (snapshot) => listener(snapshot.exists() ? mapTeamRoster(snapshot) : null),
      () => onError('ไม่สามารถโหลดรายชื่อทีมได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeTeamAnswerProgress(roomCode: string, teamId: string, listener: (entries: AnswerProgressEntry[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      query(collection(db, 'rooms', roomCode.toUpperCase(), 'answerProgress'), where('teamId', '==', teamId)),
      (snapshot) => listener(snapshot.docs.map(mapAnswerProgressEntry)),
      () => onError('ไม่สามารถโหลดความคืบหน้าของทีมได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  async startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number, bossQuestionDurationSeconds?: number): Promise<void> {
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    if (playerSnapshots.empty) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังเริ่มภารกิจไม่ได้')
    // Each holder must choose a starting item before the game can start. Checked outside the
    // transaction (best-effort, matching the existing players.empty check above), since
    // reading a whole collection isn't possible from inside a Firestore transaction.
    const roomSnapshotForMagicCheck = await getDoc(doc(db, 'rooms', roomCode))
    if (roomSnapshotForMagicCheck.exists()) {
      const roomForMagicCheck = mapRoom(roomSnapshotForMagicCheck.data())
      if (roomForMagicCheck.teams.length > 0) {
        const magicSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'magic'))
        const magicByTeamId = new Map(magicSnapshots.docs.map((document) => [document.id, mapTeamMagic(document)]))
        // Milestone 4.1: every team must have finished electing a captain before the game can
        // start (chooseStartingItem/activateItem are already holder-gated, so this surfaces a
        // clear, specific error instead of relying on that indirect consequence).
        const teamsWithoutCaptain = roomForMagicCheck.teams.filter((team) => magicByTeamId.get(team.id)?.magicHolderPlayerId == null)
        if (teamsWithoutCaptain.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกหัวหน้าทีมก่อนเริ่มภารกิจ')
        const teamsWithoutStartingItem = roomForMagicCheck.teams.filter((team) => !hasAnyMagicItem(magicByTeamId.get(team.id)?.inventory ?? createEmptyMagicInventory()))
        if (teamsWithoutStartingItem.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกไอเทมเริ่มต้นก่อนเริ่มภารกิจ')
        // Every team must also have a guardian name set before the game can start (same
        // best-effort outside-transaction shape as the two checks above).
        const teamNameSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'teamNames'))
        const teamIdsWithName = new Set(
          teamNameSnapshots.docs.map((document) => mapTeamGuardianName(document)).filter((entry) => entry.name.trim().length > 0).map((entry) => entry.teamId),
        )
        const teamsWithoutName = roomForMagicCheck.teams.filter((team) => !teamIdsWithName.has(team.id))
        if (teamsWithoutName.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องตั้งชื่อทีมก่อนเริ่มภารกิจ')
      }
    }
    await runTransaction(db, async (transaction) => {
      const roomRef = doc(db, 'rooms', roomCode)
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status === 'playing') throw new Error('ผู้ใช้:ภารกิจกำลังดำเนินอยู่แล้ว')
      if (room.status !== 'waiting') throw new Error('ผู้ใช้:กรุณาเตรียมภารกิจรอบใหม่ก่อนเริ่ม')
      // Main can only start from the team-setup stage — i.e. Story Recall has already run this
      // round. This is the gate that makes "Recall before team setup, Main after it" structural
      // rather than merely the order the teacher happens to click things in.
      if (room.phase !== 'teamSetup') throw new Error('ผู้ใช้:กรุณาทำทบทวนเรื่องราวและจัดทีมให้เสร็จก่อนเริ่มเกมหลัก')
      if (!room.teamsLocked) throw new Error('ผู้ใช้:กรุณาล็อกทีมก่อนเริ่มภารกิจ')
      transaction.update(roomRef, {
        status: 'playing',
        startedAt: serverTimestamp(),
        completedAt: null,
        phase: 'main',
        currentQuestionIndex: 0,
        questionDurationSeconds: Math.max(5, Math.min(600, Math.round(questionDurationSeconds))),
        ...(bossQuestionDurationSeconds == null ? {} : { bossQuestionDurationSeconds: clampBossDuration(bossQuestionDurationSeconds) }),
        questionStartedAt: serverTimestamp(),
        questionClosedAt: null,
        winner: null,
      })
    })
    const batch = writeBatch(db)
    playerSnapshots.docs.forEach((playerDocument) => batch.update(playerDocument.ref, { status: 'playing' }))
    await batch.commit()
  }

  // Pre-game stage 1 -> 2: 'lobby' -> 'recall'. Teacher-only, fired by "เริ่มทบทวนเรื่องราว" once
  // enough students have joined. Deliberately requires NO teams, captain, item, or team name —
  // Story Recall is a pre-team individual learning phase, so the only precondition is that at
  // least one student is present. Idempotent by stage check: a stale/duplicate call once already
  // past 'lobby' is a safe no-op rather than a restart that would wipe progress.
  // lobby -> preTest. Teacher-only and idempotent: a duplicate click from any stage other than
  // 'lobby' is a safe no-op, mirroring startRecall/startTeamSetup. Starts no timer — the pre-test
  // is self-paced, and nothing about it is competitive.
  async startPreTest(roomCode: string, teacherSessionId: string): Promise<void> {
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    if (playerSnapshots.empty) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังเริ่มแบบทดสอบไม่ได้')
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'waiting') throw new Error('ผู้ใช้:เริ่มแบบทดสอบก่อนเรียนได้เฉพาะช่วงห้องรอ')
      if (room.phase !== 'lobby') return
      transaction.update(roomRef, { phase: 'preTest' })
    })
  }

  async startRecall(roomCode: string, teacherSessionId: string, recallQuestionDurationSeconds?: number): Promise<void> {
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    if (playerSnapshots.empty) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังเริ่มทบทวนเรื่องราวไม่ได้')
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'waiting') throw new Error('ผู้ใช้:เริ่มทบทวนเรื่องราวได้เฉพาะช่วงห้องรอ')
      // Recall now follows the pre-test, so this is the preTest -> recall step. A stale/duplicate
      // click from any other stage is a safe no-op, exactly as the lobby guard used to be.
      if (room.phase !== 'preTest') return
      transaction.update(roomRef, {
        phase: 'recall',
        ...(recallQuestionDurationSeconds == null ? {} : { recallQuestionDurationSeconds: clampRecallDuration(recallQuestionDurationSeconds) }),
        // Question 1 starts for the whole room at this instant.
        recallQuestionIndex: 0,
        recallQuestionStartedAt: serverTimestamp(),
      })
    })
  }

  // Room-synchronized Recall advance, mirroring advanceQuestion's shape exactly: the caller names
  // the index it believes is live, and anything else is a silent no-op. That expected-index guard
  // is what makes duplicate timer callbacks unable to skip a question. Advancing past the last
  // item leaves recallQuestionIndex at RECALL_QUESTION_COUNT with no start time.
  async advanceRecallQuestion(roomCode: string, teacherSessionId: string, expectedRecallIndex: number): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (
        room.status !== 'waiting'
        || room.phase !== 'recall'
        || room.recallQuestionIndex !== expectedRecallIndex
        || room.recallQuestionIndex >= RECALL_QUESTION_COUNT
      ) {
        return
      }
      const nextIndex = room.recallQuestionIndex + 1
      transaction.update(roomRef, {
        recallQuestionIndex: nextIndex,
        recallQuestionStartedAt: nextIndex >= RECALL_QUESTION_COUNT ? null : serverTimestamp(),
      })
    })
  }

  // Pre-game stage 2 -> 3: 'recall' -> 'teamSetup'. Teacher-only, fired by "จัดทีมและเตรียมเกม".
  // Hands off to the EXISTING team workflow completely unchanged (randomize -> lock -> captain ->
  // guardian name -> starting item -> startRoom), which all already gate on status === 'waiting'
  // and therefore needed no changes at all. Recall answers are untouched here — recallAnswers is
  // only ever reset on a genuine new round (prepareNextRound/stopRound), so the review result survives
  // team setup, Main, and Boss for the end-of-game Learning Summary.
  async startTeamSetup(roomCode: string, teacherSessionId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'waiting') throw new Error('ผู้ใช้:จัดทีมได้เฉพาะช่วงห้องรอ')
      if (room.phase !== 'recall') return
      // Gated on the shared Recall timeline finishing, not on every student having answered.
      if (room.recallQuestionIndex < RECALL_QUESTION_COUNT) {
        throw new Error('ผู้ใช้:ต้องทำทบทวนเรื่องราวให้ครบทั้ง 5 ข้อก่อนจัดทีม')
      }
      transaction.update(roomRef, { phase: 'teamSetup' })
    })
  }

  // Learning Layer: individual, non-competitive, first-answer-locked — mirrors saveBossAnswer's
  // idempotent "already answered -> silent no-op" shape, but with its own no-skip guard
  // (expectedRecallIndex must be exactly player.recallAnswers.length, and must name the concept
  // RECALL_QUESTIONS actually holds at that position) instead of a room-synchronized index/timer,
  // since Recall has neither: every student progresses through the same fixed 5 questions at
  // their own pace. Never touches player.answers/score/bossAnswers, never reads magic/team data —
  // this is what makes "no competitive points, no team-score impact, no magic, no speed scoring"
  // true by construction, the same way BossAnswerRecord's separation already does for boss.
  async saveRecallAnswer(roomCode: string, playerId: string, answer: RecallAnswerInput): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const playerRef = doc(db, 'rooms', roomCode, 'players', playerId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, playerSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(playerRef)])
      if (!roomSnapshot.exists() || !playerSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลห้องหรือผู้เล่นของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const player = mapPlayer(playerSnapshot)
      // Recall runs while the room is still 'waiting' (nothing competitive has started) — phase
      // is the authority on the stage, status merely confirms Main/Boss aren't running.
      if (room.status !== 'waiting' || room.phase !== 'recall') {
        throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงทบทวนเรื่องราว')
      }
      // Idempotent: a duplicate submit for a concept already answered is a safe no-op — the
      // FIRST answer is what's persisted, matching the spec's "first answer is persisted"
      // requirement.
      if (player.recallAnswers.some((item) => item.conceptId === answer.conceptId)) return
      // The ROOM's current question is the authority now, not the player's own progress: a
      // student who missed earlier items is still on the same shared question as everyone else,
      // so their recallAnswers.length no longer tracks the index.
      const expectedQuestion = RECALL_QUESTIONS[room.recallQuestionIndex]
      if (
        room.recallQuestionIndex !== answer.expectedRecallIndex ||
        !expectedQuestion ||
        expectedQuestion.id !== answer.conceptId
      ) {
        throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
      }
      // Answers lock when the shared countdown expires, the same way saveAnswer guards Main.
      const recallTiming = {
        questionStartedAt: room.recallQuestionStartedAt,
        questionDurationSeconds: room.recallQuestionDurationSeconds,
        questionClosedAt: null,
      }
      if (!room.recallQuestionStartedAt || getRemainingMilliseconds(recallTiming, Date.now()) <= 0) {
        throw new Error('ผู้ใช้:หมดเวลาตอบข้อนี้แล้ว')
      }
      // Countdown expiry: the client submits RECALL_TIMEOUT_CHOICE_ID instead of a real choice,
      // and the item is persisted as unanswered -> incorrect in the review result. Handled before
      // evaluateChoice because the sentinel is deliberately not a valid choice id.
      const isTimeout = answer.selectedChoiceId === RECALL_TIMEOUT_CHOICE_ID
      const evaluated = isTimeout ? { valid: true, isCorrect: false } : evaluateChoice(expectedQuestion, answer.selectedChoiceId)
      if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
      const record: RecallAnswerRecord = {
        conceptId: answer.conceptId,
        selectedChoiceId: answer.selectedChoiceId,
        isCorrect: evaluated.isCorrect,
        answeredAt: Date.now(),
      }
      const recallAnswers = [...player.recallAnswers, record]
      transaction.update(playerRef, { recallAnswers })
    })
  }

  // Assessment Layer (Milestone 1). Each mirrors saveRecallAnswer's transaction shape: read room +
  // player together, require this write's own phase, reject an out-of-order submit, then update
  // exactly one field. The single-field update is what lets firestore.rules validate these with a
  // hasOnly() check per phase, the same way the recall/main/boss branches already work.
  //
  // Correctness arrives from the caller here rather than being evaluated server-side, because no
  // assessment question bank exists yet in this milestone. Once the banks land, these should
  // evaluate against them the way saveRecallAnswer uses evaluateChoice — see the report.
  async savePreTestAnswer(roomCode: string, playerId: string, answer: PreTestAnswerInput): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const playerRef = doc(db, 'rooms', roomCode, 'players', playerId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, playerSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(playerRef)])
      if (!roomSnapshot.exists() || !playerSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลห้องหรือผู้เล่นของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const player = mapPlayer(playerSnapshot)
      if (room.phase !== 'preTest') throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงแบบทดสอบก่อนเรียน')
      // The bank is the only authority on correctness — never the caller.
      const expectedQuestion = PRE_TEST_QUESTIONS[player.preTestAnswers.length]
      if (player.preTestAnswers.length >= ASSESSMENT_QUESTION_COUNT || !expectedQuestion) {
        throw new Error('ผู้ใช้:ทำแบบทดสอบครบทุกข้อแล้ว')
      }
      // Idempotent: the first answer for a question is the one that counts.
      if (player.preTestAnswers.some((item) => item.questionId === answer.questionId)) return
      // Sequential: the submitted question must be the next unanswered item, and the caller's
      // expected index must agree with the server's own count.
      if (player.preTestAnswers.length !== answer.expectedIndex || expectedQuestion.id !== answer.questionId) {
        throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
      }
      const evaluated = evaluateChoice(expectedQuestion, answer.selectedChoiceId)
      if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
      const preTestAnswers = [...player.preTestAnswers, {
        questionId: answer.questionId,
        selectedChoiceId: answer.selectedChoiceId,
        answeredAt: Date.now(),
      }]
      transaction.update(playerRef, { preTestAnswers })
    })
  }

  async savePostTestAnswer(roomCode: string, playerId: string, answer: PostTestAnswerInput): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const playerRef = doc(db, 'rooms', roomCode, 'players', playerId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, playerSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(playerRef)])
      if (!roomSnapshot.exists() || !playerSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลห้องหรือผู้เล่นของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const player = mapPlayer(playerSnapshot)
      if (room.phase !== 'postTest') throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงแบบทดสอบหลังเรียน')
      // The bank is the only authority on correctness — never the caller.
      const expectedQuestion = POST_TEST_QUESTIONS[player.postTestAnswers.length]
      if (player.postTestAnswers.length >= ASSESSMENT_QUESTION_COUNT || !expectedQuestion) {
        throw new Error('ผู้ใช้:ทำแบบทดสอบครบทุกข้อแล้ว')
      }
      // Idempotent: the first answer for a question is the one that counts.
      if (player.postTestAnswers.some((item) => item.questionId === answer.questionId)) return
      // Sequential: the submitted question must be the next unanswered item, and the caller's
      // expected index must agree with the server's own count.
      if (player.postTestAnswers.length !== answer.expectedIndex || expectedQuestion.id !== answer.questionId) {
        throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
      }
      const evaluated = evaluateChoice(expectedQuestion, answer.selectedChoiceId)
      if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
      const postTestAnswers = [...player.postTestAnswers, {
        questionId: answer.questionId,
        selectedChoiceId: answer.selectedChoiceId,
        answeredAt: Date.now(),
      }]
      transaction.update(playerRef, { postTestAnswers })
    })
  }

  async saveSurveyResponse(roomCode: string, playerId: string, response: SurveyResponseInput): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const playerRef = doc(db, 'rooms', roomCode, 'players', playerId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, playerSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(playerRef)])
      if (!roomSnapshot.exists() || !playerSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลห้องหรือผู้เล่นของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const player = mapPlayer(playerSnapshot)
      if (room.phase !== 'survey') throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงแบบประเมินกิจกรรม')
      const expectedItem = SURVEY_ITEMS[player.surveyResponses.length]
      if (player.surveyResponses.length >= SURVEY_ITEM_COUNT || !expectedItem) {
        throw new Error('ผู้ใช้:ทำแบบประเมินครบทุกข้อแล้ว')
      }
      // Idempotent: the first response for an item is the one that counts.
      if (player.surveyResponses.some((item) => item.itemId === response.itemId)) return
      // Sequential: the submitted item must be the next unanswered one, and the caller's expected
      // index must agree with the server's own count.
      if (player.surveyResponses.length !== response.expectedIndex || expectedItem.id !== response.itemId) {
        throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
      }
      // Only the 5 scale points are storable — never an arbitrary value.
      if (!isValidSurveyValue(response.value)) throw new Error('ผู้ใช้:กรุณาเลือกคำตอบจากตัวเลือกที่กำหนด')
      const surveyResponses = [...player.surveyResponses, {
        itemId: response.itemId,
        value: response.value,
        answeredAt: Date.now(),
      }]
      transaction.update(playerRef, { surveyResponses })
    })
  }

  // postTest -> survey. Teacher-only and idempotent: only fires from the post-test stage, so a
  // stale/duplicate press is a safe no-op. No timer — the survey is self-paced.
  async startSurvey(roomCode: string, teacherSessionId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'playing' || room.phase !== 'postTest') return
      transaction.update(roomRef, { phase: 'survey' })
    })
  }

  // survey -> completed. Teacher-only and idempotent: only fires from the post-test stage, so a
  // stale/duplicate press is a safe no-op. Sets nothing but the round-ending fields — winner,
  // scores, teams and every Main/Boss result are left exactly as they already are.
  async completeRound(roomCode: string, teacherSessionId: string): Promise<void> {
    // Captured out of the transaction so the history snapshot below can read the round/team
    // labels this round is being completed on.
    let completingRoom: Room | null = null
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'playing' || room.phase !== 'survey') return
      completingRoom = room
      transaction.update(roomRef, { status: 'completed', completedAt: serverTimestamp() })
    })
    if (!completingRoom) return
    // Record this round's history immediately, while every player's answers/recall/pre/post/
    // survey arrays are still intact. The round-reset operations snapshot too, but a teacher may
    // close the browser after finishing and never run one — snapshotting at completion is what
    // makes the assessment data durable right away. The deterministic `${round}-${playerId}` id
    // means those later snapshots skip an already-recorded round rather than overwriting it.
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const batch = writeBatch(db)
    await queueRoundHistorySnapshot(batch, roomCode, completingRoom, playerSnapshots)
    await batch.commit()
  }

  async advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const result = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      // Milestone 4: phase !== 'main' guards against a stale/duplicate call landing WHILE the
      // boss phase is in progress — currentQuestionIndex deliberately does not change during
      // boss, so without this the index-match check alone would not catch a second call.
      if (room.status !== 'playing' || room.phase !== 'main' || room.currentQuestionIndex !== expectedQuestionIndex) return null

      // Resolve magic effects queued for the question being left IN THIS SAME TRANSACTION as
      // the room's advance below — so the two either both commit or neither does. All reads
      // (room + one get per team's magic doc, bounded by room.teams.length) happen before any
      // writes, as Firestore transactions require. If this transaction fails or retries, it
      // re-reads fresh state every time, so a retry can never re-consume an already-consumed
      // item or re-apply an already-applied event: resolution only ever acts on a team whose
      // *live* queuedEffect still targets this question, which becomes false the moment the
      // first successful attempt clears it.
      if (room.teams.length > 0) {
        const magicSnapshots = await Promise.all(
          room.teams.map((team) => transaction.get(doc(db, 'rooms', roomCode, 'magic', team.id))),
        )
        const magicByTeamId = new Map<string, TeamMagicState>(
          magicSnapshots.filter((magicSnapshot) => magicSnapshot.exists()).map((magicSnapshot) => [magicSnapshot.id, mapTeamMagic(magicSnapshot)]),
        )
        const { touchedTeamIds, eventOutcomes } = computeMagicResolution(magicByTeamId, expectedQuestionIndex)
        touchedTeamIds.forEach((teamId) => {
          const magic = magicByTeamId.get(teamId)
          if (!magic) return
          transaction.update(doc(db, 'rooms', roomCode, 'magic', teamId), { inventory: magic.inventory, queuedEffect: magic.queuedEffect })
        })
        eventOutcomes.forEach((status, eventId) => {
          transaction.update(doc(db, 'rooms', roomCode, 'magicEvents', eventId), { status, resolvedAt: serverTimestamp() })
        })
      }

      const resolvedQuestionId = room.questionIds[expectedQuestionIndex] ?? null

      // "ศึกด่านชิงมนตรา" — inserted before main question 6, reusing the same synchronized
      // question/timer architecture via bossQuestionIds/bossQuestionIndex/bossQuestionStartedAt.
      // currentQuestionIndex stays at 4 for the duration; advanceBossQuestion is what eventually
      // moves it to 5 once the 3rd boss question resolves.
      if (expectedQuestionIndex === BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX && !room.bossCompleted) {
        transaction.update(roomRef, {
          phase: 'boss',
          bossQuestionIds: selectBossQuestions(bossQuestions, room.questionIds),
          bossQuestionIndex: 0,
          bossQuestionStartedAt: serverTimestamp(),
        })
        return { finished: false, resolvedQuestionId, teams: room.teams, currentRound: room.currentRound }
      }

      const nextQuestionIndex = expectedQuestionIndex + 1
      if (nextQuestionIndex >= room.questionIds.length) {
        // Assessment Layer: finishing Main question 10 no longer ends the round. The room moves
        // to the post-test with status still 'playing' — completion is now an explicit teacher
        // action (completeRound). The player writes below are unchanged.
        transaction.update(roomRef, {
          phase: 'postTest',
          currentQuestionIndex: room.questionIds.length,
          questionStartedAt: null,
          questionClosedAt: null,
        })
        return { finished: true, resolvedQuestionId, teams: room.teams, currentRound: room.currentRound }
      }
      transaction.update(roomRef, { currentQuestionIndex: nextQuestionIndex, questionStartedAt: serverTimestamp(), questionClosedAt: null })
      return { finished: false, resolvedQuestionId, teams: room.teams, currentRound: room.currentRound }
    })
    if (!result) return

    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))

    // Milestone 4 section 3: persist every team's raw/magic/competition breakdown for the
    // question just left (not just magic-touched teams) — students can't compute this
    // themselves (no `list` access to teammates' answers), so it has to be written somewhere
    // already broadly readable. Deliberately NOT part of the transaction above: it's a derived
    // display value recomputable from players + magicEvents at any time, not part of the
    // scoring integrity boundary that transaction protects.
    if (result.resolvedQuestionId && result.teams.length > 0) {
      const magicEventSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'magicEvents'))
      const players = playerSnapshots.docs.map((document) => mapPlayer(document))
      const events = magicEventSnapshots.docs.map((document) => mapMagicEvent(document))
      const breakdownBatch = writeBatch(db)
      result.teams.forEach((team) => {
        const breakdown = computeTeamQuestionBreakdown(players, team, result.resolvedQuestionId as string, expectedQuestionIndex, events, result.currentRound)
        breakdownBatch.update(doc(db, 'rooms', roomCode, 'magic', team.id), { lastResolvedBreakdown: breakdown })
      })
      await breakdownBatch.commit()
    }

    if (!result.finished) return
    const batch = writeBatch(db)
    playerSnapshots.docs.forEach((playerDocument) => batch.update(playerDocument.ref, {
      currentQuestionIndex: 10,
      submitted: true,
      status: 'submitted',
      finishedAt: serverTimestamp(),
      elapsedMs: null,
    }))
    await batch.commit()
  }

  // Milestone 4: parallel to saveAnswer, but writes to player.bossAnswers only — never
  // player.answers/score, which is what makes "boss answers do not affect the 100-point
  // knowledge score" true by construction. Uses the SAME getRemainingMilliseconds helper, fed
  // a boss-shaped {questionStartedAt, questionDurationSeconds, questionClosedAt: null} object,
  // so the deadline math is identical to the main flow's (boss has no early-close, so
  // questionClosedAt is always null here).
  async saveBossAnswer(roomCode: string, playerId: string, answer: BossAnswerInput): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const playerRef = doc(db, 'rooms', roomCode, 'players', playerId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, playerSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(playerRef)])
      if (!roomSnapshot.exists() || !playerSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลห้องหรือผู้เล่นของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const player = mapPlayer(playerSnapshot)
      if (room.status !== 'playing' || room.phase !== 'boss') throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงศึกด่านชิงมนตรา')
      if (room.bossQuestionIndex !== answer.expectedBossIndex) throw new Error('ผู้ใช้:ลำดับคำถามเปลี่ยนแล้ว กรุณารอข้อถัดไป')
      const bossTiming = { questionStartedAt: room.bossQuestionStartedAt, questionDurationSeconds: room.bossQuestionDurationSeconds, questionClosedAt: null }
      if (!room.bossQuestionStartedAt || getRemainingMilliseconds(bossTiming, Date.now()) <= 0) {
        throw new Error('ผู้ใช้:หมดเวลาตอบคำถามข้อนี้แล้ว')
      }
      if (room.bossQuestionIds[answer.expectedBossIndex] !== answer.questionId) {
        throw new Error('ผู้ใช้:ลำดับคำถามไม่ตรงกับรอบปัจจุบัน กรุณาโหลดหน้าใหม่')
      }
      // Rapid Boss is first-answer-locked. The old array/rules shape still permits a
      // same-size overwrite for backward compatibility, but the service itself now treats an
      // already-recorded answer for this boss question as immutable so speed ranking cannot be
      // gamed by changing the answer after seeing the interaction.
      if (player.bossAnswers.some((item) => item.questionId === answer.questionId)) return
      const question = questionsById.get(answer.questionId)
      const evaluated = evaluateChoice(question, answer.selectedChoiceId)
      if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
      const record: BossAnswerRecord = {
        questionId: answer.questionId,
        selectedChoiceId: answer.selectedChoiceId,
        isCorrect: evaluated.isCorrect,
        answeredAt: Date.now(),
        responseTimeMs: Date.now() - (room.bossQuestionStartedAt ?? Date.now()),
      }
      const bossAnswers = [...player.bossAnswers]
      const existingIndex = bossAnswers.findIndex((item) => item.questionId === answer.questionId)
      if (existingIndex >= 0) bossAnswers[existingIndex] = record
      else bossAnswers.push(record)
      transaction.update(playerRef, { bossAnswers })
    })
  }

  // Milestone 4: parallel to advanceQuestion, but for the 3-question boss phase. On the 3rd
  // question, resolves ranking + reward exactly once (guarded by room.bossCompleted — a
  // stale/duplicate call after the first successful resolution is a silent no-op, so a refresh
  // or retry can never reroll the tie-break or award a second item). Player ids are enumerated
  // OUTSIDE the transaction (bounded by roster size, like advanceQuestion's magic-doc reads),
  // but every player's actual DATA is read fresh, inside the transaction via transaction.get()
  // — so if the transaction retries due to contention, ranking is recomputed from current state
  // every time, never from a stale pre-read.
  async advanceBossQuestion(roomCode: string, teacherSessionId: string, expectedBossIndex: number): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const playerSnapshotsForIds = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const playerIds = playerSnapshotsForIds.docs.map((document) => document.id)

    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (
        room.status !== 'playing' ||
        room.phase !== 'boss' ||
        room.bossQuestionIndex !== expectedBossIndex ||
        room.bossAwaitingContinue === true
      ) {
        return
      }
      const nextBossIndex = expectedBossIndex + 1

      if (nextBossIndex < room.bossQuestionIds.length) {
        transaction.update(roomRef, { bossQuestionIndex: nextBossIndex, bossQuestionStartedAt: serverTimestamp() })
        return
      }

      let bossWinner = room.bossWinner
      if (!room.bossCompleted) {
        const playerSnapshots = await Promise.all(playerIds.map((id) => transaction.get(doc(db, 'rooms', roomCode, 'players', id))))
        const players = playerSnapshots.filter((playerSnapshot) => playerSnapshot.exists()).map((playerSnapshot) => mapPlayer(playerSnapshot))
        const ranking = computeBossRanking(players, room.bossQuestionIds, room.bossQuestionDurationSeconds)
        if (ranking.winner) {
          const winnerPlayer = players.find((player) => player.id === ranking.winner?.playerId)
          if (winnerPlayer?.teamId) {
            const magicRef = doc(db, 'rooms', roomCode, 'magic', winnerPlayer.teamId)
            const magicSnapshot = await transaction.get(magicRef)
            if (magicSnapshot.exists()) {
              const magic = mapTeamMagic(magicSnapshot)
              const rewardItemType = pickRandomMagicItem()
              const nextInventory: MagicInventory = {
                ...magic.inventory,
                [rewardItemType]: { ...magic.inventory[rewardItemType], available: magic.inventory[rewardItemType].available + 1 },
              }
              transaction.update(magicRef, { inventory: nextInventory })
              // Denormalized onto the room (see BossWinner's doc comment in types/game.ts) —
              // once teams are locked a student can only `get` their OWN player doc, so there
              // is no rules-legal way to resolve an opposing team's winner's name/team from a
              // bare playerId; announcing on every screen requires the data to already live
              // somewhere broadly readable.
              bossWinner = {
                playerId: ranking.winner.playerId,
                displayName: ranking.winner.displayName,
                studentNumber: ranking.winner.studentNumber,
                teamId: ranking.winner.teamId,
                teamName: room.teams.find((team) => team.id === ranking.winner?.teamId)?.name ?? null,
                correctCount: ranking.winner.correctCount,
                totalTimeMs: ranking.winner.totalTimeMs,
                rewardItemType,
              }
            }
          }
        }
      }
      // Pause-and-continue gate: resolving the 3rd boss question no longer advances
      // phase/currentQuestionIndex on its own — it only grants the reward (idempotently, above)
      // and flips bossAwaitingContinue so every client's boss-phase render stays put until the
      // teacher explicitly presses "เล่นต่อ" (continueAfterBoss, the only method that clears it).
      transaction.update(roomRef, {
        bossCompleted: true,
        bossWinner,
        bossAwaitingContinue: true,
      })
    })
  }

  // Pause-and-continue gate: fired only by the teacher's "เล่นต่อ" button after
  // advanceBossQuestion has paused the room with bossAwaitingContinue=true. Writes exactly what
  // advanceBossQuestion used to write unconditionally on resolving the 3rd boss question — moving
  // the room back into the main phase at the question right after the boss trigger point.
  // expectedRound mirrors advanceQuestion/advanceBossQuestion's "expected token" no-op guard
  // shape, so a stale/duplicate call (e.g. a double-click, or a call arriving after the room
  // somehow moved on) is always a safe no-op rather than a re-advance.
  async continueAfterBoss(roomCode: string, teacherSessionId: string, expectedRound: number): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (
        room.status !== 'playing' ||
        room.phase !== 'boss' ||
        room.bossAwaitingContinue !== true ||
        room.currentRound !== expectedRound
      ) {
        return
      }
      transaction.update(roomRef, {
        phase: 'main',
        currentQuestionIndex: BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX + 1,
        questionStartedAt: serverTimestamp(),
        questionClosedAt: null,
        bossAwaitingContinue: false,
      })
    })
  }

  // Milestone 2.2: teacher early-close. The "everyone currently registered has answered"
  // check reads the whole players collection, which (like startRoom's starting-item check)
  // can't be done from inside a Firestore transaction — so it's a best-effort pre-check outside
  // the transaction, and the actual write is a small, cheaply-idempotent transaction guarded by
  // status + expectedQuestionIndex + questionClosedAt already being null, matching
  // advanceQuestion's own stale/duplicate-click protection.
  async closeQuestionEarly(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const roomSnapshotForCheck = await getDoc(roomRef)
    if (!roomSnapshotForCheck.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const roomForCheck = mapRoom(roomSnapshotForCheck.data())
    if (roomForCheck.status === 'playing' && roomForCheck.currentQuestionIndex === expectedQuestionIndex && roomForCheck.questionClosedAt == null) {
      const questionId = roomForCheck.questionIds[expectedQuestionIndex]
      const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
      const allAnswered = playerSnapshots.docs.every((playerDocument) => mapPlayer(playerDocument).answers.some((answer) => answer.questionId === questionId))
      if (!allAnswered) throw new Error('ผู้ใช้:ยังมีผู้เล่นบางคนยังไม่ได้ตอบคำถามข้อนี้')
    }
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'playing' || room.currentQuestionIndex !== expectedQuestionIndex) return
      if (room.questionClosedAt != null) return
      transaction.update(roomRef, { questionClosedAt: serverTimestamp() })
    })
  }

  async prepareNextRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const roomSnapshot = await getDoc(roomRef)
    if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const room = mapRoom(roomSnapshot.data())
    if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
    if (room.status === 'playing') throw new Error('ผู้ใช้:ยุติรอบปัจจุบันให้เรียบร้อยก่อนเตรียมรอบใหม่')
    const currentRound = room.currentRound + 1
    const questionIds = selectRoundQuestions(questions, room.questionIds)
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const batch = writeBatch(db)
    // Record this round BEFORE the player resets queued below land — once answers/recallAnswers
    // are wiped the results are unrecoverable. Idempotent per round.
    await queueRoundHistorySnapshot(batch, roomCode, room, playerSnapshots)
    batch.update(roomRef, {
      status: 'waiting',
      currentRound,
      startedAt: null,
      completedAt: null,
      currentQuestionIndex: 0,
      questionStartedAt: null,
      questionClosedAt: null,
      previousQuestionIds: room.questionIds,
      questionIds,
      winner: null,
      ...createFreshBossFields(),
    })
    playerSnapshots.docs.forEach((playerDocument) => {
      batch.update(playerDocument.ref, {
        currentRound,
        currentQuestionIndex: 0,
        score: 0,
        answers: [],
        bossAnswers: [],
        recallAnswers: [],
        preTestAnswers: [],
        postTestAnswers: [],
        surveyResponses: [],
        submitted: false,
        finishedAt: null,
        elapsedMs: null,
        status: 'waiting',
      })
    })
    await batch.commit()
    await resetMagicForNewRound(roomCode)
  }

  async stopRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const roomSnapshot = await getDoc(roomRef)
    if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const room = mapRoom(roomSnapshot.data())
    if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
    if (room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจไม่ได้กำลังดำเนินอยู่')
    const currentRound = room.currentRound + 1
    const questionIds = selectRoundQuestions(questions, room.questionIds)
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const batch = writeBatch(db)
    // Record this round BEFORE the player resets queued below land — once answers/recallAnswers
    // are wiped the results are unrecoverable. Idempotent per round.
    await queueRoundHistorySnapshot(batch, roomCode, room, playerSnapshots)
    batch.update(roomRef, {
      status: 'waiting',
      currentRound,
      startedAt: null,
      completedAt: null,
      currentQuestionIndex: 0,
      questionStartedAt: null,
      questionClosedAt: null,
      previousQuestionIds: room.questionIds,
      questionIds,
      winner: null,
      ...createFreshBossFields(),
    })
    playerSnapshots.docs.forEach((playerDocument) => {
      batch.update(playerDocument.ref, {
        currentRound,
        currentQuestionIndex: 0,
        score: 0,
        answers: [],
        bossAnswers: [],
        recallAnswers: [],
        preTestAnswers: [],
        postTestAnswers: [],
        surveyResponses: [],
        submitted: false,
        finishedAt: null,
        elapsedMs: null,
        status: 'waiting',
      })
    })
    await batch.commit()
    await resetMagicForNewRound(roomCode)
  }

  async closeRoom(roomCode: string, teacherSessionId: string): Promise<void> {
    // Captured out of the transaction so the history snapshot below can read the round/team
    // labels this room is being closed on.
    let closingRoom: Room | null = null
    await runTransaction(db, async (transaction) => {
      const roomRef = doc(db, 'rooms', roomCode)
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      closingRoom = room
      transaction.update(roomRef, { status: 'closed' })
    })
    await expireQueuedMagicEffects(roomCode)
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const batch = writeBatch(db)
    // Closing ends the round too, so record it first — this is what keeps a finished round's
    // history available after the room is closed.
    if (closingRoom) await queueRoundHistorySnapshot(batch, roomCode, closingRoom, playerSnapshots)
    playerSnapshots.docs.forEach((playerDocument) => batch.update(playerDocument.ref, { status: 'stopped' }))
    await batch.commit()
  }

  async randomizeTeams(roomCode: string, teacherSessionId: string, teamCount: number): Promise<void> {
    if (!Number.isFinite(teamCount) || teamCount < 1) throw new Error('ผู้ใช้:จำนวนทีมต้องมีอย่างน้อย 1 ทีม')
    const roomRef = doc(db, 'rooms', roomCode)
    const roomSnapshot = await getDoc(roomRef)
    if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const room = mapRoom(roomSnapshot.data())
    if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
    if (room.status !== 'waiting') throw new Error('ผู้ใช้:จัดทีมได้เฉพาะช่วงห้องรอ')
    // Teams may only be created once Story Recall is finished — this is what makes "no teams
    // exist before/during Recall" a structural guarantee rather than a UI convention.
    if (room.phase !== 'teamSetup') throw new Error('ผู้ใช้:กรุณาทำทบทวนเรื่องราวให้เสร็จก่อนจัดทีม')
    if (room.teamsLocked) throw new Error('ผู้ใช้:กรุณาปลดล็อกทีมก่อนสุ่มใหม่')

    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const playerIds = playerSnapshots.docs.map((playerDocument) => playerDocument.id)
    if (playerIds.length === 0) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังจัดทีมไม่ได้')
    if (teamCount > playerIds.length) throw new Error('ผู้ใช้:จำนวนทีมต้องไม่เกินจำนวนผู้เล่น')
    const assignment = distributeTeamsEvenly(playerIds, teamCount)
    const teams = buildTeamMetas(teamCount)

    // Build the display-only roster summary from this exact assignment + player snapshot —
    // it can never observably lag or diverge from what it was built from, since it's part of
    // the same atomic batch as the assignment itself.
    const rosters = new Map<string, TeamRosterSummary>(
      teams.map((team) => [team.id, { teamId: team.id, teamName: team.name, members: [] }]),
    )
    playerSnapshots.docs.forEach((playerDocument) => {
      const player = mapPlayer(playerDocument)
      const teamId = assignment[playerDocument.id]
      rosters.get(teamId)?.members.push({ playerId: playerDocument.id, displayName: player.displayName })
    })

    // One atomic batch for the room's team labels, every player's teamId, AND the roster
    // summaries — Firestore commits a batch all-or-nothing, so the room can never say teams
    // are assigned while some players (or the roster built from them) aren't (well under the
    // 500-op batch limit at ~50 students).
    const batch = writeBatch(db)
    batch.update(roomRef, { teamCount, teams })
    playerSnapshots.docs.forEach((playerDocument) => {
      batch.update(playerDocument.ref, { teamId: assignment[playerDocument.id] })
    })
    rosters.forEach((roster, teamId) => {
      batch.set(doc(db, 'rooms', roomCode, 'rosters', teamId), { teamName: roster.teamName, members: roster.members })
    })
    await batch.commit()
  }

  async lockTeams(roomCode: string, teacherSessionId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    // Lock FIRST (transactionally verifying teacher/teams), before re-checking the roster.
    // A join transaction that reads the room after this commits sees teamsLocked=true and
    // is rejected as a new join (reconnects are unaffected — they never check teamsLocked).
    // A join transaction already in flight when this commits will conflict on the room doc
    // and Firestore retries it, so it re-reads the now-locked room and is blocked too. Only
    // after the lock is committed do we re-read every player — this closes the race where a
    // student finishes joining in the window right before the lock actually lands.
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.teams.length === 0) throw new Error('ผู้ใช้:กรุณาสุ่มทีมก่อนล็อกทีม')
      transaction.update(roomRef, { teamsLocked: true })
    })

    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const hasUnassigned = playerSnapshots.docs.some((playerDocument) => mapPlayer(playerDocument).teamId == null)
    if (hasUnassigned) {
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(roomRef)
        if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
        transaction.update(roomRef, { teamsLocked: false })
      })
      throw new Error('ผู้ใช้:มีผู้เล่นบางคนยังไม่ได้จัดทีม กรุณาสุ่มทีมอีกครั้ง')
    }

    // Success: give every team a fresh magic doc with NO captain yet — Milestone 4.1 replaces
    // the old random holder pick with a team vote (see castCaptainVote/finalizeCaptainElection
    // below). captainElectionAttempt is bumped, never reused, so any vote docs cast under a
    // PRIOR attempt for this team id — including ones from before an unlock+re-randomize — are
    // simply never counted again without needing to delete them (see CaptainVote's doc comment
    // in types/game.ts for why deletion isn't how this codebase scopes stale data).
    const roomSnapshot = await getDoc(roomRef)
    if (!roomSnapshot.exists()) return
    const room = mapRoom(roomSnapshot.data())
    const existingMagicSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'magic'))
    const previousAttempts = new Map(existingMagicSnapshots.docs.map((document) => [document.id, mapTeamMagic(document).captainElectionAttempt]))
    const magicBatch = writeBatch(db)
    room.teams.forEach((team) => {
      magicBatch.set(doc(db, 'rooms', roomCode, 'magic', team.id), {
        teamId: team.id,
        magicHolderPlayerId: null,
        captainElectionAttempt: (previousAttempts.get(team.id) ?? 0) + 1,
        inventory: createEmptyMagicInventory(),
        queuedEffect: null,
        lastResolvedBreakdown: null,
      })
      // Team guardian names reset on the same cadence as captain election/inventory — a
      // (re-)lock always starts every team unnamed again, same as it starts every team
      // captain-less and item-less.
      magicBatch.delete(doc(db, 'rooms', roomCode, 'teamNames', team.id))
    })
    await magicBatch.commit()
  }

  async unlockTeams(roomCode: string, teacherSessionId: string): Promise<void> {
    await runTransaction(db, async (transaction) => {
      const roomRef = doc(db, 'rooms', roomCode)
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'waiting') throw new Error('ผู้ใช้:ปลดล็อกทีมได้เฉพาะช่วงห้องรอ')
      transaction.update(roomRef, { teamsLocked: false })
    })
  }

  async saveAnswer(roomCode: string, playerId: string, answer: AnswerInput): Promise<AnswerResult> {
    const roomRef = doc(db, 'rooms', roomCode)
    const playerRef = doc(db, 'rooms', roomCode, 'players', playerId)
    return runTransaction(db, async (transaction) => {
      const [roomSnapshot, playerSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(playerRef)])
      if (!roomSnapshot.exists() || !playerSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลห้องหรือผู้เล่นของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const player = mapPlayer(playerSnapshot)
      if (room.status === 'completed') throw new Error('ผู้ใช้:ภารกิจรอบนี้สิ้นสุดแล้ว')
      if (room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจยังไม่เริ่มหรือสิ้นสุดแล้ว')
      if (player.submitted || room.currentQuestionIndex !== answer.expectedQuestionIndex) throw new Error('ผู้ใช้:ลำดับคำถามเปลี่ยนแล้ว กรุณารอข้อถัดไป')
      // getRemainingMilliseconds (not manual deadline math) so a teacher's early close
      // (questionClosedAt) is honored here too — otherwise a late/slow client could still
      // submit an answer up until the ORIGINAL deadline even after an early close.
      if (!room.questionStartedAt || getRemainingMilliseconds(room, Date.now()) <= 0) {
        throw new Error('ผู้ใช้:หมดเวลาตอบคำถามข้อนี้แล้ว')
      }
      if (room.questionIds[answer.expectedQuestionIndex] !== answer.questionId) {
        throw new Error('ผู้ใช้:ลำดับคำถามไม่ตรงกับรอบปัจจุบัน กรุณาโหลดหน้าใหม่')
      }
      const question = questionsById.get(answer.questionId)
      const evaluated = evaluateChoice(question, answer.selectedChoiceId)
      if (!evaluated.valid) {
        throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
      }
      const isCorrect = evaluated.isCorrect
      const existingAnswerIndex = player.answers.findIndex((item) => item.questionId === answer.questionId)
      const existingAnswer = existingAnswerIndex >= 0 ? player.answers[existingAnswerIndex] : undefined
      const answerRecord: AnswerRecord = {
        questionId: answer.questionId,
        selectedChoiceId: answer.selectedChoiceId,
        isCorrect,
        answeredAt: Date.now(),
        responseTimeMs: Date.now() - (room.questionStartedAt ?? Date.now()),
      }
      const answers = [...player.answers]
      if (existingAnswerIndex >= 0) answers[existingAnswerIndex] = answerRecord
      else answers.push(answerRecord)
      const score = player.score + (isCorrect ? 1 : 0) - (existingAnswer?.isCorrect ? 1 : 0)
      transaction.update(playerRef, { answers, score })
      // Overwrite (never append) this player's own progress entry — first answer or changing
      // the choice for the same question both land here, so the team's "X answered" count can
      // never double-count a teammate. Once the room moves to the next question, this entry's
      // questionId no longer matches the new current question, so it stops counting with no
      // explicit reset needed.
      if (player.teamId) {
        transaction.set(doc(db, 'rooms', roomCode, 'answerProgress', playerId), {
          teamId: player.teamId,
          questionId: answer.questionId,
          currentRound: room.currentRound,
          answeredAt: serverTimestamp(),
        })
      }
      return {
        player: {
          ...player,
          answers,
          score,
        },
        winner: null,
      }
    })
  }

  // Milestone: the captain may change this pick any number of times while the room is still
  // 'waiting' (a fresh pick or a change are the exact same operation — both just replace
  // whatever the inventory currently holds with exactly one entry). Once room.status leaves
  // 'waiting' this method is unreachable (guarded below, and mirrored server-side by
  // firestore.rules' isValidActivationWindow-adjacent starting-item branch), which is what makes
  // the choice permanent once the mission actually starts. Pre-start, inventory can only ever
  // hold the single starting pick (boss rewards — the only other inventory mutation — are
  // 'playing'-only), so replacing is always just "every other type zeroed, the requested type set
  // to exactly 1" — it can never leave two types both holding an item.
  async chooseStartingItem(roomCode: string, teamId: string, playerId: string, itemType: MagicItemType): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const magicRef = doc(db, 'rooms', roomCode, 'magic', teamId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, magicSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(magicRef)])
      if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      if (!magicSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
      const room = mapRoom(roomSnapshot.data())
      const magic = mapTeamMagic(magicSnapshot)
      if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')
      if (room.status !== 'waiting' || !room.teamsLocked) {
        throw new Error('ผู้ใช้:เลือกไอเทมเริ่มต้นได้เฉพาะช่วงห้องรอหลังล็อกทีมแล้ว')
      }
      const nextInventory: MagicInventory = createEmptyMagicInventory()
      nextInventory[itemType] = { available: 1, consumed: 0 }
      transaction.update(magicRef, { inventory: nextInventory })
    })
  }

  async activateItem(
    roomCode: string,
    teamId: string,
    playerId: string,
    itemType: 'power_surge' | 'score_seal' | 'illusion',
    targetTeamId?: string,
  ): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const magicRef = doc(db, 'rooms', roomCode, 'magic', teamId)

    await runTransaction(db, async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef)
      if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(roomSnapshot.data())

      const magicSnapshot = await transaction.get(magicRef)
      if (!magicSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
      const magic = mapTeamMagic(magicSnapshot)
      if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')
      // Milestone 4: magic is a main-phase-only concept — the boss mini-game has its own,
      // separate 3-question flow, and status stays 'playing' throughout both, so this check is
      // what actually prevents activation from leaking into the boss phase. This also covers
      // Milestone 4.1's "illusion cannot affect boss questions" — activation is unavailable in
      // the boss phase for every item, not just illusion.
      if (room.phase !== 'main') throw new Error('ผู้ใช้:ไม่สามารถใช้ไอเทมได้ในขณะนี้ กรุณารอช่วงพักหรือรอบถัดไป')

      const window = getMagicActivationWindow(room)
      if (!window.valid || window.affectedQuestionIndex == null) {
        throw new Error('ผู้ใช้:ไม่สามารถใช้ไอเทมได้ในขณะนี้ กรุณารอช่วงพักหรือรอบถัดไป')
      }
      const affectedQuestionIndex = window.affectedQuestionIndex

      if (magic.inventory[itemType].available <= 0) throw new Error('ผู้ใช้:ไม่มีไอเทมนี้ในคลังของทีม')

      const eventId = `magic-${createMagicId()}`
      const eventRef = doc(db, 'rooms', roomCode, 'magicEvents', eventId)

      // A legitimate holder attempt that fails validation still gets an audit record — this is
      // what makes "duplicate activation rejected" / "wrong target rejected" visible in the
      // teacher's event history, not just a toast the student saw.
      const logRejectedEvent = (rejectedTargetTeamId: string | null): void => {
        transaction.set(eventRef, {
          itemType,
          actorPlayerId: playerId,
          sourceTeamId: teamId,
          targetTeamId: rejectedTargetTeamId,
          affectedQuestionIndex,
          status: 'rejected',
          round: room.currentRound,
          createdAt: serverTimestamp(),
          resolvedAt: serverTimestamp(),
        })
      }

      if (magic.queuedEffect) {
        logRejectedEvent(itemType === 'score_seal' ? (targetTeamId ?? null) : teamId)
        throw new Error('ผู้ใช้:ทีมนี้มีไอเทมที่กำลังรอผลอยู่แล้ว')
      }

      if (itemType === 'score_seal') {
        if (!targetTeamId) {
          logRejectedEvent(null)
          throw new Error('ผู้ใช้:กรุณาเลือกทีมเป้าหมาย')
        }
        if (targetTeamId === teamId) {
          logRejectedEvent(targetTeamId)
          throw new Error('ผู้ใช้:เลือกทีมตัวเองเป็นเป้าหมายไม่ได้')
        }
        if (!room.teams.some((team) => team.id === targetTeamId)) {
          logRejectedEvent(targetTeamId)
          throw new Error('ผู้ใช้:ไม่พบทีมเป้าหมาย')
        }
        // Milestone 4: multiple teams may seal the same target — seals stack multiplicatively
        // (see computeHostileMultiplier in lib/magic.ts), so there is no longer an
        // "already targeted" rejection here.
      }

      // Milestone 4.1: illusion is a self-only buff, exactly like power_surge — score_seal's
      // targetTeamId is validated non-empty above, so this cast is safe at this point.
      const finalTargetTeamId = itemType === 'score_seal' ? (targetTeamId as string) : teamId
      const now = Date.now()

      // Milestone 4.1: the hidden choice is chosen exactly ONCE, right here, and stored on the
      // queued effect — never recomputed later (resolution just marks the event 'applied' and
      // consumes the item, it never touches hiddenChoiceId again). This is what makes every team
      // member see the identical hidden choice and makes a refresh/retry unable to reroll it.
      let hiddenChoiceId: string | undefined
      if (itemType === 'illusion') {
        const targetQuestionId = room.questionIds[affectedQuestionIndex]
        const targetQuestion = targetQuestionId ? questionsById.get(targetQuestionId) : undefined
        if (!targetQuestion) {
          logRejectedEvent(finalTargetTeamId)
          throw new Error('ผู้ใช้:ไม่พบคำถามข้อที่จะมีผล กรุณาลองใหม่')
        }
        hiddenChoiceId = pickIllusionHiddenChoice(targetQuestion)
      }

      transaction.update(magicRef, {
        queuedEffect: {
          id: eventId,
          itemType,
          sourceTeamId: teamId,
          targetTeamId: finalTargetTeamId,
          affectedQuestionIndex,
          createdAt: now,
          ...(hiddenChoiceId ? { hiddenChoiceId } : {}),
        },
      })
      transaction.set(eventRef, {
        itemType,
        actorPlayerId: playerId,
        sourceTeamId: teamId,
        targetTeamId: finalTargetTeamId,
        affectedQuestionIndex,
        status: 'queued',
        round: room.currentRound,
        createdAt: serverTimestamp(),
        resolvedAt: null,
      })
    })
  }

  // Milestone 4.1: student-authored — writes ONLY the voter's own vote (+ its broadly-readable
  // progress counterpart), never the finalization result. "Auto-finalize once everyone has
  // voted" is deliberately driven by the TEACHER's client polling vote progress (see
  // TeacherPage.tsx), mirroring how main-question/boss auto-advance are already
  // teacher-client-driven rather than student-triggered — see gameService.ts's doc comment on
  // why a student-triggered finalize could never be safely validated by security rules (rules
  // cannot aggregate/count across a collection).
  async castCaptainVote(roomCode: string, playerId: string, targetPlayerId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const voterRef = doc(db, 'rooms', roomCode, 'players', playerId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, voterSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(voterRef),
      ])
      if (!roomSnapshot.exists() || !voterSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const voter = mapPlayer(voterSnapshot)
      if (room.status !== 'waiting' || !room.teamsLocked) {
        throw new Error('ผู้ใช้:โหวตหัวหน้าทีมได้เฉพาะช่วงห้องรอหลังล็อกทีมแล้ว')
      }
      if (!voter.teamId) throw new Error('ผู้ใช้:คุณยังไม่ได้อยู่ในทีมใด')
      // Self-voting is allowed — targetPlayerId === playerId simply passes the same rules-layer
      // check. targetPlayerId itself is never read back from Firestore here: the target's own
      // player doc is private (players/{playerId}'s allow get only permits the owner or a
      // pre-lock read), so this transaction cannot fetch it without a permission-denied error
      // for any teammate other than the voter. The captainVotes/{playerId} security rule is the
      // authoritative check that voter and target share the same locked team — this method only
      // needs to pass targetPlayerId through untouched (see LobbyPage.tsx for the friendly,
      // roster-based pre-check that runs before this is ever called).
      const magicRef = doc(db, 'rooms', roomCode, 'magic', voter.teamId)
      const magicSnapshot = await transaction.get(magicRef)
      if (!magicSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
      const magic = mapTeamMagic(magicSnapshot)
      if (magic.magicHolderPlayerId != null) throw new Error('ผู้ใช้:ทีมนี้เลือกหัวหน้าทีมเรียบร้อยแล้ว')
      // Overwrite (never append) — this is what makes "students may change their vote until
      // finalized" true: casting a second vote just replaces this same playerId-keyed doc.
      transaction.set(doc(db, 'rooms', roomCode, 'captainVotes', playerId), {
        teamId: voter.teamId,
        targetPlayerId,
        electionAttempt: magic.captainElectionAttempt,
        votedAt: serverTimestamp(),
      })
      transaction.set(doc(db, 'rooms', roomCode, 'captainVoteProgress', playerId), {
        teamId: voter.teamId,
        electionAttempt: magic.captainElectionAttempt,
        votedAt: serverTimestamp(),
      })
    })
  }

  // Milestone 4.1: teacher-authored, idempotent (a stale/duplicate call after the captain is
  // already set is a silent no-op — refresh/retry can never reroll the tie-break). Also the
  // manual "finalize early" path for teams with missing voters, and the implicit target of the
  // teacher's auto-finalize-on-all-voted effect (see TeacherPage.tsx). Vote ids are enumerated
  // OUTSIDE the transaction (bounded by roster size, mirrors advanceBossQuestion's pattern for
  // reading all players), but every vote's actual DATA is read fresh, inside the transaction.
  async finalizeCaptainElection(roomCode: string, teacherSessionId: string, teamId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const magicRef = doc(db, 'rooms', roomCode, 'magic', teamId)
    const rosterRef = doc(db, 'rooms', roomCode, 'rosters', teamId)
    const voteSnapshotsForIds = await getDocs(query(collection(db, 'rooms', roomCode, 'captainVotes'), where('teamId', '==', teamId)))
    const voteIds = voteSnapshotsForIds.docs.map((document) => document.id)

    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, magicSnapshot, rosterSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(magicRef),
        transaction.get(rosterRef),
      ])
      if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(roomSnapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (!magicSnapshot.exists()) return
      const magic = mapTeamMagic(magicSnapshot)
      if (magic.magicHolderPlayerId != null) return
      const memberIds = rosterSnapshot.exists() ? mapTeamRoster(rosterSnapshot).members.map((member) => member.playerId) : []
      const voteSnapshots = await Promise.all(voteIds.map((id) => transaction.get(doc(db, 'rooms', roomCode, 'captainVotes', id))))
      const votesByVoter: Record<string, string> = {}
      voteSnapshots.filter((snapshot) => snapshot.exists()).map((snapshot) => mapCaptainVote(snapshot)).forEach((vote) => {
        if (vote.electionAttempt !== magic.captainElectionAttempt) return
        votesByVoter[vote.playerId] = vote.targetPlayerId
      })
      // pickElectedCaptain falls back to a uniform random draw across the WHOLE roster when no
      // votes were cast at all — a team can never get permanently stuck with no captain, even
      // if the teacher force-finalizes before anyone voted.
      const captainId = pickElectedCaptain(memberIds, votesByVoter)
      if (!captainId) return
      transaction.update(magicRef, { magicHolderPlayerId: captainId })
    })
  }

  // Milestone 4.1: teacher-authored, only while the room hasn't started playing yet ("reopen the
  // election before the game starts"). Bumps captainElectionAttempt rather than deleting vote
  // docs — see CaptainVote's doc comment in types/game.ts.
  async resetCaptainElection(roomCode: string, teacherSessionId: string, teamId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const magicRef = doc(db, 'rooms', roomCode, 'magic', teamId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, magicSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(magicRef)])
      if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(roomSnapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'waiting') throw new Error('ผู้ใช้:รีเซ็ตการเลือกตั้งหัวหน้าทีมได้เฉพาะก่อนเริ่มภารกิจ')
      if (!magicSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
      const magic = mapTeamMagic(magicSnapshot)
      transaction.update(magicRef, { magicHolderPlayerId: null, captainElectionAttempt: magic.captainElectionAttempt + 1 })
    })
  }

  subscribeCaptainVote(roomCode: string, playerId: string, listener: (vote: CaptainVote | null) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      doc(db, 'rooms', roomCode.toUpperCase(), 'captainVotes', playerId),
      (snapshot) => listener(snapshot.exists() ? mapCaptainVote(snapshot) : null),
      () => onError('ไม่สามารถโหลดข้อมูลการโหวตได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeTeamCaptainVoteProgress(roomCode: string, teamId: string, listener: (entries: CaptainVoteProgress[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      query(collection(db, 'rooms', roomCode.toUpperCase(), 'captainVoteProgress'), where('teamId', '==', teamId)),
      (snapshot) => listener(snapshot.docs.map(mapCaptainVoteProgress)),
      () => onError('ไม่สามารถโหลดความคืบหน้าการโหวตได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeAllCaptainVoteProgress(roomCode: string, listener: (entries: CaptainVoteProgress[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      collection(db, 'rooms', roomCode.toUpperCase(), 'captainVoteProgress'),
      (snapshot) => listener(snapshot.docs.map(mapCaptainVoteProgress)),
      () => onError('ไม่สามารถโหลดความคืบหน้าการโหวตของทุกทีมได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeAllTeamGuardianNames(roomCode: string, listener: (names: TeamGuardianName[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      collection(db, 'rooms', roomCode.toUpperCase(), 'teamNames'),
      (snapshot) => listener(snapshot.docs.map(mapTeamGuardianName)),
      () => onError('ไม่สามารถโหลดชื่อทีมได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeRoundHistory(roomCode: string, listener: (entries: RoundHistoryEntry[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      collection(db, 'rooms', roomCode.toUpperCase(), 'roundHistory'),
      (snapshot) => listener(
        snapshot.docs
          .map(mapRoundHistoryEntry)
          .sort((a, b) => a.round - b.round || a.studentNumber.localeCompare(b.studentNumber)),
      ),
      () => onError('ไม่สามารถโหลดประวัติผลการเรียนได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  // Captain-authored path. Every OTHER team's teamNames doc is read individually INSIDE this
  // transaction (not batched via getDocs outside it) so two captains racing to claim the same
  // name genuinely conflict on each other's read-set — Firestore's optimistic-concurrency retry
  // is what makes the uniqueness check race-safe, not the validation call itself.
  async setTeamGuardianName(roomCode: string, teamId: string, playerId: string, name: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const magicRef = doc(db, 'rooms', roomCode, 'magic', teamId)
    await runTransaction(db, async (transaction) => {
      const [roomSnapshot, magicSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(magicRef)])
      if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(roomSnapshot.data())
      if (room.status !== 'waiting' || !room.teamsLocked) {
        throw new Error('ผู้ใช้:ตั้งชื่อทีมได้เฉพาะช่วงห้องรอหลังล็อกทีมแล้ว')
      }
      if (!magicSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
      const magic = mapTeamMagic(magicSnapshot)
      if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:เฉพาะหัวหน้าทีมที่ได้รับเลือกเท่านั้นที่ตั้งชื่อทีมได้')

      const otherTeamIds = room.teams.map((team) => team.id).filter((id) => id !== teamId)
      const otherNameSnapshots = await Promise.all(otherTeamIds.map((id) => transaction.get(doc(db, 'rooms', roomCode, 'teamNames', id))))
      const otherNames = otherNameSnapshots.filter((snapshot) => snapshot.exists()).map((snapshot) => mapTeamGuardianName(snapshot).name)

      const validationError = validateTeamGuardianName(name, otherNames)
      if (validationError) throw new Error(validationError)

      transaction.set(doc(db, 'rooms', roomCode, 'teamNames', teamId), {
        teamId,
        name: normalizeTeamGuardianName(name),
        updatedAt: serverTimestamp(),
        updatedByPlayerId: playerId,
      })
    })
  }

  // Teacher-only. Deletes the doc entirely — absence means "unnamed", matching setTeamGuardianName
  // never being called yet.
  async resetTeamGuardianName(roomCode: string, teacherSessionId: string, teamId: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      transaction.delete(doc(db, 'rooms', roomCode, 'teamNames', teamId))
    })
  }

  // Teacher-only. Same uniqueness-check transaction shape as setTeamGuardianName, but skips the
  // captain-ownership check entirely — the teacher is always authorized to set any team's name.
  async overrideTeamGuardianName(roomCode: string, teacherSessionId: string, teamId: string, name: string): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')

      const otherTeamIds = room.teams.map((team) => team.id).filter((id) => id !== teamId)
      const otherNameSnapshots = await Promise.all(otherTeamIds.map((id) => transaction.get(doc(db, 'rooms', roomCode, 'teamNames', id))))
      const otherNames = otherNameSnapshots.filter((snapshot) => snapshot.exists()).map((snapshot) => mapTeamGuardianName(snapshot).name)

      const validationError = validateTeamGuardianName(name, otherNames)
      if (validationError) throw new Error(validationError)

      transaction.set(doc(db, 'rooms', roomCode, 'teamNames', teamId), {
        teamId,
        name: normalizeTeamGuardianName(name),
        updatedAt: serverTimestamp(),
        updatedByPlayerId: teacherSessionId,
      })
    })
  }
}
