import { useState } from 'react'
import { SURVEY_ITEMS, SURVEY_ITEM_COUNT, SURVEY_SCALE } from '../data/surveyItems'
import { friendlyError } from '../services'
import type { SurveyResponseInput } from '../services/gameService'
import type { Player } from '../types/game'

interface SurveyPhaseProps {
  player: Player
  onRespond: (input: SurveyResponseInput) => Promise<void>
}

// "แบบประเมินกิจกรรม" — the final individual step, an OPINION survey.
//
// There is no right answer here, so there is no correctness, no score, and no feedback. Nothing in
// this component reads or writes player.score, team score, magic, boss or ranking; the stored
// record (SurveyResponseRecord) has no correctness field at all, so there is nothing for a scoring
// path to pick up even by accident.
//
// Progress is INDIVIDUAL: player.surveyResponses.length IS the current item index, so a refresh, a
// reconnect or a device swap resumes at exactly the right statement with no extra state.
export const SurveyPhase = ({ player, onRespond }: SurveyPhaseProps) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const answeredCount = player.surveyResponses.length
  const finished = answeredCount >= SURVEY_ITEM_COUNT
  const currentItem = SURVEY_ITEMS[answeredCount]

  const submit = async (value: string): Promise<void> => {
    if (busy || !currentItem) return
    setBusy(true)
    setError('')
    try {
      // The service validates order/duplication/bounds and that the value is on the 5-point
      // scale. Advancing is implicit: the saved response grows surveyResponses, moving the index.
      await onRespond({ itemId: currentItem.id, value, expectedIndex: answeredCount })
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  if (finished) {
    return (
      <section className="glass-panel w-full p-6 text-center sm:p-8" aria-live="polite">
        <p className="eyebrow">แบบประเมินกิจกรรม</p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">ประเมินกิจกรรมครบแล้ว</h1>
        <div className="waiting-banner mt-6">
          <span className="pulse-dot" aria-hidden="true" />
          <span>
            <strong>รอครูสรุปผลกิจกรรม</strong>
            <small>หน้านี้จะเปลี่ยนให้อัตโนมัติเมื่อครูสรุปผลกิจกรรม</small>
          </span>
        </div>
      </section>
    )
  }

  return (
    <section className="glass-panel w-full p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">แบบประเมินกิจกรรม</p>
        <span className="count-badge">ข้อ {answeredCount + 1} / {SURVEY_ITEM_COUNT}</span>
      </div>

      <h1 className="mt-4 text-xl font-semibold leading-relaxed sm:text-2xl">{currentItem?.statement}</h1>

      <div className="mt-6 grid gap-3">
        {SURVEY_SCALE.map((option) => (
          <button
            key={option.value}
            type="button"
            className="choice-button"
            onClick={() => void submit(option.value)}
            disabled={busy}
          >
            <span>{option.value}</span>
            {option.label}
          </button>
        ))}
      </div>

      {error ? <p className="error-message mt-5" role="alert">{error}</p> : null}

      <p className="mt-5 text-sm text-[#bdb5ac]">
        แบบประเมินนี้ไม่มีคำตอบถูกหรือผิด และไม่มีผลต่อคะแนนใด ๆ
      </p>
    </section>
  )
}
