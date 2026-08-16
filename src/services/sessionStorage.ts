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

export const getTeacherSession = (): TeacherSession | null =>
  safeParse<TeacherSession>(sessionStorage.getItem(TEACHER_SESSION_KEY))

export const saveTeacherSession = (session: TeacherSession): void => {
  sessionStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session))
}

export const clearTeacherSession = (): void => sessionStorage.removeItem(TEACHER_SESSION_KEY)

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

// Story Recall per-item countdown anchor. Recall is individual and player-paced, so there is no
// room-level timer to resume from — without this a refresh mid-question restarted the countdown,
// silently handing the student a full fresh duration (or, worse, re-running an already-expired
// question). Kept in sessionStorage (not Firestore) deliberately: it is per-tab display timing for
// a non-competitive phase, so it needs none of the cost, rules surface, or write volume of room
// state — matching this file's existing rationale for the popup/banner dedup keys above.
//
// Keyed by room + player, and the stored mark carries round + conceptId, so a mark only ever
// applies to the exact question it was written for. Moving to the next question, a new round, or a
// different room simply fails that match (and overwrites the mark), which is what makes stale
// timing impossible without any explicit cleanup pass.
export interface RecallTimerMark {
  round: number
  conceptId: string
  startedAt: number
}

const recallTimerKey = (roomCode: string, playerId: string): string => `matana_recall_timer_${roomCode}_${playerId}`

export const readRecallTimerMark = (roomCode: string, playerId: string): RecallTimerMark | null => {
  const mark = safeParse<RecallTimerMark>(sessionStorage.getItem(recallTimerKey(roomCode, playerId)))
  if (!mark || typeof mark.startedAt !== 'number' || typeof mark.conceptId !== 'string') return null
  return mark
}

export const writeRecallTimerMark = (roomCode: string, playerId: string, mark: RecallTimerMark): void => {
  sessionStorage.setItem(recallTimerKey(roomCode, playerId), JSON.stringify(mark))
}

export const clearRecallTimerMark = (roomCode: string, playerId: string): void => {
  sessionStorage.removeItem(recallTimerKey(roomCode, playerId))
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
