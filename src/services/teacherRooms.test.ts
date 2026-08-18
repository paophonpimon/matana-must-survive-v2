import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { distinctStudentCount, summarizeRoundHistory } from '../lib/roomHistory'
import type { RoundHistoryEntry } from '../types/game'
import { DemoGameService } from './demoService'

// Ownership scoping for the read-only room-history screen. The Firebase path enforces the same
// rule twice — a where('teacherSessionId','==',uid) query plus a firestore.rules `list` clause
// that rejects any query NOT so constrained — and this pins the service-level contract both
// implementations share.

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

describe('listTeacherRooms', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns only the calling teacher’s own rooms, newest first', async () => {
    const service = new DemoGameService()
    const mine1 = await service.createRoom('teacher-A')
    const theirs = await service.createRoom('teacher-B')
    const mine2 = await service.createRoom('teacher-A')

    const rooms = await service.listTeacherRooms('teacher-A')
    const codes = rooms.map((room) => room.roomCode)
    expect(codes).toContain(mine1.roomCode)
    expect(codes).toContain(mine2.roomCode)
    // Another teacher's room must never appear.
    expect(codes).not.toContain(theirs.roomCode)

    // Newest first.
    const timestamps = rooms.map((room) => room.createdAt)
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps)

    // And the other teacher sees only their own.
    expect((await service.listTeacherRooms('teacher-B')).map((room) => room.roomCode)).toEqual([theirs.roomCode])
  })

  it('carries only room-document fields — nothing derived from roundHistory', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-A')
    const [summary] = await service.listTeacherRooms('teacher-A')
    expect(summary).toEqual({
      roomCode: room.roomCode,
      createdAt: expect.any(Number),
      status: 'waiting',
    })
    // Pinning the exact key set is the point: any student/round count reappearing here would mean
    // the list is reading every room's history subcollection again.
    expect(Object.keys(summary).sort()).toEqual(['createdAt', 'roomCode', 'status'])
  })

  it('stays room-document-only even for a room that has recorded history', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-A')
    const code = room.roomCode
    await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')
    await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')
    // closeRoom snapshots the round, which is what a history record is.
    await service.closeRoom(code, 'teacher-A')

    const [summary] = await service.listTeacherRooms('teacher-A')
    expect(summary.status).toBe('closed')
    expect(Object.keys(summary).sort()).toEqual(['createdAt', 'roomCode', 'status'])

    // The counts the list no longer carries are still available once the room is opened, derived
    // from that room's own history — the single load the opened-room screen performs.
    const entries = await new Promise<RoundHistoryEntry[]>((resolve) => {
      const stop = service.subscribeRoundHistory(code, (value) => {
        if (value.length > 0) { stop(); resolve(value) }
      })
    })
    expect(summarizeRoundHistory(entries)).toHaveLength(1)
    expect(distinctStudentCount(entries)).toBe(2)
  })

  it('returns nothing for a teacher session that owns no rooms', async () => {
    const service = new DemoGameService()
    await service.createRoom('teacher-A')
    expect(await service.listTeacherRooms('teacher-unknown')).toEqual([])
  })
})
