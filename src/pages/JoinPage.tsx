import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BrandHeader, ScenePage } from '../components/Layout'
import { useGame } from '../context/GameContext'
import { validateJoinInput } from '../lib/game'
import { friendlyError } from '../services'
import { savePlayerSession } from '../services/sessionStorage'
import type { JoinInput } from '../types/game'

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
    <ScenePage image="/images/hero-curse.png" imageAlt="ดอกกุหลาบต้องคำสาป" imagePosition="50% 55%">
      <BrandHeader backTo="/" />
      <div className="mx-auto flex w-full max-w-6xl flex-1 items-center px-5 py-8 sm:px-8">
        <div className="grid w-full items-center gap-8 lg:grid-cols-[0.8fr_1.2fr]">
          <section className="hidden lg:block">
            <p className="eyebrow">สำหรับผู้เรียน</p>
            <h1 className="mt-3 text-5xl font-semibold leading-tight">รวมพลัง<br />ผู้พิทักษ์</h1>
            <p className="mt-4 max-w-sm text-lg leading-relaxed text-[#d8d1c5]">กรอกชื่อและเลขที่นักเรียนของคุณ แล้วใช้รหัสจากครูเพื่อเข้าสู่ภารกิจเดียวกัน ครูจะจัดทีมให้ในภายหลัง</p>
          </section>
          <form className="glass-panel ml-auto w-full max-w-xl p-6 sm:p-8" onSubmit={submit} noValidate>
            <p className="eyebrow">เข้าสู่ห้องกิจกรรม</p>
            <h1 className="mt-2 text-3xl font-semibold">เตรียมตัวผู้เล่น</h1>
            {service.isDemo ? (
              <button type="button" className="demo-banner mt-5 w-full text-left" onClick={() => update('roomCode', service.demoRoomCode ?? 'MATANA')}>
                <span className="demo-dot" aria-hidden="true" />
                <span><strong>โหมดสาธิตพร้อมใช้</strong><small>แตะเพื่อใช้รหัสห้อง {service.demoRoomCode}</small></span>
              </button>
            ) : null}
            <div className="mt-6 space-y-5">
              <label className="field-label">
                <span>รหัสห้อง</span>
                <input
                  className="text-center font-mono text-2xl uppercase tracking-[0.28em]"
                  value={values.roomCode}
                  onChange={(event) => update('roomCode', event.target.value.replace(/\s/g, ''))}
                  maxLength={6}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="ABC234"
                  aria-invalid={Boolean(errors.roomCode)}
                  aria-describedby={errors.roomCode ? 'room-code-error' : undefined}
                />
                {errors.roomCode ? <small id="room-code-error" className="field-error">{errors.roomCode}</small> : null}
              </label>
              <label className="field-label">
                <span>ชื่อผู้เล่น</span>
                <input value={values.displayName} onChange={(event) => update('displayName', event.target.value)} maxLength={40} autoComplete="name" placeholder="ชื่อ-นามสกุล หรือชื่อเล่น" aria-invalid={Boolean(errors.displayName)} />
                {errors.displayName ? <small className="field-error">{errors.displayName}</small> : null}
              </label>
              <label className="field-label">
                <span>เลขที่นักเรียน</span>
                <input value={values.studentNumber} onChange={(event) => update('studentNumber', event.target.value)} maxLength={20} autoComplete="off" placeholder="เช่น 12" aria-invalid={Boolean(errors.studentNumber)} />
                {errors.studentNumber ? <small className="field-error">{errors.studentNumber}</small> : null}
              </label>
            </div>
            {submitError ? <p className="error-message mt-5" role="alert">{submitError}</p> : null}
            <button className="primary-button mt-6 w-full" type="submit" disabled={busy}>
              <span>{busy ? 'กำลังเข้าร่วมห้อง...' : 'เข้าสู่ภารกิจ'}</span><span aria-hidden="true">→</span>
            </button>
            <Link className="quiet-link mx-auto mt-5 w-fit" to="/">กลับไปเลือกบทบาท</Link>
          </form>
        </div>
      </div>
    </ScenePage>
  )
}
