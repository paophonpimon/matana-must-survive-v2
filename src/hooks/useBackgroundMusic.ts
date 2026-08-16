import { useCallback, useEffect, useRef, useState } from 'react'

// Teacher-only background music. Deliberately a hook around ONE lazily-created HTMLAudioElement
// held in a ref: the element is never recreated, so React rerenders and phase transitions can't
// restart the track or stack up overlapping instances. Volume/mute mutate that same element
// in place rather than re-mounting anything.
//
// Playback must be kicked off from inside a real user gesture (the teacher's own button click) —
// browsers block programmatic play() otherwise, so `start` is designed to be called directly in a
// click handler rather than from an effect reacting to state.

const BGM_SOURCE = '/audio/matana-bgm.mp3'
const DEFAULT_VOLUME = 0.35
const VOLUME_STEP = 0.1

export interface BackgroundMusicControls {
  /** True once the track has been started for this activity. */
  isPlaying: boolean
  muted: boolean
  /** 0..1 */
  volume: number
  /** Call from a user-gesture handler. Idempotent: a second call never restarts the track. */
  start: () => void
  stop: () => void
  toggleMute: () => void
  volumeUp: () => void
  volumeDown: () => void
}

export const useBackgroundMusic = (): BackgroundMusicControls => {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(DEFAULT_VOLUME)

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const audio = new Audio(BGM_SOURCE)
      // Loop so a long activity never runs out of music.
      audio.loop = true
      audio.preload = 'auto'
      audio.volume = DEFAULT_VOLUME
      audioRef.current = audio
    }
    return audioRef.current
  }, [])

  const start = useCallback((): void => {
    const audio = ensureAudio()
    // Already running: do nothing, so a repeated click can't restart or double up.
    if (!audio.paused) {
      setIsPlaying(true)
      return
    }
    void audio.play()
      .then(() => setIsPlaying(true))
      // A rejected play() means the browser blocked it (no gesture, or the tab is muted at OS
      // level). Swallow it: background music must never break the lesson flow with an error.
      .catch(() => setIsPlaying(false))
  }, [ensureAudio])

  const stop = useCallback((): void => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    setIsPlaying(false)
  }, [])

  const toggleMute = useCallback((): void => {
    setMuted((current) => {
      const next = !current
      if (audioRef.current) audioRef.current.muted = next
      return next
    })
  }, [])

  const applyVolume = useCallback((next: number): void => {
    const clamped = Math.min(1, Math.max(0, Math.round(next * 100) / 100))
    setVolume(clamped)
    if (audioRef.current) audioRef.current.volume = clamped
  }, [])

  const volumeUp = useCallback((): void => applyVolume(volume + VOLUME_STEP), [applyVolume, volume])
  const volumeDown = useCallback((): void => applyVolume(volume - VOLUME_STEP), [applyVolume, volume])

  // Leaving the teacher screen entirely tears the element down — otherwise the track would keep
  // playing invisibly after navigating away. This runs on unmount only, never on rerenders.
  useEffect(() => () => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.src = ''
    audioRef.current = null
  }, [])

  return { isPlaying, muted, volume, start, stop, toggleMute, volumeUp, volumeDown }
}
