import type { PlayerSession, TeacherSession } from '../types/game'

const PLAYER_SESSION_KEY = 'matana_player_session'
const TEACHER_SESSION_KEY = 'matana_teacher_session'
const PRESENTATION_DEMO_TEACHER_SESSION_KEY = 'matana_presentation_demo_teacher_session'

export type TeacherSessionScope = 'production' | 'presentation-demo'

const teacherSessionKey = (scope: TeacherSessionScope): string =>
  scope === 'presentation-demo' ? PRESENTATION_DEMO_TEACHER_SESSION_KEY : TEACHER_SESSION_KEY

const safeParse = <T>(value: string | null): T | null => {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

// Milestone 2.2: sessionStorage, not localStorage — this is what makes the active session
// tab-scoped. localStorage is shared across every tab/window on the same origin, so a teacher
// tab and a student tab open side by side in the same browser used to silently share one
// "active session," each overwriting the other's. sessionStorage is per-tab (a duplicated tab
// via Ctrl+Shift+T even gets its own copy), while still surviving a reload of that same tab.
export const getPlayerSession = (): PlayerSession | null => safeParse<PlayerSession>(sessionStorage.getItem(PLAYER_SESSION_KEY))

export const savePlayerSession = (session: PlayerSession): void => {
  sessionStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(session))
}

export const clearPlayerSession = (): void => sessionStorage.removeItem(PLAYER_SESSION_KEY)

export const getTeacherSession = (scope: TeacherSessionScope = 'production'): TeacherSession | null =>
  safeParse<TeacherSession>(sessionStorage.getItem(teacherSessionKey(scope)))

export const saveTeacherSession = (session: TeacherSession, scope: TeacherSessionScope = 'production'): void => {
  sessionStorage.setItem(teacherSessionKey(scope), JSON.stringify(session))
}

export const clearTeacherSession = (scope: TeacherSessionScope = 'production'): void => sessionStorage.removeItem(teacherSessionKey(scope))

// Milestone 4: dedup key for the magic-effect popups (incoming seal / power surge / shield
// block) — sessionStorage (not a React ref/state) so a page refresh in the SAME tab does not
// re-show a popup the player already dismissed, while still resetting naturally for a genuinely
// new tab/session, matching this file's existing per-tab-isolation rationale. Keyed by roomCode
// so a stale key from a previous room played in the same tab never suppresses a popup in a new
// one; keys are composite (`${eventId}:${moment}`) so the SAME event can independently trigger
// its "queued" and "blocked" popups without one suppressing the other.
const shownMagicPopupKey = (roomCode: string): string => `matana_shown_magic_popups_${roomCode}`

export const hasShownMagicPopup = (roomCode: string, popupKey: string): boolean => {
  const shown = safeParse<string[]>(sessionStorage.getItem(shownMagicPopupKey(roomCode)))
  return (shown ?? []).includes(popupKey)
}

export const markMagicPopupShown = (roomCode: string, popupKey: string): void => {
  const shown = safeParse<string[]>(sessionStorage.getItem(shownMagicPopupKey(roomCode))) ?? []
  if (shown.includes(popupKey)) return
  sessionStorage.setItem(shownMagicPopupKey(roomCode), JSON.stringify([...shown, popupKey]))
}

// Milestone 4: "announce the winner and reward on every screen" — a one-time boss-winner
// banner, deduped the same way as the magic popups above (sessionStorage, per tab, survives a
// same-tab refresh). Keyed by round (not a per-event id, unlike magic popups) since a round has
// at most one boss winner.
const shownBossWinnerKey = (roomCode: string, round: number): string => `matana_shown_boss_winner_${roomCode}_${round}`

export const hasShownBossWinnerBanner = (roomCode: string, round: number): boolean =>
  sessionStorage.getItem(shownBossWinnerKey(roomCode, round)) === '1'

export const markBossWinnerBannerShown = (roomCode: string, round: number): void => {
  sessionStorage.setItem(shownBossWinnerKey(roomCode, round), '1')
}
