import { useEffect, useRef, useState } from 'react'

interface NumberStepperProps {
  id: string
  /** Accessible name; used to build the +/- button labels. */
  label: string
  value: string
  onChange: (next: string) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
}

// The one numeric stepper. Structure is strictly [ − ] [ value ] [ + ] — no unit chip between the
// number and the plus button, which unbalanced the control; the unit is already stated by each
// setting's label and helper text.
//
// Renders the Team Setup `.setup-stepper` markup verbatim, so every
// numeric setting in the app shares that visual language rather than growing a parallel style —
// the CSS adds the raised/press/bump treatment to that same class, which means Team Setup gets the
// polish for free and nothing can drift apart.
//
// Layout around it belongs to the caller: Team Setup wraps this in `.setup-field` with its label
// block on the left, while the timing settings wrap it with a label above and a helper below.
export const NumberStepper = ({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
}: NumberStepperProps) => {
  const parsed = Math.round(Number(value))
  const current = Number.isFinite(parsed) ? parsed : min
  const clamp = (next: number): number => Math.max(min, Math.min(max, next))
  // Stepping always lands inside the range, so a button press cannot produce an invalid value even
  // when the field currently holds one from manual typing.
  const adjust = (delta: number): void => onChange(String(clamp(current + delta)))

  // Value-change bump. Keyed off the rendered value rather than the click handler so a change from
  // manual typing pulses too, and skipped on first render so the control does not animate on mount.
  const [bump, setBump] = useState(false)
  const previous = useRef(value)
  useEffect(() => {
    if (previous.current === value) return
    previous.current = value
    setBump(true)
    const timeoutId = window.setTimeout(() => setBump(false), 160)
    return () => window.clearTimeout(timeoutId)
  }, [value])

  return (
    <div className="setup-stepper">
      <button
        type="button"
        onClick={() => adjust(-step)}
        disabled={disabled || current <= min}
        aria-label={`ลด${label}`}
      >
        −
      </button>
      {/* Manual entry stays available for a large jump; the buttons are the primary interaction.
          Clamping on blur means a typed out-of-range value is corrected rather than rejected. */}
      <input
        id={id}
        className={bump ? 'is-bumping' : ''}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => onChange(String(clamp(current)))}
      />
      <button
        type="button"
        onClick={() => adjust(step)}
        disabled={disabled || current >= max}
        aria-label={`เพิ่ม${label}`}
      >
        +
      </button>
    </div>
  )
}

interface SettingStepperProps extends NumberStepperProps {
  helper: string
}

// The label-above / helper-below arrangement the timing settings use. Thin wrapper so those four
// settings stay one-liners at the call site while still rendering the shared control.
export const SettingStepper = ({ helper, ...stepper }: SettingStepperProps) => (
  <div className="stage-duration-field">
    <label htmlFor={stepper.id}>{stepper.label}</label>
    <NumberStepper {...stepper} />
    <small>{helper}</small>
  </div>
)
