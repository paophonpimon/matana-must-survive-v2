import { Link } from 'react-router-dom'
import { ScenePage } from '../components/Layout'

export const HomePage = () => (
  <ScenePage image="/images/hero-curse.png" imageAlt="ดอกกุหลาบต้องคำสาปท่ามกลางป่ารัตติกาล" imagePosition="50% 58%">
    <div className="home-shell mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
      <div className="home-ornament flex items-center justify-between text-[#eed7a2]">
        <span className="ornament-line" aria-hidden="true">✦</span>
        <p className="text-sm tracking-[0.22em]">วรรณคดีไทย · มัธยมศึกษาปีที่ ๕</p>
        <span className="ornament-line" aria-hidden="true">✦</span>
      </div>
      <section className="home-content">
        <div className="home-title-block">
          <p className="eyebrow">ภารกิจแห่งรัตติกาล</p>
          <h1 className="hero-title mt-3">มัทนา<br /><span>ต้องรอด</span></h1>
        </div>
        <div className="home-action-block">
          <p className="max-w-xl text-lg leading-relaxed text-[#eee5d7] sm:text-xl">
          ภารกิจคลายคำสาปจากวรรณคดีเรื่อง <strong className="font-medium text-[#f1ce7b]">มัทนะพาธา</strong>
          </p>
          <div className="mt-7 grid max-w-xl gap-3 sm:grid-cols-2">
            <Link className="primary-button" to="/teacher"><span>สำหรับครู</span><span aria-hidden="true">→</span></Link>
            <Link className="secondary-button" to="/join"><span>สำหรับผู้เรียน</span><span aria-hidden="true">→</span></Link>
          </div>
          <p className="mt-5 text-sm text-[#bdb5ac]">หนึ่งห้อง · สิบคำถาม · ทุกกลุ่มใช้เวลาเท่ากันและสรุปคะแนนพร้อมกันเมื่อจบรอบ</p>
        </div>
      </section>
    </div>
  </ScenePage>
)
