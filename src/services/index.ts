import type { GameService } from './gameService'
import { DemoGameService } from './demoService'

const demoMode = import.meta.env.VITE_DEMO_MODE !== 'false'

const createService = async (): Promise<GameService> => {
  if (demoMode) return new DemoGameService()
  const { FirebaseGameService } = await import('./firebaseService')
  return new FirebaseGameService()
}

export const gameServicePromise = createService()
export { friendlyError } from './gameService'
export type { GameService } from './gameService'
