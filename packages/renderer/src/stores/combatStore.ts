import { create } from 'zustand'

const MAX_ENTRIES = 120

export interface CombatLogEntry {
  id: string
  message: string
  timestamp: number
}

interface CombatState {
  logs: CombatLogEntry[]
  appendLog: (message: string) => void
  clearLogs: () => void
}

export const useCombatStore = create<CombatState>()((set) => ({
  logs: [],

  appendLog: (message) => {
    set((state) => ({
      logs: [...state.logs, { id: crypto.randomUUID(), message, timestamp: Date.now() }].slice(
        -MAX_ENTRIES
      )
    }))
  },

  clearLogs: () => set({ logs: [] })
}))
