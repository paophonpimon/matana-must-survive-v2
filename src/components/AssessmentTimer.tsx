import type { AssessmentClockState } from '../hooks/useAssessmentClock'

// Deliberately quiet: a plain remaining-time readout with no ranking, no per-question pressure and
// no colour until the final stretch. The assessment measures knowledge, not speed, so the timer is
// information rather than a scoreboard.
export const AssessmentTimer = ({ state, className = '' }: { state: AssessmentClockState; className?: string }) => (
  <span
    className={`assessment-timer ${state.warning ? 'assessment-timer-warning' : ''} ${state.expired ? 'assessment-timer-expired' : ''} ${className}`}
    role="timer"
    aria-live={state.warning ? 'polite' : 'off'}
  >
    <small>เวลาที่เหลือ</small>
    <strong>{state.expired ? 'หมดเวลา' : state.label}</strong>
  </span>
)
