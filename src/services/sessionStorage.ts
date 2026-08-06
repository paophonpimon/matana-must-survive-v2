import type { PlayerSession, TeacherSession } from '../types/game'

const PLAYER_SESSION_KEY = 'matana_player_session'
const TEACHER_SESSION_KEY = 'matana_teacher_session'

const safeParse = <T>(value: string | null): T | null => {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export const getPlayerSession = (): PlayerSession | null => safeParse<PlayerSession>(localStorage.getItem(PLAYER_SESSION_KEY))

export const savePlayerSession = (session: PlayerSession): void => {
  localStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(session))
}

export const clearPlayerSession = (): void => localStorage.removeItem(PLAYER_SESSION_KEY)

export const getTeacherSession = (): TeacherSession | null =>
  safeParse<TeacherSession>(localStorage.getItem(TEACHER_SESSION_KEY))

export const saveTeacherSession = (session: TeacherSession): void => {
  localStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session))
}

export const clearTeacherSession = (): void => localStorage.removeItem(TEACHER_SESSION_KEY)
