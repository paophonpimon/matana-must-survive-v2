import { questions, questionsById } from '../data/questions'
import { evaluateChoice, generateRoomCode, selectRoundQuestions } from '../lib/game'
import type { AnswerInput, AnswerResult, GameService } from './gameService'
import type { JoinInput, JoinResult, Room, Team, Unsubscribe } from '../types/game'

interface DemoRoomState {
  room: Room
  teams: Record<string, Team>
}

interface DemoState {
  rooms: Record<string, DemoRoomState>
}

const STORAGE_KEY = 'matana_demo_state_v2'
const UPDATE_EVENT = 'matana-demo-update'
const DEMO_ROOM_CODE = 'MATANA'
const SHARED_STATE_PATH = '/__matana_demo_state'
let sharedStateAvailable = false

const createId = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`

const createTeam = (id: string, teamName: string, guardianName: string, ownerUid: string, round = 1): Team => ({
  id,
  teamName,
  guardianName,
  joinedAt: Date.now(),
  currentRound: round,
  currentQuestionIndex: 0,
  score: 0,
  answers: [],
  submitted: false,
  finishedAt: null,
  elapsedMs: null,
  status: 'waiting',
  ownerUid,
})

const createSeedState = (): DemoState => {
  const room: Room = {
    roomCode: DEMO_ROOM_CODE,
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
    teacherSessionId: 'demo-teacher',
  }
  return {
    rooms: {
      [DEMO_ROOM_CODE]: {
        room,
        teams: {
          'demo-team-1': createTeam('demo-team-1', 'กลุ่มกุหลาบรัตติกาล', 'พิมพ์ชนก', 'demo-student-1'),
          'demo-team-2': createTeam('demo-team-2', 'กลุ่มจันทร์กระจ่าง', 'ณัฐวุฒิ', 'demo-student-2'),
          'demo-team-3': createTeam('demo-team-3', 'กลุ่มวรรณศิลป์', 'ศิรินภา', 'demo-student-3'),
        },
      },
    },
  }
}

const normalizeState = (state: DemoState): DemoState => {
  Object.values(state.rooms).forEach(({ room }) => {
    room.currentQuestionIndex ??= 0
    room.questionDurationSeconds ??= 30
    room.questionStartedAt ??= room.status === 'playing' ? room.startedAt : null
  })
  return state
}

const readLocalState = (): DemoState => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return normalizeState(JSON.parse(saved) as DemoState)
  } catch {
    localStorage.removeItem(STORAGE_KEY)
  }
  const seeded = createSeedState()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
  return seeded
}

const writeLocalState = (state: DemoState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

const readSharedState = async (): Promise<{ available: boolean; state: DemoState | null }> => {
  try {
    const response = await fetch(SHARED_STATE_PATH, { cache: 'no-store' })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      sharedStateAvailable = false
      return { available: false, state: null }
    }
    const payload = await response.json() as { state?: DemoState | null }
    sharedStateAvailable = true
    return { available: true, state: payload.state ?? null }
  } catch {
    sharedStateAvailable = false
    return { available: false, state: null }
  }
}

const writeSharedState = async (state: DemoState): Promise<boolean> => {
  try {
    const response = await fetch(SHARED_STATE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    })
    sharedStateAvailable = response.ok
    return response.ok
  } catch {
    sharedStateAvailable = false
    return false
  }
}

const readState = async (): Promise<DemoState> => {
  const shared = await readSharedState()
  if (shared.available) {
    if (shared.state) {
      const normalized = normalizeState(shared.state)
      writeLocalState(normalized)
      return normalized
    }
    const initial = readLocalState()
    await writeSharedState(initial)
    return initial
  }
  return readLocalState()
}

const writeState = async (state: DemoState): Promise<void> => {
  if (sharedStateAvailable) await writeSharedState(state)
  writeLocalState(state)
  window.dispatchEvent(new Event(UPDATE_EVENT))
}

const verifyTeacher = (room: Room, teacherSessionId: string): void => {
  if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้ กรุณาสร้างห้องใหม่')
}

const listen = (callback: () => void): Unsubscribe => {
  const storageListener = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) callback()
  }
  window.addEventListener('storage', storageListener)
  window.addEventListener(UPDATE_EVENT, callback)
  const intervalId = typeof window.setInterval === 'function'
    ? window.setInterval(() => {
        if (sharedStateAvailable) callback()
      }, 300)
    : null
  return () => {
    window.removeEventListener('storage', storageListener)
    window.removeEventListener(UPDATE_EVENT, callback)
    if (intervalId !== null) window.clearInterval(intervalId)
  }
}

export class DemoGameService implements GameService {
  readonly isDemo = true
  readonly demoRoomCode = DEMO_ROOM_CODE

  async resetDemoRoom(): Promise<Room> {
    const state = await readState()
    const seededRoom = createSeedState().rooms[DEMO_ROOM_CODE]
    state.rooms[DEMO_ROOM_CODE] = seededRoom
    await writeState(state)
    return seededRoom.room
  }

  async ensureSession(): Promise<string> {
    const existing = sessionStorage.getItem('matana_demo_uid')
    if (existing) return existing
    const uid = `demo-${createId()}`
    sessionStorage.setItem('matana_demo_uid', uid)
    return uid
  }

  async createRoom(teacherSessionId: string): Promise<Room> {
    const state = await readState()
    let roomCode = generateRoomCode()
    while (state.rooms[roomCode]) roomCode = generateRoomCode()
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
    state.rooms[roomCode] = { room, teams: {} }
    await writeState(state)
    return room
  }

  async joinRoom(input: JoinInput, ownerUid: string): Promise<JoinResult> {
    const state = await readState()
    const roomCode = input.roomCode.trim().toUpperCase()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    if (roomState.room.status === 'closed') throw new Error('ผู้ใช้:ห้องกิจกรรมสิ้นสุดแล้ว')
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:เกมกำลังดำเนินอยู่ ไม่สามารถเข้าร่วมรอบนี้ได้')
    const teamName = input.teamName.trim()
    const duplicate = Object.values(roomState.teams).some(
      (team) => team.teamName.toLocaleLowerCase('th') === teamName.toLocaleLowerCase('th'),
    )
    if (duplicate) throw new Error('ผู้ใช้:ชื่อกลุ่มนี้ถูกใช้แล้ว')
    const teamId = `team-${createId()}`
    const team = createTeam(teamId, teamName, input.guardianName.trim(), ownerUid, roomState.room.currentRound)
    roomState.teams[teamId] = team
    await writeState(state)
    return { room: roomState.room, team }
  }

  subscribeRoom(roomCode: string, listener: (room: Room | null) => void): Unsubscribe {
    const emit = async (): Promise<void> => listener((await readState()).rooms[roomCode.toUpperCase()]?.room ?? null)
    void emit()
    return listen(() => { void emit() })
  }

  subscribeTeams(roomCode: string, listener: (teams: Team[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const teams = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.teams ?? {}).sort((a, b) => a.joinedAt - b.joinedAt)
      listener(teams)
    }
    void emit()
    return listen(() => { void emit() })
  }

  subscribeTeam(roomCode: string, teamId: string, listener: (team: Team | null) => void): Unsubscribe {
    const emit = async (): Promise<void> => listener((await readState()).rooms[roomCode.toUpperCase()]?.teams[teamId] ?? null)
    void emit()
    return listen(() => { void emit() })
  }

  async startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status === 'playing') throw new Error('ผู้ใช้:ภารกิจกำลังดำเนินอยู่แล้ว')
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:กรุณาเตรียมภารกิจรอบใหม่ก่อนเริ่ม')
    if (Object.keys(roomState.teams).length === 0) throw new Error('ผู้ใช้:ยังไม่มีกลุ่มเข้าร่วม จึงยังเริ่มภารกิจไม่ได้')
    roomState.room.status = 'playing'
    roomState.room.startedAt = Date.now()
    roomState.room.currentQuestionIndex = 0
    roomState.room.questionDurationSeconds = Math.max(5, Math.min(600, Math.round(questionDurationSeconds)))
    roomState.room.questionStartedAt = roomState.room.startedAt
    Object.values(roomState.teams).forEach((team) => {
      team.status = 'playing'
    })
    await writeState(state)
  }

  async advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing' || roomState.room.currentQuestionIndex !== expectedQuestionIndex) return
    const nextQuestionIndex = expectedQuestionIndex + 1
    const now = Date.now()
    if (nextQuestionIndex >= roomState.room.questionIds.length) {
      roomState.room.status = 'completed'
      roomState.room.completedAt = now
      roomState.room.currentQuestionIndex = roomState.room.questionIds.length
      roomState.room.questionStartedAt = null
      Object.values(roomState.teams).forEach((team) => {
        team.currentQuestionIndex = roomState.room.questionIds.length
        team.submitted = true
        team.status = 'submitted'
        team.finishedAt = now
        team.elapsedMs = Math.max(0, now - (roomState.room.startedAt ?? now))
      })
    } else {
      roomState.room.currentQuestionIndex = nextQuestionIndex
      roomState.room.questionStartedAt = now
    }
    await writeState(state)
  }

  async prepareNextRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status === 'playing') throw new Error('ผู้ใช้:ยุติรอบปัจจุบันให้เรียบร้อยก่อนเตรียมรอบใหม่')
    const previousQuestionIds = roomState.room.questionIds
    const currentRound = roomState.room.currentRound + 1
    roomState.room = {
      ...roomState.room,
      status: 'waiting',
      currentRound,
      startedAt: null,
      completedAt: null,
      currentQuestionIndex: 0,
      questionStartedAt: null,
      previousQuestionIds,
      questionIds: selectRoundQuestions(questions, previousQuestionIds),
      winner: null,
    }
    Object.values(roomState.teams).forEach((team) => {
      Object.assign(team, {
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
    await writeState(state)
  }

  async stopRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจไม่ได้กำลังดำเนินอยู่')
    const previousQuestionIds = roomState.room.questionIds
    const currentRound = roomState.room.currentRound + 1
    roomState.room = {
      ...roomState.room,
      status: 'waiting',
      currentRound,
      startedAt: null,
      completedAt: null,
      currentQuestionIndex: 0,
      questionStartedAt: null,
      previousQuestionIds,
      questionIds: selectRoundQuestions(questions, previousQuestionIds),
      winner: null,
    }
    Object.values(roomState.teams).forEach((team) => {
      Object.assign(team, {
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
    await writeState(state)
  }

  async closeRoom(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    roomState.room.status = 'closed'
    Object.values(roomState.teams).forEach((team) => {
      team.status = 'stopped'
    })
    await writeState(state)
  }

  async saveAnswer(roomCode: string, teamId: string, answer: AnswerInput): Promise<AnswerResult> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const team = roomState?.teams[teamId]
    if (!roomState || !team) throw new Error('ผู้ใช้:ไม่พบข้อมูลกลุ่มของคุณ')
    if (roomState.room.status === 'completed') throw new Error('ผู้ใช้:ภารกิจรอบนี้สิ้นสุดแล้ว')
    if (roomState.room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจยังไม่เริ่มหรือสิ้นสุดแล้ว')
    if (team.submitted || roomState.room.currentQuestionIndex !== answer.expectedQuestionIndex) throw new Error('ผู้ใช้:ลำดับคำถามเปลี่ยนแล้ว กรุณารอข้อถัดไป')
    const deadline = (roomState.room.questionStartedAt ?? 0) + roomState.room.questionDurationSeconds * 1_000
    if (!roomState.room.questionStartedAt || Date.now() >= deadline) throw new Error('ผู้ใช้:หมดเวลาตอบคำถามข้อนี้แล้ว')
    if (roomState.room.questionIds[answer.expectedQuestionIndex] !== answer.questionId) {
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

    const record = {
      questionId: answer.questionId,
      selectedChoiceId: answer.selectedChoiceId,
      isCorrect,
      answeredAt: Date.now(),
    }
    if (existingAnswerIndex >= 0) team.answers[existingAnswerIndex] = record
    else team.answers.push(record)
    team.score += (isCorrect ? 1 : 0) - (existingAnswer?.isCorrect ? 1 : 0)
    await writeState(state)
    return { team, winner: null }
  }
}
