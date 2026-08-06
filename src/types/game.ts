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

export interface Winner {
  teamId: string
  teamName: string
  guardianName: string
  score: number
  finishedAt: number
  elapsedMs: number
  round: number
}

export interface TeamMeta {
  id: string
  name: string
}

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
  questionIds: string[]
  previousQuestionIds: string[]
  winner: Winner | null
  teacherSessionId: string
  teamCount: number
  teamsLocked: boolean
  teams: TeamMeta[]
}

export interface Player {
  id: string
  displayName: string
  studentNumber: string
  teamId: string | null
  joinedAt: number
  currentRound: number
  currentQuestionIndex: number
  score: number
  answers: AnswerRecord[]
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
