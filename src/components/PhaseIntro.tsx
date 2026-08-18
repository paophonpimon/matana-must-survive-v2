import { useEffect, useState } from 'react'
import { PHASE_INTRO_MILLISECONDS } from '../types/game'

export type PhaseIntroKey = 'preTest' | 'recall' | 'teamSetup' | 'main' | 'boss' | 'postTest' | 'survey' | 'result'

const INTRO_COPY: Record<PhaseIntroKey, { eyebrow: string; title: string }> = {
  preTest: { eyebrow: 'ก่อนคำสาปจะเริ่มต้น', title: 'พิสูจน์ความรู้ก่อนออกเดินทาง' },
  recall: { eyebrow: 'ความทรงจำที่เลือนหาย', title: 'ทบทวนเรื่องราวแห่งมัทนะพาธา' },
  teamSetup: { eyebrow: 'ถึงเวลารวมพลัง', title: 'เหล่าผู้พิทักษ์กำลังถูกจัดทีม' },
  main: { eyebrow: 'คำสาปเริ่มเคลื่อนไหว', title: 'ภารกิจช่วยมัทนาเริ่มขึ้นแล้ว' },
  boss: { eyebrow: 'พลังมนตราปะทุ', title: 'เข้าสู่ศึกชิงมนตรา' },
  postTest: { eyebrow: 'ก่อนเรื่องราวจะปิดฉาก', title: 'พิสูจน์สิ่งที่คุณได้เรียนรู้' },
  survey: { eyebrow: 'เสียงจากผู้เล่น', title: 'บอกเราถึงประสบการณ์ของคุณ' },
  result: { eyebrow: 'บทสรุปแห่งคำสาป', title: 'ถึงเวลารับผลของการตัดสินใจ' },
}

const SHOWN_KEY_PREFIX = 'matana:phase-intro:'

// Once per REAL phase entry. The key carries room + round + phase, so a new round genuinely
// replays each intro while a refresh, a reconnect or an ordinary rerender inside the same phase
// does not — sessionStorage survives a reload but not a new tab, which is exactly the scope
// wanted. A read/write failure (private mode, storage disabled) degrades to "show it", never to a
// loop, because the effect runs once per mounted key.
const hasShownIntro = (key: string): boolean => {
  try {
    return sessionStorage.getItem(SHOWN_KEY_PREFIX + key) === '1'
  } catch {
    return false
  }
}

const markIntroShown = (key: string): void => {
  try {
    sessionStorage.setItem(SHOWN_KEY_PREFIX + key, '1')
  } catch {
    // Nothing to do — worst case the intro plays again after a reload.
  }
}

interface PhaseIntroProps {
  phase: PhaseIntroKey | null
  /** Uniquely identifies this entry, e.g. `${roomCode}-${round}`. */
  entryKey: string
}

// Short cinematic transition between MAJOR activities — never between ordinary questions.
//
// CSS only: a dark wash, a vignette and two lines of text that fade in and back out over
// PHASE_INTRO_MILLISECONDS. No artwork, no images, no sound. The same constant is used by the
// services to offset every timed activity's start instant, so the intro plays over a clock that
// has not begun and no activity loses time to it.
export const PhaseIntro = ({ phase, entryKey }: PhaseIntroProps) => {
  const introKey = phase ? `${entryKey}-${phase}` : ''
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!phase || !introKey || hasShownIntro(introKey)) return
    // Marked immediately, not on completion: if the student reloads mid-intro it must not restart.
    markIntroShown(introKey)
    setVisible(true)
    const timeoutId = window.setTimeout(() => setVisible(false), PHASE_INTRO_MILLISECONDS)
    return () => window.clearTimeout(timeoutId)
  }, [introKey, phase])

  if (!visible || !phase) return null
  const copy = INTRO_COPY[phase]

  return (
    <div className="phase-intro" role="presentation" aria-hidden="true">
      <div className="phase-intro-vignette" />
      <div className="phase-intro-copy">
        <p className="phase-intro-eyebrow">{copy.eyebrow}</p>
        <p className="phase-intro-title">{copy.title}</p>
      </div>
    </div>
  )
}
