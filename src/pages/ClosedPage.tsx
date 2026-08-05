import { Link, useParams } from 'react-router-dom'
import { BrandHeader, ScenePage } from '../components/Layout'

export const ClosedPage = () => {
  const { roomCode = '' } = useParams()
  return (
    <ScenePage>
      <BrandHeader />
      <div className="mx-auto flex w-full max-w-3xl flex-1 items-center px-5 py-8 sm:px-8">
        <section className="glass-panel w-full p-7 text-center sm:p-10">
          <div className="closed-seal mx-auto" aria-hidden="true">ปิด</div>
          <p className="eyebrow mt-5">ห้อง {roomCode.toUpperCase()}</p>
          <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">ห้องกิจกรรมสิ้นสุดแล้ว</h1>
          <p className="mt-4 text-lg text-[#d8d1c5]">ขอบคุณที่ร่วมภารกิจมัทนาต้องรอด</p>
          <Link className="primary-button mx-auto mt-7 w-full max-w-sm" to="/">กลับหน้าแรก</Link>
        </section>
      </div>
    </ScenePage>
  )
}
