import type { GameService } from './gameService'
import { DemoGameService } from './demoService'

const demoMode = import.meta.env.VITE_DEMO_MODE !== 'false'

const createService = async (): Promise<GameService> => {
  if (demoMode) return new DemoGameService()
  const { FirebaseGameService } = await import('./firebaseService')
  return new FirebaseGameService()
}

let cachedGameServicePromise: Promise<GameService> | null = null

// Lazy by design: the dedicated presentation route supplies its own local service to
// GameProvider, so a Firebase-backed build must not even initialize Firebase merely because the
// shared service module was imported. Production routes call this on mount and receive the same
// cached singleton behavior as before.
export const getGameServicePromise = (): Promise<GameService> => {
  cachedGameServicePromise ??= createService()
  return cachedGameServicePromise
}
// A separate service instance for the explicit presentation route. It is never selected by an
// environment flag and never imports Firebase, so opening /demo/teacher cannot create or mutate a
// production room even when the rest of the build is Firebase-backed.
export const presentationDemoServicePromise: Promise<GameService> = Promise.resolve(
  new DemoGameService({ presentation: true }),
)
export { friendlyError } from './gameService'
export type { GameService } from './gameService'
