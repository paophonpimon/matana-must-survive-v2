import { initializeApp } from 'firebase/app'
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth'
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
import type { AnswerInput, AnswerResult, GameService } from './gameService'
import type { AnswerRecord, JoinInput, JoinResult, Room, Team, Unsubscribe, Winner } from '../types/game'

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
})

const mapTeam = (snapshot: QueryDocumentSnapshot<DocumentData> | { id: string; data(): DocumentData }): Team => {
  const data = snapshot.data()
  return {
    id: snapshot.id,
    teamName: String(data.teamName ?? ''),
    guardianName: String(data.guardianName ?? ''),
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
        }))
      : [],
    submitted: Boolean(data.submitted),
    finishedAt: toMillis(data.finishedAt),
    elapsedMs: data.elapsedMs == null ? null : Number(data.elapsedMs),
    status: data.status as Team['status'],
    ownerUid: String(data.ownerUid ?? ''),
  }
}

const stableTeamId = (teamName: string): string => {
  let hash = 2166136261
  for (const character of teamName.trim().toLocaleLowerCase('th')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `team-${(hash >>> 0).toString(36)}`
}

export class FirebaseGameService implements GameService {
  readonly isDemo = false

  async ensureSession(): Promise<string> {
    if (auth.currentUser) return auth.currentUser.uid
    return new Promise((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(
        auth,
        async (user) => {
          if (user) {
            unsubscribe()
            resolve(user.uid)
            return
          }
          try {
            const credential = await signInAnonymously(auth)
            unsubscribe()
            resolve(credential.user.uid)
          } catch {
            unsubscribe()
            reject(new Error('ผู้ใช้:ไม่สามารถเริ่มเซสชันแบบไม่ระบุตัวตนได้ กรุณาลองใหม่'))
          }
        },
        () => {
          unsubscribe()
          reject(new Error('ผู้ใช้:ไม่สามารถตรวจสอบเซสชันได้ กรุณาลองใหม่'))
        },
      )
    })
  }

  async createRoom(teacherSessionId: string): Promise<Room> {
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
      teacherSessionId,
    }
    await runTransaction(db, async (transaction) => {
      const roomRef = doc(db, 'rooms', roomCode)
      if ((await transaction.get(roomRef)).exists()) throw new Error('ผู้ใช้:รหัสห้องซ้ำ กรุณาลองสร้างอีกครั้ง')
      transaction.set(roomRef, { ...room, createdAt: serverTimestamp() })
    })
    return room
  }

  async joinRoom(input: JoinInput, ownerUid: string): Promise<JoinResult> {
    const roomCode = input.roomCode.trim().toUpperCase()
    const teamName = input.teamName.trim()
    const teamId = stableTeamId(teamName)
    const roomRef = doc(db, 'rooms', roomCode)
    const teamRef = doc(db, 'rooms', roomCode, 'teams', teamId)
    try {
      return await runTransaction(db, async (transaction) => {
        const roomSnapshot = await transaction.get(roomRef)
        if (!roomSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
        const room = mapRoom(roomSnapshot.data())
        if (room.status === 'closed') throw new Error('ผู้ใช้:ห้องกิจกรรมสิ้นสุดแล้ว')
        if (room.status !== 'waiting') throw new Error('ผู้ใช้:เกมกำลังดำเนินอยู่ ไม่สามารถเข้าร่วมรอบนี้ได้')
        const team: Team = {
          id: teamId,
          teamName,
          guardianName: input.guardianName.trim(),
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
        // Rules อนุญาต create แต่ปฏิเสธ update ระหว่างรอเริ่มเกม จึงกันชื่อซ้ำได้แบบ atomic
        // โดยไม่ต้องอ่านเอกสารทีมที่นักเรียนคนอื่นไม่มีสิทธิ์เปิดดู
        transaction.set(teamRef, { ...team, joinedAt: serverTimestamp() })
        return { room, team }
      })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'permission-denied') throw new Error('ผู้ใช้:ชื่อกลุ่มนี้ถูกใช้แล้ว กรุณาใช้ชื่ออื่น')
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

  subscribeTeams(roomCode: string, listener: (teams: Team[]) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      collection(db, 'rooms', roomCode.toUpperCase(), 'teams'),
      (snapshot) => listener(snapshot.docs.map(mapTeam).sort((a, b) => a.joinedAt - b.joinedAt)),
      () => onError('ไม่สามารถโหลดรายชื่อกลุ่มได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  subscribeTeam(roomCode: string, teamId: string, listener: (team: Team | null) => void, onError: (message: string) => void): Unsubscribe {
    return onSnapshot(
      doc(db, 'rooms', roomCode.toUpperCase(), 'teams', teamId),
      (snapshot) => listener(snapshot.exists() ? mapTeam(snapshot) : null),
      () => onError('ไม่สามารถโหลดข้อมูลกลุ่มได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    )
  }

  async startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number): Promise<void> {
    const teamSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'teams'))
    if (teamSnapshots.empty) throw new Error('ผู้ใช้:ยังไม่มีกลุ่มเข้าร่วม จึงยังเริ่มภารกิจไม่ได้')
    await runTransaction(db, async (transaction) => {
      const roomRef = doc(db, 'rooms', roomCode)
      const snapshot = await transaction.get(roomRef)
      if (!snapshot.exists()) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
      const room = mapRoom(snapshot.data())
      if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้')
      if (room.status === 'playing') throw new Error('ผู้ใช้:ภารกิจกำลังดำเนินอยู่แล้ว')
      if (room.status !== 'waiting') throw new Error('ผู้ใช้:กรุณาเตรียมภารกิจรอบใหม่ก่อนเริ่ม')
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
    teamSnapshots.docs.forEach((teamDocument) => batch.update(teamDocument.ref, { status: 'playing' }))
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
    const teamSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'teams'))
    const batch = writeBatch(db)
    teamSnapshots.docs.forEach((teamDocument) => batch.update(teamDocument.ref, {
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
    const teamSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'teams'))
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
    teamSnapshots.docs.forEach((teamDocument) => {
      batch.update(teamDocument.ref, {
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
    const teamSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'teams'))
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
    teamSnapshots.docs.forEach((teamDocument) => {
      batch.update(teamDocument.ref, {
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
    const teamSnapshots = await getDocs(collection(db, 'rooms', roomCode, 'teams'))
    const batch = writeBatch(db)
    teamSnapshots.docs.forEach((teamDocument) => batch.update(teamDocument.ref, { status: 'stopped' }))
    await batch.commit()
  }

  async saveAnswer(roomCode: string, teamId: string, answer: AnswerInput): Promise<AnswerResult> {
    const roomRef = doc(db, 'rooms', roomCode)
    const teamRef = doc(db, 'rooms', roomCode, 'teams', teamId)
    return runTransaction(db, async (transaction) => {
      const [roomSnapshot, teamSnapshot] = await Promise.all([transaction.get(roomRef), transaction.get(teamRef)])
      if (!roomSnapshot.exists() || !teamSnapshot.exists()) throw new Error('ผู้ใช้:ไม่พบข้อมูลห้องหรือกลุ่มของคุณ')
      const room = mapRoom(roomSnapshot.data())
      const team = mapTeam(teamSnapshot)
      if (room.status === 'completed') throw new Error('ผู้ใช้:ภารกิจรอบนี้สิ้นสุดแล้ว')
      if (room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจยังไม่เริ่มหรือสิ้นสุดแล้ว')
      if (team.submitted || room.currentQuestionIndex !== answer.expectedQuestionIndex) throw new Error('ผู้ใช้:ลำดับคำถามเปลี่ยนแล้ว กรุณารอข้อถัดไป')
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
      const existingAnswerIndex = team.answers.findIndex((item) => item.questionId === answer.questionId)
      const existingAnswer = existingAnswerIndex >= 0 ? team.answers[existingAnswerIndex] : undefined
      const answerRecord: AnswerRecord = {
        questionId: answer.questionId,
        selectedChoiceId: answer.selectedChoiceId,
        isCorrect,
        answeredAt: Date.now(),
      }
      const answers = [...team.answers]
      if (existingAnswerIndex >= 0) answers[existingAnswerIndex] = answerRecord
      else answers.push(answerRecord)
      const score = team.score + (isCorrect ? 1 : 0) - (existingAnswer?.isCorrect ? 1 : 0)
      transaction.update(teamRef, { answers, score })
      return {
        team: {
          ...team,
          answers,
          score,
        },
        winner: null,
      }
    })
  }
}
