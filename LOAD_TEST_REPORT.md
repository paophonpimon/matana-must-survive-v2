# รายงาน Load Test นักเรียนพร้อมกัน 40 คน

ทดสอบเมื่อ: **16 กรกฎาคม 2026 เวลา 02:04:49 น. (UTC+7)**  
เป้าหมาย: Firebase production project `matana-must-survive`  
เครื่องมือ: Firebase Web SDK clients จำลองจาก Node.js โดยไม่ใช้ browser automation

## สรุปผล

**ผ่านสำหรับ workload ที่ทดสอบ: 40/40 clients สำเร็จทุกขั้นตอน ไม่มี error**

ผลนี้ยืนยันว่า production Authentication, Firestore Rules, concurrent writes และ realtime listeners รองรับนักเรียนจำลอง 40 คนพร้อมกันใน flow สำคัญที่ทดสอบ อย่างไรก็ตามยังไม่แทนการทดสอบมือถือจริง 40 เครื่องบน Wi-Fi โรงเรียนและการเล่นครบ 10 ข้อ

## Scenario ที่ทดสอบ

1. สร้างห้องทดสอบแยกจากห้องใช้งานจริง
2. Anonymous Authentication พร้อมกัน 40 clients
3. Join ห้องและสร้าง team documents พร้อมกัน 40 กลุ่ม
4. เปิด room + team realtime listener ของแต่ละ client
5. ครูเริ่มเกมและทุก client รับสถานะ `playing`
6. ส่งคำตอบพร้อมกัน 40 กลุ่มผ่าน Firestore transaction
7. แก้คำตอบพร้อมกัน 40 กลุ่มก่อน deadline
8. ครูรับ team collection snapshot และตรวจผลรวม
9. ตรวจว่าแต่ละทีมเหลือ AnswerRecord เพียง 1 รายการและใช้คำตอบล่าสุด
10. ปิดห้อง ลบบัญชีทดสอบ และลบ room/team documents ทดสอบ

## ผลการวัด

| ขั้นตอน | สำเร็จ | ล้มเหลว | p50 | p95 | สูงสุด | เวลารวมของ phase |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Anonymous Auth | 40 | 0 | 899.5 ms | 1,230.1 ms | 1,837.2 ms | 1,837.7 ms |
| Join Room | 40 | 0 | 901.2 ms | 959.6 ms | 1,032.5 ms | 1,035.6 ms |
| Realtime Start | 40 | 0 | — | — | — | 160.1 ms |
| Submit Answer | 40 | 0 | 277.6 ms | 398.5 ms | 408.6 ms | 409.0 ms |
| Edit Answer | 40 | 0 | 73.6 ms | 98.4 ms | 104.9 ms | 105.1 ms |

Final verification:

- จำนวนทีม: 40
- ทุกทีมมีคำตอบเพียง 1 record: ผ่าน
- ทุกทีมใช้คำตอบล่าสุดหลังแก้: ผ่าน
- Authentication errors: 0
- Firestore permission errors: 0
- Transaction errors: 0
- Realtime timeout: 0

## Cleanup

- ห้องทดสอบ: `LG5YHL`
- ตั้งห้องเป็น closed หลังจบ
- ลบบัญชี Anonymous ที่สคริปต์สร้างแบบทยอยเป็นชุด
- ลบ `rooms/LG5YHL` และ subcollections ผ่าน Firebase CLI สำเร็จ (exit code 0)

## ข้อจำกัดของผลทดสอบ

- เป็น 40 SDK clients จากเครื่อง/เครือข่ายเดียว ไม่ใช่มือถือจริง 40 เครื่อง
- ทดสอบจุดโหลดสูงสุดของ flow หนึ่งข้อ ไม่ใช่ soak test เล่นครบ 10 ข้อต่อเนื่อง
- ยังไม่จำลอง Wi-Fi ช้า, packet loss, เครื่อง sleep, browser background throttling หรือการหลุดแล้ว reconnect
- ไม่ได้วัด frame rate, responsive rendering หรือความร้อน/แบตเตอรี่บนอุปกรณ์นักเรียน
- Firebase Authentication จำกัดการสร้างบัญชีใหม่ต่อ IP; ไม่ควรรัน load test ซ้ำหลายรอบติดกันภายในหนึ่งชั่วโมง
- Firestore free tier มีโควตาอ่าน/เขียนรายวัน การรัน load test ซ้ำจะใช้โควตาของโปรเจกต์จริง

## ข้อสรุปก่อนเข้าชั้นเรียน

จาก backend workload ที่ทดสอบ **40 คนพร้อมกันมีแนวโน้มใช้งานได้** และ latency อยู่ในระดับเหมาะกับเกมจับเวลา แต่ก่อนยืนยันใช้งานจริงควรทำ rehearsal อย่างน้อย 10–15 เครื่องบน Wi-Fi ห้องเรียน เล่น 10 ข้อครบหนึ่งรอบ และให้เครื่องครูเปิดหน้าจอตลอดรอบ หาก rehearsal ไม่มี permission error/realtime timeout จึงค่อยเปิดใช้กับ 40 คน

## รันทดสอบซ้ำ

```bash
npm run loadtest:40
```

สคริปต์: `scripts/load-test-40.mjs`

คำเตือน: รออย่างน้อยหนึ่งชั่วโมงก่อนรันทดสอบซ้ำเพื่อหลีกเลี่ยง Firebase Auth account-creation throttling และตรวจ Usage ใน Firebase Console ก่อนทุกครั้ง

