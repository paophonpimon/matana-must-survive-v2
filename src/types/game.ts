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
export type TeamStatus = 'waiting' | 'playing' | 'submitted' | 'stopped'

export interface AnswerRecord {
  questionId: string
  selectedChoiceId: string
  isCorrect: boolean
  answeredAt: number
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
}

export interface Team {
  id: string
  teamName: string
  guardianName: string
  joinedAt: number
  currentRound: number
  currentQuestionIndex: number
  score: number
  answers: AnswerRecord[]
  submitted: boolean
  finishedAt: number | null
  elapsedMs: number | null
  status: TeamStatus
  ownerUid: string
}

export interface TeamSession {
  roomCode: string
  teamId: string
  teamName: string
  guardianName: string
  role: 'student'
}

export interface TeacherSession {
  teacherSessionId: string
  roomCode?: string
  role: 'teacher'
}

export interface JoinInput {
  roomCode: string
  teamName: string
  guardianName: string
}

export interface JoinResult {
  room: Room
  team: Team
}

export type Unsubscribe = () => void
