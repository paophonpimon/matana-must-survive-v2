import { describe, expect, it } from 'vitest'
import { friendlyError } from './gameService'

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
