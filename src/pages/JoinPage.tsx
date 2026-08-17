import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useGame } from '../context/GameContext'
import { validateJoinInput } from '../lib/game'
import { friendlyError } from '../services'
import { savePlayerSession } from '../services/sessionStorage'
import type { JoinInput } from '../types/game'

// Decorative leading marks for the three fields. They carry no meaning the label does not already
// state, so they stay aria-hidden and are never the only cue for anything.
const LockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" />
    <circle cx="12" cy="15.2" r="1.4" />
  </svg>
)

const PersonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="12" cy="8.4" r="3.7" />
    <path d="M4.8 20c0-3.7 3.2-6.1 7.2-6.1s7.2 2.4 7.2 6.1" />
  </svg>
)

const CardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <circle cx="8.7" cy="11" r="2" />
    <path d="M5.8 16c.4-1.5 1.5-2.3 2.9-2.3s2.5.8 2.9 2.3M14.4 10.4h4.1M14.4 13.6h4.1" />
  </svg>
)

const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M4 10.8 12 4.5l8 6.3" />
    <path d="M6.3 12.4V19h11.4v-6.6" />
  </svg>
)

// Join deliberately does NOT use ScenePage: that wrapper layers a fallback gradient, overlay and
// vignette tuned to the old hero art. This screen owns its own stacking so it can reuse the
// approved Home background and logo directly, the same way HomePage does.
//
// Routes, validation, field behaviour and submit logic below are unchanged.
export const JoinPage = () => {
  const { service, uid } = useGame()
  const navigate = useNavigate()
  const [values, setValues] = useState<JoinInput>({ roomCode: '', displayName: '', studentNumber: '' })
  const [errors, setErrors] = useState<Partial<Record<keyof JoinInput, string>>>({})
  const [submitError, setSubmitError] = useState('')
  const [busy, setBusy] = useState(false)

  const update = (field: keyof JoinInput, value: string): void => {
    setValues((current) => ({ ...current, [field]: field === 'roomCode' ? value.toUpperCase() : value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const nextValues = {
      roomCode: values.roomCode.trim().toUpperCase(),
      displayName: values.displayName.trim(),
      studentNumber: values.studentNumber.trim(),
    }
    const nextErrors = validateJoinInput(nextValues)
    setErrors(nextErrors)
    setSubmitError('')
    if (Object.keys(nextErrors).length > 0) return
    setBusy(true)
    try {
      const { player, room } = await service.joinRoom(nextValues, uid)
      savePlayerSession({
        roomCode: room.roomCode,
        playerId: player.id,
        displayName: player.displayName,
        studentNumber: player.studentNumber,
        role: 'student',
      })
      navigate(`/lobby/${room.roomCode}`, { replace: true })
    } catch (reason) {
      const message = friendlyError(reason)
      if (message.startsWith('เลขที่นักเรียนนี้ถูกใช้แล้ว')) {
        setErrors((current) => ({ ...current, studentNumber: message }))
      } else {
        setSubmitError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="join-page">
      <img className="join-bg" src="/assets/home/home-bg.png" alt="" aria-hidden="true" />
      <div className="join-scrim" aria-hidden="true" />

      <header className="join-header">
        <Link className="join-brand" to="/" aria-label="มัทนาต้องรอด หน้าแรก">
          <img src="/assets/home/home-logo.png" alt="" aria-hidden="true" />
        </Link>
        <Link className="join-home-link" to="/">
          <HomeIcon />
          <span>กลับหน้าหลัก</span>
        </Link>
      </header>

      <div className="join-layout">
        <section className="join-intro">
          <p className="join-eyebrow">สำหรับผู้เรียน</p>
          <h1 className="join-title">รวมพลังผู้พิทักษ์</h1>
          <p className="join-lede">กรอกชื่อและเลขที่นักเรียนของคุณ แล้วใช้รหัสจากครูเพื่อเข้าสู่ภารกิจเดียวกัน ครูจะจัดทีมให้ในภายหลัง</p>
        </section>

        <form className="join-form" onSubmit={submit} noValidate>
          <p className="join-form-eyebrow">เข้าสู่ห้องกิจกรรม</p>
          <h2 className="join-form-title">เตรียมตัวผู้เล่น</h2>

          {service.isDemo ? (
            <button type="button" className="demo-banner join-demo" onClick={() => update('roomCode', service.demoRoomCode ?? 'MATANA')}>
              <span className="demo-dot" aria-hidden="true" />
              <span><strong>โหมดสาธิตพร้อมใช้</strong><small>แตะเพื่อใช้รหัสห้อง {service.demoRoomCode}</small></span>
            </button>
          ) : null}

          <div className="join-fields">
            {/* Room code keeps the emphasised dark treatment: it is the one value the teacher
                reads out, so it stays the visual anchor of the form. */}
            <label className="field-label join-field join-field-code">
              <span>รหัสห้อง</span>
              <span className="join-input-shell">
                <span className="join-input-icon" aria-hidden="true"><LockIcon /></span>
                <input
                  value={values.roomCode}
                  onChange={(event) => update('roomCode', event.target.value.replace(/\s/g, ''))}
                  // New rooms use a 4-digit code, but maxLength stays 6 — not a leftover, this
                  // is what still lets a room created under the old 6-character format be typed
                  // in full (see validateJoinInput's dual-pattern check in lib/game.ts).
                  // inputMode stays "text" (not "numeric") for the same reason: a numeric virtual
                  // keyboard would make legacy alphanumeric codes awkward to enter on mobile.
                  maxLength={6}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="0000"
                  aria-invalid={Boolean(errors.roomCode)}
                  aria-describedby={errors.roomCode ? 'room-code-error' : undefined}
                />
              </span>
              {errors.roomCode ? <small id="room-code-error" className="field-error">{errors.roomCode}</small> : null}
            </label>

            <label className="field-label join-field">
              <span>ชื่อผู้เล่น</span>
              <span className="join-input-shell">
                <span className="join-input-icon" aria-hidden="true"><PersonIcon /></span>
                <input value={values.displayName} onChange={(event) => update('displayName', event.target.value)} maxLength={40} autoComplete="name" placeholder="ชื่อ-นามสกุล หรือชื่อเล่น" aria-invalid={Boolean(errors.displayName)} />
              </span>
              {errors.displayName ? <small className="field-error">{errors.displayName}</small> : null}
            </label>

            <label className="field-label join-field">
              <span>เลขที่นักเรียน</span>
              <span className="join-input-shell">
                <span className="join-input-icon" aria-hidden="true"><CardIcon /></span>
                <input value={values.studentNumber} onChange={(event) => update('studentNumber', event.target.value)} maxLength={20} autoComplete="off" placeholder="เช่น 12" aria-invalid={Boolean(errors.studentNumber)} />
              </span>
              {errors.studentNumber ? <small className="field-error">{errors.studentNumber}</small> : null}
            </label>
          </div>

          {submitError ? <p className="error-message join-error" role="alert">{submitError}</p> : null}

          <button className="join-submit" type="submit" disabled={busy}>
            <span>{busy ? 'กำลังเข้าร่วมห้อง...' : 'เข้าสู่ภารกิจ'}</span>
          </button>

          <Link className="join-back-link" to="/">กลับไปเลือกบทบาท</Link>
        </form>
      </div>
    </main>
  )
}
