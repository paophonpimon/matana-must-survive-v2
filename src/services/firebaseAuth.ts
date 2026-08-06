import { signInAnonymously, type Auth, type User } from 'firebase/auth'

// Module-level (not per-call, not per-component) so it is a true process-wide singleton: every
// caller — regardless of how many times React StrictMode re-runs an effect, or how many
// components ask at once — shares the exact same in-flight sign-in. This is what prevents a
// fresh browser profile (no persisted auth state to fall back on) from firing two concurrent
// signInAnonymously requests that Identity Toolkit would happily answer with two DIFFERENT
// uids, leaving GameContext holding a uid that no longer matches auth.currentUser.
let inFlightSignIn: Promise<User> | null = null

export const ensureAnonymousUser = async (auth: Auth): Promise<User> => {
  if (auth.currentUser) return auth.currentUser
  if (inFlightSignIn) return inFlightSignIn

  const signInPromise = signInAnonymously(auth).then((credential) => credential.user)
  inFlightSignIn = signInPromise
  try {
    return await signInPromise
  } finally {
    // Clear only after this attempt settles (success or failure) — never earlier, so a
    // second caller arriving mid-flight always joins this same attempt instead of starting
    // its own. Clearing on failure too means a subsequent call retries rather than replaying
    // a cached rejection forever.
    if (inFlightSignIn === signInPromise) inFlightSignIn = null
  }
}

// Used immediately before any ownership-sensitive Firestore write (joinRoom, createRoom).
// `candidateUid` is whatever uid the caller currently has in hand (e.g. from React state); it
// is never trusted as ownership proof by itself. If it already matches the live
// auth.currentUser, it's confirmed and returned as-is with no extra work. Otherwise — stale
// state, or no session established yet — this refreshes through ensureAnonymousUser and
// returns the authoritative uid instead of proceeding with the stale candidate.
export const resolveOwnerUid = async (auth: Auth, candidateUid: string): Promise<string> => {
  if (auth.currentUser && auth.currentUser.uid === candidateUid) return candidateUid
  const user = await ensureAnonymousUser(auth)
  return user.uid
}

// Test-only: resets the module-level in-flight cache between test cases. Never called from
// application code.
export const __resetEnsureAnonymousUserForTests = (): void => {
  inFlightSignIn = null
}
