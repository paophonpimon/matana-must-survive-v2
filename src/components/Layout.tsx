import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

interface ScenePageProps {
  children: ReactNode
  image?: string
  imageAlt?: string
  imagePosition?: string
  compact?: boolean
  className?: string
}

export const ScenePage = ({ children, image, imageAlt = '', imagePosition = '50% 50%', compact = false, className = '' }: ScenePageProps) => (
  <main className={`scene-page ${compact ? 'scene-page-compact' : ''} ${className}`.trim()}>
    <div className="scene-fallback" aria-hidden="true" />
    {image ? (
      <img
        className="scene-image"
        src={image}
        alt={imageAlt}
        style={{ objectPosition: imagePosition }}
        onError={(event) => {
          event.currentTarget.hidden = true
        }}
      />
    ) : null}
    <div className="scene-overlay" aria-hidden="true" />
    <div className="scene-vignette" aria-hidden="true" />
    <div className="relative z-10 flex min-h-dvh flex-col">{children}</div>
  </main>
)

export const BrandHeader = ({ backTo, backLabel = 'กลับหน้าแรก' }: { backTo?: string; backLabel?: string }) => (
  <header className="page-header">
    <Link to="/" className="brand-mark" aria-label="มัทนาต้องรอด หน้าแรก">
      <span className="brand-symbol" aria-hidden="true">ม</span>
      <span>
        <strong>มัทนาต้องรอด</strong>
        <small>ภารกิจคลายคำสาป</small>
      </span>
    </Link>
    {backTo ? (
      <Link to={backTo} className="quiet-link">
        <span aria-hidden="true">←</span> {backLabel}
      </Link>
    ) : null}
  </header>
)

export const LoadingPanel = ({ text = 'กำลังเชื่อมต่อกับห้องกิจกรรม...' }: { text?: string }) => (
  <div className="glass-panel mx-auto my-auto w-full max-w-xl p-8 text-center" aria-live="polite">
    <div className="mystic-loader mx-auto" aria-hidden="true" />
    <p className="mt-5 text-lg text-[#fff7df]">{text}</p>
  </div>
)

export const ErrorPanel = ({ message, action }: { message: string; action?: ReactNode }) => (
  <section className="glass-panel mx-auto my-auto w-full max-w-xl p-7 text-center" role="alert">
    <div className="mx-auto grid size-12 place-items-center rounded-full border border-[#c9896b]/50 bg-[#521d3d]/70 text-xl" aria-hidden="true">!</div>
    <h1 className="mt-4 text-2xl font-semibold">ไม่สามารถดำเนินภารกิจได้</h1>
    <p className="mt-3 text-[#ded6c9]">{message}</p>
    {action ? <div className="mt-6">{action}</div> : null}
  </section>
)

export const StatusPill = ({ status }: { status: 'waiting' | 'playing' | 'completed' | 'closed' }) => {
  const labels = {
    waiting: 'รอเริ่มภารกิจ',
    playing: 'กำลังดำเนินภารกิจ',
    completed: 'สรุปคะแนนแล้ว',
    closed: 'ห้องสิ้นสุดแล้ว',
  }
  return <span className={`status-pill status-${status}`}><i aria-hidden="true" />{labels[status]}</span>
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
        <p className="eyebrow">ยืนยันการดำเนินการ</p>
        <h2 id="confirm-title" className="mt-2 text-2xl font-semibold">{title}</h2>
        <p id="confirm-description" className="mt-3 text-[#d8d1c5]">{description}</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="button" className={destructive ? 'danger-button' : 'primary-button'} onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? 'กำลังดำเนินการ...' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
