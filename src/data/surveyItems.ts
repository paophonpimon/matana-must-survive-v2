// End-of-activity survey ("แบบประเมินกิจกรรม").
//
// Opinion only: there is no correct answer, no score, and nothing here feeds knowledge scoring,
// team score, ranking, magic or the boss. SurveyResponseRecord deliberately has no isCorrect
// field, so there is nothing for a scoring path to read even by mistake.
//
// Fixed order, presented one item at a time. The 5-point scale is shared by every item.

export interface SurveyItem {
  id: string
  statement: string
}

export interface SurveyScaleOption {
  value: string
  label: string
}

export const SURVEY_ITEMS: SurveyItem[] = [
  { id: 'survey-01', statement: 'เกมนี้ทำให้ฉันสนใจเรียนเรื่อง “มัทนะพาธา” มากขึ้น' },
  { id: 'survey-02', statement: 'การตอบคำถามด้วยตนเองทำให้ฉันมีส่วนร่วมกับกิจกรรมมากขึ้น' },
  { id: 'survey-03', statement: 'การแข่งขันเป็นทีมทำให้ฉันตั้งใจตอบคำถามมากขึ้น' },
  { id: 'survey-04', statement: 'กิจกรรมนี้ช่วยให้ฉันเข้าใจเรื่อง “มัทนะพาธา” มากขึ้น' },
  { id: 'survey-05', statement: 'ระบบใช้งานง่ายและขั้นตอนไม่ซับซ้อน' },
  { id: 'survey-06', statement: 'ฉันอยากเรียนวรรณคดีเรื่องอื่นด้วยรูปแบบใกล้เคียงกัน' },
]

// Stored as the digit string, so the persisted value is the scale point itself rather than an
// index that would silently change meaning if the labels were ever reordered.
export const SURVEY_SCALE: SurveyScaleOption[] = [
  { value: '1', label: 'ไม่เห็นด้วยอย่างยิ่ง' },
  { value: '2', label: 'ไม่เห็นด้วย' },
  { value: '3', label: 'ปานกลาง' },
  { value: '4', label: 'เห็นด้วย' },
  { value: '5', label: 'เห็นด้วยอย่างยิ่ง' },
]

export const SURVEY_ITEM_COUNT = SURVEY_ITEMS.length

export const surveyItemsById = new Map(SURVEY_ITEMS.map((item) => [item.id, item]))

// The only accepted values. Used by both services to reject anything outside the scale, so a
// crafted client cannot store an arbitrary value.
export const isValidSurveyValue = (value: string): boolean => SURVEY_SCALE.some((option) => option.value === value)
