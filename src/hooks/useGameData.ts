import { useEffect, useState } from 'react'
import { useGame } from '../context/GameContext'
import type { Player, Room } from '../types/game'

interface Loadable<T> {
  data: T
  loading: boolean
  error: string
}

export const useRoom = (roomCode: string): Loadable<Room | null> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Room | null>>({ data: null, loading: true, error: '' })

  useEffect(() => {
    if (!roomCode) {
      setState({ data: null, loading: false, error: '' })
      return
    }
    setState({ data: null, loading: true, error: '' })
    return service.subscribeRoom(
      roomCode,
      (room) => setState({ data: room, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service])

  return state
}

export const usePlayers = (roomCode: string): Loadable<Player[]> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Player[]>>({ data: [], loading: true, error: '' })

  useEffect(() => {
    if (!roomCode) {
      setState({ data: [], loading: false, error: '' })
      return
    }
    setState({ data: [], loading: true, error: '' })
    return service.subscribePlayers(
      roomCode,
      (players) => setState({ data: players, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service])

  return state
}

export const usePlayer = (roomCode: string, playerId: string): Loadable<Player | null> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Player | null>>({ data: null, loading: true, error: '' })

  useEffect(() => {
    if (!roomCode || !playerId) {
      setState({ data: null, loading: false, error: '' })
      return
    }
    setState({ data: null, loading: true, error: '' })
    return service.subscribePlayer(
      roomCode,
      playerId,
      (player) => setState({ data: player, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service, playerId])

  return state
}
