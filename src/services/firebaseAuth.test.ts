import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auth, User } from 'firebase/auth'

const signInAnonymouslyMock = vi.fn()
const setPersistenceMock = vi.fn()

vi.mock('firebase/auth', () => ({
  signInAnonymously: (...args: unknown[]) => signInAnonymouslyMock(...args),
  setPersistence: (...args: unknown[]) => setPersistenceMock(...args),
  browserSessionPersistence: 'browserSessionPersistence-sentinel',
}))

const makeUser = (uid: string): User => ({ uid }) as User

// A minimal fake Auth: only `currentUser` is read by ensureAnonymousUser/resolveOwnerUid.
const makeAuth = (currentUser: User | null = null): Auth => ({ currentUser }) as Auth

describe('ensureAnonymousUser', () => {
  beforeEach(async () => {
    signInAnonymouslyMock.mockReset()
    setPersistenceMock.mockReset()
    setPersistenceMock.mockResolvedValue(undefined)
    const { __resetEnsureAnonymousUserForTests } = await import('./firebaseAuth')
    __resetEnsureAnonymousUserForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns auth.currentUser immediately and never calls signInAnonymously when a session already exists', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(makeUser('existing-uid'))

    const user = await ensureAnonymousUser(auth)

    expect(user.uid).toBe('existing-uid')
    expect(signInAnonymouslyMock).not.toHaveBeenCalled()
  })

  // Milestone 2.2: each tab must get its own anonymous uid, not the one Firebase's default
  // (cross-tab) persistence would otherwise auto-restore.
  it('sets browserSessionPersistence before ever calling signInAnonymously', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(null)
    const callOrder: string[] = []
    setPersistenceMock.mockImplementation(async () => { callOrder.push('setPersistence') })
    signInAnonymouslyMock.mockImplementation(async () => { callOrder.push('signInAnonymously'); return { user: makeUser('fresh-uid') } })

    await ensureAnonymousUser(auth)

    expect(setPersistenceMock).toHaveBeenCalledWith(auth, 'browserSessionPersistence-sentinel')
    expect(callOrder).toEqual(['setPersistence', 'signInAnonymously'])
  })

  // Persistence must be applied even when a currentUser is already present — a stale
  // auth.currentUser could itself be a value the SDK auto-restored under the OLD (shared)
  // persistence, before this tab ever got a chance to switch it, so skipping the persistence
  // call here would leave that leak unaddressed on every subsequent call too.
  it('sets browserSessionPersistence even when auth.currentUser is already populated', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(makeUser('existing-uid'))

    await ensureAnonymousUser(auth)

    expect(setPersistenceMock).toHaveBeenCalledWith(auth, 'browserSessionPersistence-sentinel')
  })

  it('only requests persistence once across repeated calls, not once per call', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(makeUser('existing-uid'))

    await ensureAnonymousUser(auth)
    await ensureAnonymousUser(auth)
    await ensureAnonymousUser(auth)

    expect(setPersistenceMock).toHaveBeenCalledTimes(1)
  })

  it('invokes signInAnonymously exactly once for two concurrent calls on a fresh profile', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(null)
    let resolveSignIn: (value: { user: User }) => void = () => {}
    signInAnonymouslyMock.mockReturnValue(new Promise((resolve) => { resolveSignIn = resolve }))

    // Simulates two effect invocations racing (e.g. React StrictMode's double-invoke) before
    // either has a chance to observe the other's in-flight promise.
    const first = ensureAnonymousUser(auth)
    const second = ensureAnonymousUser(auth)
    resolveSignIn({ user: makeUser('fresh-uid') })
    const [firstUser, secondUser] = await Promise.all([first, second])

    expect(signInAnonymouslyMock).toHaveBeenCalledTimes(1)
    expect(firstUser.uid).toBe('fresh-uid')
    expect(secondUser).toBe(firstUser)
  })

  it('reuses the same in-flight promise across repeated React-style re-initialization', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(null)
    let resolveSignIn: (value: { user: User }) => void = () => {}
    signInAnonymouslyMock.mockReturnValue(new Promise((resolve) => { resolveSignIn = resolve }))

    const calls = [ensureAnonymousUser(auth), ensureAnonymousUser(auth), ensureAnonymousUser(auth)]
    resolveSignIn({ user: makeUser('shared-uid') })
    const results = await Promise.all(calls)

    expect(signInAnonymouslyMock).toHaveBeenCalledTimes(1)
    expect(new Set(results.map((user) => user.uid))).toEqual(new Set(['shared-uid']))
  })

  it('never starts a sign-in merely because a caller "unmounted" (a later call after settling reuses auth.currentUser, not a new sign-in)', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(null)
    signInAnonymouslyMock.mockResolvedValue({ user: makeUser('settled-uid') })

    await ensureAnonymousUser(auth)
    // Simulate the SDK persisting the session: auth.currentUser is now set, as it would be
    // after a real signInAnonymously call.
    ;(auth as { currentUser: User | null }).currentUser = makeUser('settled-uid')

    const second = await ensureAnonymousUser(auth)

    expect(second.uid).toBe('settled-uid')
    expect(signInAnonymouslyMock).toHaveBeenCalledTimes(1)
  })

  it('rejects clearly on sign-in failure, and a subsequent call retries instead of replaying the cached rejection', async () => {
    const { ensureAnonymousUser } = await import('./firebaseAuth')
    const auth = makeAuth(null)
    signInAnonymouslyMock.mockRejectedValueOnce(new Error('network-request-failed'))
    signInAnonymouslyMock.mockResolvedValueOnce({ user: makeUser('retry-uid') })

    await expect(ensureAnonymousUser(auth)).rejects.toThrow('network-request-failed')
    expect(signInAnonymouslyMock).toHaveBeenCalledTimes(1)

    const retried = await ensureAnonymousUser(auth)
    expect(retried.uid).toBe('retry-uid')
    expect(signInAnonymouslyMock).toHaveBeenCalledTimes(2)
  })
})

describe('resolveOwnerUid', () => {
  beforeEach(async () => {
    signInAnonymouslyMock.mockReset()
    setPersistenceMock.mockReset()
    setPersistenceMock.mockResolvedValue(undefined)
    const { __resetEnsureAnonymousUserForTests } = await import('./firebaseAuth')
    __resetEnsureAnonymousUserForTests()
  })

  it('returns the candidate uid unchanged when it already matches the live auth.currentUser', async () => {
    const { resolveOwnerUid } = await import('./firebaseAuth')
    const auth = makeAuth(makeUser('matching-uid'))

    await expect(resolveOwnerUid(auth, 'matching-uid')).resolves.toBe('matching-uid')
    expect(signInAnonymouslyMock).not.toHaveBeenCalled()
  })

  it('never returns a stale candidate uid — resolves to the true live auth uid on mismatch (joinRoom/createRoom must not write a stale ownerUid)', async () => {
    const { resolveOwnerUid } = await import('./firebaseAuth')
    const auth = makeAuth(makeUser('true-live-uid'))

    const resolved = await resolveOwnerUid(auth, 'stale-cached-uid')

    expect(resolved).toBe('true-live-uid')
    expect(resolved).not.toBe('stale-cached-uid')
    // Already signed in under a different uid than the stale candidate, so no new sign-in is
    // needed — the mismatch is resolved purely from the live auth state.
    expect(signInAnonymouslyMock).not.toHaveBeenCalled()
  })

  it('signs in and resolves to the fresh uid when there is no session at all yet', async () => {
    const { resolveOwnerUid } = await import('./firebaseAuth')
    const auth = makeAuth(null)
    signInAnonymouslyMock.mockResolvedValue({ user: makeUser('newly-signed-in-uid') })

    const resolved = await resolveOwnerUid(auth, 'candidate-from-stale-react-state')

    expect(resolved).toBe('newly-signed-in-uid')
    expect(signInAnonymouslyMock).toHaveBeenCalledTimes(1)
  })
})
