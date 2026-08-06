import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPlayerSession,
  clearTeacherSession,
  getPlayerSession,
  getTeacherSession,
  savePlayerSession,
  saveTeacherSession,
} from './sessionStorage'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const playerSession = { roomCode: 'ABCDEF', playerId: 'player-1', displayName: 'Alpha', studentNumber: '01', role: 'student' as const }
const teacherSession = { teacherSessionId: 'teacher-uid-1', roomCode: 'ABCDEF', role: 'teacher' as const }

describe('sessionStorage service', () => {
  let activeSessionStorage: MemoryStorage
  let activeLocalStorage: MemoryStorage

  beforeEach(() => {
    activeSessionStorage = new MemoryStorage()
    activeLocalStorage = new MemoryStorage()
    vi.stubGlobal('sessionStorage', activeSessionStorage)
    vi.stubGlobal('localStorage', activeLocalStorage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips a player session through window.sessionStorage', () => {
    expect(getPlayerSession()).toBeNull()
    savePlayerSession(playerSession)
    expect(getPlayerSession()).toEqual(playerSession)
    clearPlayerSession()
    expect(getPlayerSession()).toBeNull()
  })

  it('round-trips a teacher session through window.sessionStorage', () => {
    expect(getTeacherSession()).toBeNull()
    saveTeacherSession(teacherSession)
    expect(getTeacherSession()).toEqual(teacherSession)
    clearTeacherSession()
    expect(getTeacherSession()).toBeNull()
  })

  // Milestone 2.2 core fix: this module used to write to localStorage despite being named
  // "sessionStorage" — that's what made a teacher tab and a student tab in the same browser
  // silently share one active session. Asserting localStorage is never touched is the direct
  // regression test for that bug.
  it('never writes to localStorage — only sessionStorage', () => {
    savePlayerSession(playerSession)
    saveTeacherSession(teacherSession)

    expect(activeLocalStorage.length).toBe(0)
    expect(activeSessionStorage.length).toBe(2)
  })

  it('reloading the same tab (same sessionStorage instance) preserves the session', () => {
    savePlayerSession(playerSession)
    // Simulate a reload: nothing re-stubs sessionStorage, the same backing store is reused.
    expect(getPlayerSession()).toEqual(playerSession)
  })

  // Simulates two independently-opened tabs: each has its own sessionStorage instance (real
  // browser behavior — sessionStorage is never shared across tabs, even same-origin ones).
  it('two independent tabs (two separate sessionStorage instances) never see each other\'s session', () => {
    savePlayerSession(playerSession)
    expect(getPlayerSession()).toEqual(playerSession)

    // Switch to a second tab's sessionStorage — brand new, empty store.
    const secondTabStorage = new MemoryStorage()
    vi.stubGlobal('sessionStorage', secondTabStorage)
    expect(getPlayerSession()).toBeNull()

    saveTeacherSession(teacherSession)
    expect(getTeacherSession()).toEqual(teacherSession)
    expect(getPlayerSession()).toBeNull() // the second tab's teacher session, not the first tab's player session

    // Switching back to the first tab's store shows its own session, untouched by the second.
    vi.stubGlobal('sessionStorage', activeSessionStorage)
    expect(getPlayerSession()).toEqual(playerSession)
    expect(getTeacherSession()).toBeNull()
  })

  it('safely returns null instead of throwing on corrupted stored JSON', () => {
    activeSessionStorage.setItem('matana_player_session', '{not valid json')
    expect(getPlayerSession()).toBeNull()
  })
})
