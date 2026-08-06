import { describe, expect, it } from 'vitest'
import { questions, questionsById } from '../data/questions'
import {
  ROUND_CATEGORY_COUNTS,
  calculateScore,
  evaluateChoice,
  generateRoomCode,
  resolveStudentRoute,
  resolveTeacherRoomSession,
  selectRoundQuestions,
  validateJoinInput,
} from './game'
import type { Player, Room, TeacherSession } from '../types/game'

describe('การสุ่มคำถาม', () => {
  it('ได้ 10 ข้อ ไม่มีรหัสซ้ำ และได้สัดส่วนหมวดถูกต้อง', () => {
    const ids = selectRoundQuestions(questions, [], () => 0.42)
    expect(ids).toHaveLength(10)
    expect(new Set(ids).size).toBe(10)
    const counts = ids.reduce<Record<string, number>>((result, id) => {
      const category = questionsById.get(id)?.category ?? 'missing'
      result[category] = (result[category] ?? 0) + 1
      return result
    }, {})
    expect(counts).toEqual(ROUND_CATEGORY_COUNTS)
  })

  it('ไม่ใช้ทั้งชุดเดิมซ้ำเมื่อยังมีคำถามสำรอง', () => {
    const previous = selectRoundQuestions(questions, [], () => 0.1)
    const next = selectRoundQuestions(questions, previous, () => 0.1)
    expect(new Set(next)).not.toEqual(new Set(previous))
  })
})

describe('คะแนนและเกณฑ์ผ่าน', () => {
  it('คำนวณคะแนนจากคำตอบ', () => {
    expect(calculateScore([{ isCorrect: true }, { isCorrect: false }, { isCorrect: true }])).toBe(2)
  })

  it('เก็บคะแนนตรงตามจำนวนข้อถูกโดยไม่มีเกณฑ์แข่งความเร็ว', () => {
    expect(calculateScore(Array.from({ length: 8 }, () => ({ isCorrect: true })))).toBe(8)
    expect(calculateScore(Array.from({ length: 9 }, () => ({ isCorrect: true })))).toBe(9)
    expect(calculateScore(Array.from({ length: 10 }, () => ({ isCorrect: true })))).toBe(10)
  })

  it('คำนวณความถูกต้องจากคลังคำถาม ไม่รับค่าคะแนนจาก client', () => {
    const question = questions[0]
    expect(evaluateChoice(question, question.correctChoiceId)).toEqual({ valid: true, isCorrect: true })
    const wrongChoice = question.choices.find((choice) => choice.id !== question.correctChoiceId)
    expect(evaluateChoice(question, wrongChoice?.id ?? '')).toEqual({ valid: true, isCorrect: false })
    expect(evaluateChoice(question, 'unknown-choice')).toEqual({ valid: false, isCorrect: false })
  })
})

describe('รหัสห้องและ validation', () => {
  it('สร้างรหัสห้อง 6 ตัวโดยไม่มี O, 0, I, 1, L', () => {
    for (let index = 0; index < 30; index += 1) {
      expect(generateRoomCode(Math.random)).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/)
    }
  })

  it('ตรวจช่องว่าง รูปแบบรหัส และความยาวชื่อ', () => {
    expect(validateJoinInput({ roomCode: '', displayName: ' ', studentNumber: 'ก'.repeat(21) })).toEqual({
      roomCode: 'กรุณากรอกรหัสห้อง',
      displayName: 'กรุณากรอกชื่อผู้เล่น',
      studentNumber: 'เลขที่นักเรียนต้องไม่เกิน 20 ตัวอักษร',
    })
  })

  it('ยอมรับชื่อ 40 ตัวอักษรและเลขที่ 20 ตัวอักษร ปฏิเสธความยาวเกิน', () => {
    expect(validateJoinInput({ roomCode: 'ABC234', displayName: 'ก'.repeat(40), studentNumber: '1'.repeat(20) })).toEqual({})
    expect(validateJoinInput({ roomCode: 'ABC234', displayName: 'ก'.repeat(41), studentNumber: '1'.repeat(21) })).toEqual({
      displayName: 'ชื่อผู้เล่นต้องไม่เกิน 40 ตัวอักษร',
      studentNumber: 'เลขที่นักเรียนต้องไม่เกิน 20 ตัวอักษร',
    })
  })

  it('ปฏิเสธเลขที่นักเรียนว่างเปล่า', () => {
    expect(validateJoinInput({ roomCode: 'ABC234', displayName: 'ชื่อ', studentNumber: '' })).toEqual({
      studentNumber: 'กรุณากรอกเลขที่นักเรียน',
    })
  })
})

describe('resolveTeacherRoomSession', () => {
  it('keeps the stored room when the stored teacherSessionId matches the current stable Firebase uid', () => {
    const stored: TeacherSession = { teacherSessionId: 'uid-current', roomCode: 'ABC234', role: 'teacher' }
    expect(resolveTeacherRoomSession(stored, 'uid-current')).toEqual({ teacherSessionId: 'uid-current', roomCode: 'ABC234' })
  })

  it('discards the stored room (does not treat it as owned) when the stored uid differs from the current uid', () => {
    const stored: TeacherSession = { teacherSessionId: 'uid-from-a-previous-browser-identity', roomCode: 'ABC234', role: 'teacher' }
    expect(resolveTeacherRoomSession(stored, 'uid-current')).toEqual({ teacherSessionId: 'uid-current', roomCode: '' })
  })

  it('a stored session can never override the current uid, even though it carries its own teacherSessionId field', () => {
    const stored: TeacherSession = { teacherSessionId: 'stale-uid', roomCode: 'XYZ999', role: 'teacher' }
    const result = resolveTeacherRoomSession(stored, 'authoritative-uid')
    expect(result.teacherSessionId).toBe('authoritative-uid')
    expect(result.teacherSessionId).not.toBe(stored.teacherSessionId)
  })

  it('falls back to the current uid with no room when nothing is stored yet', () => {
    expect(resolveTeacherRoomSession(null, 'uid-current')).toEqual({ teacherSessionId: 'uid-current', roomCode: '' })
  })
})

describe('route resolver', () => {
  const room = { roomCode: 'ABC234', status: 'playing', winner: null } as Room
  const player = { submitted: false } as Player

  it('พาไปเกม ผลลัพธ์ และหน้าชนะตามสถานะหลัก', () => {
    expect(resolveStudentRoute(room, player)).toBe('/game/ABC234')
    expect(resolveStudentRoute(room, { ...player, submitted: true } as Player)).toBe('/result/ABC234')
    expect(resolveStudentRoute({ ...room, status: 'completed' }, player)).toBe('/result/ABC234')
    expect(resolveStudentRoute({ ...room, winner: { teamId: 'winner' } as Room['winner'] }, player)).toBe('/congratulations/ABC234')
    expect(resolveStudentRoute({ ...room, status: 'waiting' }, player)).toBe('/lobby/ABC234')
    expect(resolveStudentRoute({ ...room, status: 'closed' }, player)).toBe('/closed/ABC234')
  })
})
