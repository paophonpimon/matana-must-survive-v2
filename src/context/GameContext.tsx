import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { gameServicePromise, friendlyError, type GameService } from '../services'

interface GameContextValue {
  service: GameService
  uid: string
}

const GameContext = createContext<GameContextValue | null>(null)

export const GameProvider = ({ children }: { children: ReactNode }) => {
  const [service, setService] = useState<GameService | null>(null)
  const [uid, setUid] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setError('')
    gameServicePromise
      .then(async (nextService) => {
        const nextUid = await nextService.ensureSession()
        if (active) {
          setService(nextService)
          setUid(nextUid)
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(friendlyError(reason))
      })
    return () => {
      active = false
    }
  }, [attempt])

  const value = useMemo(() => (service && uid ? { service, uid } : null), [service, uid])

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#080b23] px-5 text-center text-[#fff7df]">
        <section className="glass-panel max-w-lg p-7">
          <p className="eyebrow">การเชื่อมต่อขัดข้อง</p>
          <h1 className="mt-3 text-2xl font-semibold">ยังเปิดประตูสู่ภารกิจไม่ได้</h1>
          <p className="mt-3 text-[#d8d1c5]">{error}</p>
          <button className="primary-button mt-6 w-full" onClick={() => setAttempt((value) => value + 1)}>
            ลองเชื่อมต่ออีกครั้ง
          </button>
        </section>
      </main>
    )
  }

  if (!value) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#080b23] px-5 text-[#fff7df]" aria-live="polite">
        <div className="text-center">
          <div className="mystic-loader mx-auto" aria-hidden="true" />
          <p className="mt-5 text-lg">กำลังเชื่อมต่อกับห้องกิจกรรม...</p>
        </div>
      </main>
    )
  }

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>
}

// Hook และ Provider อยู่ไฟล์เดียวกันเพื่อให้ขอบเขต context ชัดเจน
// eslint-disable-next-line react-refresh/only-export-components
export const useGame = (): GameContextValue => {
  const context = useContext(GameContext)
  if (!context) throw new Error('useGame ต้องอยู่ภายใน GameProvider')
  return context
}
