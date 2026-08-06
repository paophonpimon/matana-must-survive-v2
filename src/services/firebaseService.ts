import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Timestamp,
} from 'firebase/firestore'
import { questions, questionsById } from '../data/questions'
import { evaluateChoice, generateRoomCode, selectRoundQuestions } from '../lib/game'
import { buildTeamMetas, distributeTeamsEvenly } from '../lib/teamScoring'
import { ensureAnonymousUser, resolveOwnerUid } from './firebaseAuth'
import { resolveJoinPermissionDeniedMessage, type AnswerInput, type AnswerResult, type GameService } from './gameService'
import type { AnswerRecord, JoinInput, JoinResult, Player, Room, TeamMeta, Unsubscribe, Winner } from '../types/game'

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

  async startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number): Promise<void> {
    const playerSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'players'))
    if (playerSnapshots.empty) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังเริ่มภารกิจไม่ได้')
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

    // One atomic batch for the room's team labels AND every player's teamId — Firestore
    // commits a batch all-or-nothing, so the room can never say teams are assigned while
    // some players are still unassigned (well under the 500-op batch limit at ~50 students).
    const batch = writeBatch(db)
    batch.update(roomRef, { teamCount, teams: buildTeamMetas(teamCount) })
    playerSnapshots.docs.forEach((playerDocument) => {
      batch.update(playerDocument.ref, { teamId: assignment[playerDocument.id] })
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
}
