import type { TeacherSession, TeamSession } from '../types/game'

const TEAM_SESSION_KEY = 'matana_team_session'
const TEACHER_SESSION_KEY = 'matana_teacher_session'

const safeParse = <T>(value: string | null): T | null => {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export const getTeamSession = (): TeamSession | null => safeParse<TeamSession>(localStorage.getItem(TEAM_SESSION_KEY))

export const saveTeamSession = (session: TeamSession): void => {
  localStorage.setItem(TEAM_SESSION_KEY, JSON.stringify(session))
}

export const clearTeamSession = (): void => localStorage.removeItem(TEAM_SESSION_KEY)

export const getTeacherSession = (): TeacherSession | null =>
  safeParse<TeacherSession>(localStorage.getItem(TEACHER_SESSION_KEY))

export const saveTeacherSession = (session: TeacherSession): void => {
  localStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session))
}

export const clearTeacherSession = (): void => localStorage.removeItem(TEACHER_SESSION_KEY)
