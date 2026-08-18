import { useEffect, useState } from 'react'
import { formatAssessmentClock } from '../lib/assessmentClock'
import { getAssessmentRemainingMilliseconds, isAssessmentExpired, type AssessmentWindow } from '../lib/gameFlow'
import { ASSESSMENT_WARNING_MILLISECONDS } from '../types/game'

// Re-exported for callers that build the window with gameFlow's preTestWindow/postTestWindow.
export type AssessmentClock = AssessmentWindow

export interface AssessmentClockState {
  open: boolean
  expired: boolean
  remainingMs: number
  label: string
  warning: boolean
}

// Single derivation of assessment time, shared by the student screens and the teacher screens so
// the two can never disagree about how much time is left or whether the test is over.
//
// Everything is computed from the room's persisted startedAt — there is no local countdown that a
// refresh could restart, and no accumulated client state that a reconnect could extend. The tick
// only re-renders; it never advances a stored value.
export const useAssessmentClock = (clock: AssessmentClock): AssessmentClockState => {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (clock.startedAt == null) return
    const intervalId = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(intervalId)
  }, [clock.startedAt])

  // The persisted startedAt is the real instant the teacher opened the test; the phase-intro
  // offset is applied here, on read, so no client clock becomes the stored authority.
  const assessmentWindow = clock
  const remainingMs = getAssessmentRemainingMilliseconds(assessmentWindow, now)
  const expired = isAssessmentExpired(assessmentWindow, now)
  return {
    open: clock.startedAt != null && !expired,
    expired,
    remainingMs,
    label: formatAssessmentClock(remainingMs),
    warning: clock.startedAt != null && !expired && remainingMs <= ASSESSMENT_WARNING_MILLISECONDS,
  }
}
