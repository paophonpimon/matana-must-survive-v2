import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import {
  collection,
  doc,
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
  type Timestamp,
} from 'firebase/firestore'
import { questions, questionsById } from '../data/questions'
import { evaluateChoice, generateRoomCode, selectRoundQuestions } from '../lib/game'
import { getRemainingMilliseconds } from '../lib/gameFlow'
import { computeBossRanking, pickRandomMagicItem, selectBossQuestions } from '../lib/boss'
import { computeTeamQuestionBreakdown, getMagicActivationWindow, hasAnyMagicItem, pickHolders } from '../lib/magic'
import { buildTeamMetas, distributeTeamsEvenly } from '../lib/teamScoring'
import { ensureAnonymousUser, resolveOwnerUid } from './firebaseAuth'
import { resolveJoinPermissionDeniedMessage, type AnswerInput, type AnswerResult, type BossAnswerInput, type GameService } from './gameService'
import {
  BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX,
  DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  createEmptyMagicInventory,
} from '../types/game'
import type {
  AnswerProgressEntry,
  AnswerRecord,
  BossAnswerRecord,
  BossWinner,
  JoinInput,
  JoinResult,
  MagicEvent,
  MagicEventStatus,
  MagicInventory,
  MagicItemType,
  Player,
  QueuedMagicEffect,
  Room,
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
  phase: data.phase === 'boss' ? 'boss' : 'main',
  bossQuestionIds: Array.isArray(data.bossQuestionIds) ? data.bossQuestionIds.map(String) : [],
  bossQuestionIndex: Number(data.bossQuestionIndex ?? 0),
  bossQuestionStartedAt: toMillis(data.bossQuestionStartedAt),
  bossQuestionDurationSeconds: Number(data.bossQuestionDurationSeconds ?? DEFAULT_BOSS_QUESTION_DURATION_SECONDS),
  bossCompleted: Boolean(data.bossCompleted),
  bossWinner: mapBossWinner(data.bossWinner),
})

// Shared by player.answers and player.bossAnswers (Milestone 4) — identical shape.
const mapAnswerRecordLike = (answer: Record<string, unknown>): AnswerRecord | BossAnswerRecord => ({
  questionId: String(answer.questionId),
  selectedChoiceId: String(answer.selectedChoiceId),
  isCorrect: Boolean(answer.isCorrect),
  answeredAt: toMillis(answer.answeredAt) ?? Number(answer.answeredAt ?? Date.now()),
  responseTimeMs: Number(answer.responseTimeMs ?? 0),
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
    itemType: effect.itemType as 'power_surge' | 'score_seal',
    sourceTeamId: String(effect.sourceTeamId ?? ''),
    targetTeamId: String(effect.targetTeamId ?? ''),
    affectedQuestionIndex: Number(effect.affectedQuestionIndex ?? 0),
    createdAt: Number(effect.createdAt ?? 0),
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

  for (const { effect } of effectsThisQuestion) {
    if (effect.itemType === 'power_surge') eventOutcomes.set(effect.id, 'applied')
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
    batch.update(document.ref, { inventory: createEmptyMagicInventory(), queuedEffect: null, lastResolvedBreakdown: null })
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
const createFreshBossFields = (): Pick<
  Room,
  'phase' | 'bossQuestionIds' | 'bossQuestionIndex' | 'bossQuestionStartedAt' | 'bossQuestionDurationSeconds' | 'bossCompleted' | 'bossWinner'
> => ({
  phase: 'main',
  bossQuestionIds: [],
  bossQuestionIndex: 0,
  bossQuestionStartedAt: null,
  bossQuestionDurationSeconds: DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  bossCompleted: false,
  bossWinner: null,
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
        if ((await transaction.get(roomRef)).exists()) throw new Error('ผู้ใช้:รหัสห้องซ้ำ กรุณาลองสร้างอีกครั้ง')
        transaction.set(roomRef, { ...room, createdAt: serverTimestamp() })
      })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'permission-denied') logPermissionDenied('createRoom', resolvedTeacherSessionId, roomCode)
      throw error
    }
    return room
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

  async startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number): Promise<void> {
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
        const teamsWithoutStartingItem = roomForMagicCheck.teams.filter((team) => !hasAnyMagicItem(magicByTeamId.get(team.id)?.inventory ?? createEmptyMagicInventory()))
        if (teamsWithoutStartingItem.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกไอเทมเริ่มต้นก่อนเริ่มภารกิจ')
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
      if (!room.teamsLocked) throw new Error('ผู้ใช้:กรุณาล็อกทีมก่อนเริ่มภารกิจ')
      transaction.update(roomRef, {
        status: 'playing',
        startedAt: serverTimestamp(),
        completedAt: null,
        currentQuestionIndex: 0,
        questionDurationSeconds: Math.max(5, Math.min(600, Math.round(questionDurationSeconds))),
        questionStartedAt: serverTimestamp(),
        questionClosedAt: null,
        winner: null,
      })
    })
    const batch = writeBatch(db)
    playerSnapshots.docs.forEach((playerDocument) => batch.update(playerDocument.ref, { status: 'playing' }))
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
          bossQuestionIds: selectBossQuestions(questions, room.questionIds),
          bossQuestionIndex: 0,
          bossQuestionStartedAt: serverTimestamp(),
        })
        return { finished: false, resolvedQuestionId, teams: room.teams, currentRound: room.currentRound }
      }

      const nextQuestionIndex = expectedQuestionIndex + 1
      if (nextQuestionIndex >= room.questionIds.length) {
        transaction.update(roomRef, {
          status: 'completed',
          completedAt: serverTimestamp(),
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
      if (room.status !== 'playing' || room.phase !== 'boss' || room.bossQuestionIndex !== expectedBossIndex) return
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
      transaction.update(roomRef, {
        phase: 'main',
        currentQuestionIndex: BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX + 1,
        questionStartedAt: serverTimestamp(),
        questionClosedAt: null,
        bossCompleted: true,
        bossWinner,
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
    await runTransaction(db, async (transaction) => {
      const roomRef = doc(db, 'rooms', roomCode)
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      transaction.update(roomRef, { status: 'closed' })
    })
    await expireQueuedMagicEffects(roomCode)
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    const batch = writeBatch(db)
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

    // Success: (re)select exactly one holder per team and give every team a fresh, empty
    // magic state — "re-locking after unlock may select holders again."
    const roomSnapshot = await getDoc(roomRef)
    if (!roomSnapshot.exists()) return
    const room = mapRoom(roomSnapshot.data())
    const memberIdsByTeam: Record<string, string[]> = {}
    room.teams.forEach((team) => { memberIdsByTeam[team.id] = [] })
    playerSnapshots.docs.forEach((playerDocument) => {
      const player = mapPlayer(playerDocument)
      if (player.teamId && memberIdsByTeam[player.teamId]) memberIdsByTeam[player.teamId].push(player.id)
    })
    const holders = pickHolders(memberIdsByTeam)
    const magicBatch = writeBatch(db)
    room.teams.forEach((team) => {
      magicBatch.set(doc(db, 'rooms', roomCode, 'magic', team.id), {
        teamId: team.id,
        magicHolderPlayerId: holders[team.id] ?? null,
        inventory: createEmptyMagicInventory(),
        queuedEffect: null,
        lastResolvedBreakdown: null,
      })
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
      if (hasAnyMagicItem(magic.inventory)) throw new Error('ผู้ใช้:ทีมนี้เลือกไอเทมเริ่มต้นไปแล้ว')
      const nextInventory: MagicInventory = {
        ...magic.inventory,
        [itemType]: { ...magic.inventory[itemType], available: magic.inventory[itemType].available + 1 },
      }
      transaction.update(magicRef, { inventory: nextInventory })
    })
  }

  async activateItem(
    roomCode: string,
    teamId: string,
    playerId: string,
    itemType: 'power_surge' | 'score_seal',
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
      // what actually prevents activation from leaking into the boss phase.
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
        logRejectedEvent(itemType === 'power_surge' ? teamId : (targetTeamId ?? null))
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

      // itemType === 'power_surge' targets the source team itself; score_seal's targetTeamId
      // is validated non-empty above, so this cast is safe at this point.
      const finalTargetTeamId = itemType === 'power_surge' ? teamId : (targetTeamId as string)
      const now = Date.now()

      transaction.update(magicRef, {
        queuedEffect: {
          id: eventId,
          itemType,
          sourceTeamId: teamId,
          targetTeamId: finalTargetTeamId,
          affectedQuestionIndex,
          createdAt: now,
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
}
