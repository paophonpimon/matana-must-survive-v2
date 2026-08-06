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
import { getMagicActivationWindow, pickHolders } from '../lib/magic'
import { buildTeamMetas, distributeTeamsEvenly } from '../lib/teamScoring'
import { ensureAnonymousUser, resolveOwnerUid } from './firebaseAuth'
import { resolveJoinPermissionDeniedMessage, type AnswerInput, type AnswerResult, type GameService } from './gameService'
import type {
  AnswerProgressEntry,
  AnswerRecord,
  JoinInput,
  JoinResult,
  MagicEvent,
  MagicEventStatus,
  MagicInventoryItem,
  MagicItemType,
  Player,
  QueuedMagicEffect,
  Room,
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
  questionIds: Array.isArray(data.questionIds) ? data.questionIds.map(String) : [],
  previousQuestionIds: Array.isArray(data.previousQuestionIds) ? data.previousQuestionIds.map(String) : [],
  winner: mapWinner(data.winner),
  teacherSessionId: String(data.teacherSessionId ?? ''),
  teamCount: Number(data.teamCount ?? 0),
  teamsLocked: Boolean(data.teamsLocked),
  teams: Array.isArray(data.teams) ? data.teams.map(mapTeamMeta) : [],
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
    answers: Array.isArray(data.answers)
      ? data.answers.map((answer: Record<string, unknown>) => ({
          questionId: String(answer.questionId),
          selectedChoiceId: String(answer.selectedChoiceId),
          isCorrect: Boolean(answer.isCorrect),
          answeredAt: toMillis(answer.answeredAt) ?? Number(answer.answeredAt ?? Date.now()),
          responseTimeMs: Number(answer.responseTimeMs ?? 0),
        }))
      : [],
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

const mapMagicInventoryItem = (value: unknown): MagicInventoryItem => {
  const item = (value ?? {}) as Record<string, unknown>
  return {
    itemType: item.itemType as MagicItemType,
    acquiredAt: Number(item.acquiredAt ?? 0),
    consumed: Boolean(item.consumed),
    consumedAt: item.consumedAt == null ? null : Number(item.consumedAt),
  }
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

const mapTeamMagic = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): TeamMagicState => {
  const data = snapshot.data()
  return {
    teamId: snapshot.id,
    magicHolderPlayerId: data.magicHolderPlayerId == null ? null : String(data.magicHolderPlayerId),
    inventory: Array.isArray(data.inventory) ? data.inventory.map(mapMagicInventoryItem) : [],
    queuedEffect: mapQueuedMagicEffect(data.queuedEffect),
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
    answeredAt: toMillis(data.answeredAt) ?? Date.now(),
  }
}

// Runs when leaving `resolvedQuestionIndex` (advancing to the next question, or completing the
// round). Consolidates every mutation to a given team's magic doc into a single batch.update()
// — a team can be touched both as an effect's source (consuming its own item) and as another
// team's hostile target (its shield consumed) in the same pass, and issuing two separate
// batch.update() calls for the same doc would have the second silently clobber the first.
const resolveQuestionMagicEffects = async (roomCode: string, resolvedQuestionIndex: number): Promise<void> => {
  const magicSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'magic'))
  const magicByTeamId = new Map<string, TeamMagicState>(magicSnapshots.docs.map((document) => [document.id, mapTeamMagic(document)]))
  const touchedTeamIds = new Set<string>()
  const eventOutcomes = new Map<string, 'applied' | 'blocked'>()
  const now = Date.now()

  const consumeOne = (teamId: string, itemType: MagicItemType): void => {
    const item = magicByTeamId.get(teamId)?.inventory.find((entry) => entry.itemType === itemType && !entry.consumed)
    if (item) {
      item.consumed = true
      item.consumedAt = now
      touchedTeamIds.add(teamId)
    }
  }

  for (const magic of magicByTeamId.values()) {
    const effect = magic.queuedEffect
    if (!effect || effect.affectedQuestionIndex !== resolvedQuestionIndex) continue
    touchedTeamIds.add(magic.teamId)
    magic.queuedEffect = null
    if (effect.itemType === 'power_surge') {
      consumeOne(magic.teamId, 'power_surge')
      eventOutcomes.set(effect.id, 'applied')
    } else {
      consumeOne(magic.teamId, 'score_seal')
      const shieldItem = magicByTeamId.get(effect.targetTeamId)?.inventory.find((entry) => entry.itemType === 'rose_shield' && !entry.consumed)
      if (shieldItem) {
        shieldItem.consumed = true
        shieldItem.consumedAt = now
        touchedTeamIds.add(effect.targetTeamId)
        eventOutcomes.set(effect.id, 'blocked')
      } else {
        eventOutcomes.set(effect.id, 'applied')
      }
    }
  }

  if (touchedTeamIds.size === 0 && eventOutcomes.size === 0) return
  const batch = writeBatch(db)
  touchedTeamIds.forEach((teamId) => {
    const magic = magicByTeamId.get(teamId)
    if (!magic) return
    batch.update(doc(db, 'rooms', roomCode, 'magic', teamId), { inventory: magic.inventory, queuedEffect: magic.queuedEffect })
  })
  eventOutcomes.forEach((status, eventId) => {
    batch.update(doc(db, 'rooms', roomCode, 'magicEvents', eventId), { status, resolvedAt: serverTimestamp() })
  })
  await batch.commit()
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
    batch.update(document.ref, { inventory: [], queuedEffect: null })
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
        const teamsWithoutStartingItem = roomForMagicCheck.teams.filter((team) => (magicByTeamId.get(team.id)?.inventory.length ?? 0) === 0)
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
        winner: null,
      })
    })
    const batch = writeBatch(db)
    playerSnapshots.docs.forEach((playerDocument) => batch.update(playerDocument.ref, { status: 'playing' }))
    await batch.commit()
  }

  async advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void> {
    const roomRef = doc(db, 'rooms', roomCode)
    const finished = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status !== 'playing' || room.currentQuestionIndex !== expectedQuestionIndex) return false
      const nextQuestionIndex = expectedQuestionIndex + 1
      if (nextQuestionIndex >= room.questionIds.length) {
        transaction.update(roomRef, {
          status: 'completed',
          completedAt: serverTimestamp(),
          currentQuestionIndex: room.questionIds.length,
          questionStartedAt: null,
        })
        return true
      }
      transaction.update(roomRef, { currentQuestionIndex: nextQuestionIndex, questionStartedAt: serverTimestamp() })
      return false
    })
    // Resolve any magic effects queued for the question just left, regardless of whether the
    // round just completed.
    await resolveQuestionMagicEffects(roomCode, expectedQuestionIndex)
    if (!finished) return
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
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
      previousQuestionIds: room.questionIds,
      questionIds,
      winner: null,
    })
    playerSnapshots.docs.forEach((playerDocument) => {
      batch.update(playerDocument.ref, {
        currentRound,
        currentQuestionIndex: 0,
        score: 0,
        answers: [],
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
      previousQuestionIds: room.questionIds,
      questionIds,
      winner: null,
    })
    playerSnapshots.docs.forEach((playerDocument) => {
      batch.update(playerDocument.ref, {
        currentRound,
        currentQuestionIndex: 0,
        score: 0,
        answers: [],
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
        inventory: [],
        queuedEffect: null,
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
      const deadline = (room.questionStartedAt ?? 0) + room.questionDurationSeconds * 1_000
      if (!room.questionStartedAt || Date.now() >= deadline) throw new Error('ผู้ใช้:หมดเวลาตอบคำถามข้อนี้แล้ว')
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
      if (magic.inventory.length > 0) throw new Error('ผู้ใช้:ทีมนี้เลือกไอเทมเริ่มต้นไปแล้ว')
      transaction.update(magicRef, {
        inventory: [{ itemType, acquiredAt: Date.now(), consumed: false, consumedAt: null }],
      })
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

      const window = getMagicActivationWindow(room)
      if (!window.valid || window.affectedQuestionIndex == null) {
        throw new Error('ผู้ใช้:ไม่สามารถใช้ไอเทมได้ในขณะนี้ กรุณารอช่วงพักหรือรอบถัดไป')
      }
      const affectedQuestionIndex = window.affectedQuestionIndex

      const inventoryItem = magic.inventory.find((item) => item.itemType === itemType && !item.consumed)
      if (!inventoryItem) throw new Error('ผู้ใช้:ไม่มีไอเทมนี้ในคลังของทีม')

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
        const otherTeams = room.teams.filter((team) => team.id !== teamId)
        const otherMagicSnapshots = await Promise.all(
          otherTeams.map((team) => transaction.get(doc(db, 'rooms', roomCode, 'magic', team.id))),
        )
        const alreadyTargeted = otherMagicSnapshots.some((snapshot) => {
          if (!snapshot.exists()) return false
          const otherMagic = mapTeamMagic(snapshot)
          return otherMagic.queuedEffect?.itemType === 'score_seal'
            && otherMagic.queuedEffect.targetTeamId === targetTeamId
            && otherMagic.queuedEffect.affectedQuestionIndex === affectedQuestionIndex
        })
        if (alreadyTargeted) {
          logRejectedEvent(targetTeamId)
          throw new Error('ผู้ใช้:ทีมเป้าหมายถูกใช้ไอเทมฝ่ายตรงข้ามในข้อนี้ไปแล้ว')
        }
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
        createdAt: serverTimestamp(),
        resolvedAt: null,
      })
    })
  }
}
