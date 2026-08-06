import { describe, expect, it } from 'vitest'
import { friendlyError, resolveJoinPermissionDeniedMessage } from './gameService'

describe('friendlyError', () => {
  it('preserves messages intended for the user', () => {
    expect(friendlyError(new Error('ผู้ใช้:ชื่อกลุ่มนี้ถูกใช้แล้ว'))).toBe('ชื่อกลุ่มนี้ถูกใช้แล้ว')
  })

  it('distinguishes auth limits, network failures, and permission failures', () => {
    expect(friendlyError({ code: 'auth/too-many-requests' })).toContain('ผู้เข้าใช้งานพร้อมกัน')
    expect(friendlyError({ code: 'unavailable' })).toContain('อินเทอร์เน็ต')
    expect(friendlyError({ code: 'permission-denied' })).toContain('เซสชัน')
  })
})

describe('resolveJoinPermissionDeniedMessage', () => {
  // FirebaseGameService.joinRoom hits Firestore permission-denied when a genuinely new
  // player's deterministic doc get is blocked by security rules — most commonly because the
  // room's teamsLocked flipped true. This resolver decides the friendly message from a
  // re-read of the room, and must never fabricate a duplicate-student-number claim: that
  // message can only ever come from the transaction's own explicit ownerUid-mismatch branch.
  it('reports the locked-team message when the re-read room is actually locked', () => {
    expect(resolveJoinPermissionDeniedMessage({ teamsLocked: true })).toBe('ผู้ใช้:ทีมถูกล็อกแล้ว กรุณาติดต่อครู')
  })

  it('returns null (rethrow the original Firebase error) when the room is not locked', () => {
    expect(resolveJoinPermissionDeniedMessage({ teamsLocked: false })).toBeNull()
  })

  it('returns null when the room could not be re-read at all', () => {
    expect(resolveJoinPermissionDeniedMessage(null)).toBeNull()
  })

  it('never returns the duplicate-student-number message under any room state', () => {
    expect(resolveJoinPermissionDeniedMessage({ teamsLocked: true })).not.toContain('เลขที่นักเรียนนี้ถูกใช้แล้ว')
    expect(resolveJoinPermissionDeniedMessage({ teamsLocked: false })).toBeNull()
    expect(resolveJoinPermissionDeniedMessage(null)).toBeNull()
  })
})
