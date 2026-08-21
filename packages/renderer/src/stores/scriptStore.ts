import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { SCRIPT_LIMITS } from '@dofemu/shared'
import type { AutomationScript, ScriptLogEntry, ScriptLogLevel, ScriptRun } from '@dofemu/shared'
import { electronStorage } from './electronStorage'

interface ScriptState {
  scripts: AutomationScript[]
  selectedScriptId: string | null
  runs: Record<string, ScriptRun>
  logs: ScriptLogEntry[]

  createScript: (script: Omit<AutomationScript, 'id'>) => string
  updateScript: (id: string, patch: Partial<Omit<AutomationScript, 'id' | 'createdAt'>>) => void
  deleteScript: (id: string) => void
  duplicateScript: (id: string) => string | null
  selectScript: (id: string | null) => void

  importScripts: (raw: string) => number
  exportScripts: () => string

  setRun: (run: ScriptRun) => void
  clearFinishedRuns: () => void
  appendLog: (entry: Omit<ScriptLogEntry, 'id'>) => void
  clearLogs: (scriptId?: string) => void

  getScript: (id: string) => AutomationScript | undefined
  getRunsForScript: (id: string) => ScriptRun[]
  getActiveRuns: () => ScriptRun[]
}

function sanitize(script: Partial<AutomationScript>, now: number): Omit<AutomationScript, 'id'> {
  return {
    name: typeof script.name === 'string' && script.name.trim() ? script.name.trim() : 'New script',
    description: typeof script.description === 'string' ? script.description : '',
    source: typeof script.source === 'string' ? script.source : '',
    target: script.target ?? 'active-tab',
    loop: script.loop === true,
    loopDelayMs: Math.min(
      SCRIPT_LIMITS.maxLoopDelayMs,
      Math.max(SCRIPT_LIMITS.minLoopDelayMs, Number(script.loopDelayMs) || 0)
    ),
    createdAt: Number(script.createdAt) || now,
    updatedAt: now
  }
}

export const useScriptStore = create<ScriptState>()(
  persist(
    (set, get) => ({
      scripts: [],
      selectedScriptId: null,
      runs: {},
      logs: [],

      createScript: (script) => {
        const id = crypto.randomUUID()
        const created: AutomationScript = { ...sanitize(script, Date.now()), id }
        set((state) => ({ scripts: [...state.scripts, created], selectedScriptId: id }))
        return id
      },

      updateScript: (id, patch) => {
        set((state) => ({
          scripts: state.scripts.map((script) =>
            script.id === id ? { ...script, ...patch, updatedAt: Date.now() } : script
          )
        }))
      },

      deleteScript: (id) => {
        set((state) => ({
          scripts: state.scripts.filter((script) => script.id !== id),
          selectedScriptId: state.selectedScriptId === id ? null : state.selectedScriptId,
          logs: state.logs.filter((entry) => entry.scriptId !== id)
        }))
      },

      duplicateScript: (id) => {
        const source = get().scripts.find((script) => script.id === id)
        if (!source) return null
        return get().createScript({ ...source, name: `${source.name} (Copy)` })
      },

      selectScript: (id) => set({ selectedScriptId: id }),

      importScripts: (raw) => {
        const parsed: unknown = JSON.parse(raw)
        const list = Array.isArray(parsed) ? parsed : [parsed]
        const now = Date.now()
        const imported = list
          .filter((item): item is Partial<AutomationScript> => !!item && typeof item === 'object')
          .map((item) => ({ ...sanitize(item, now), id: crypto.randomUUID() }))

        if (imported.length === 0) return 0
        set((state) => ({
          scripts: [...state.scripts, ...imported],
          selectedScriptId: imported[0].id
        }))
        return imported.length
      },

      exportScripts: () => {
        const scripts = get().scripts.map(({ id: _id, ...script }) => script)
        return JSON.stringify(scripts, null, 2)
      },

      setRun: (run) => {
        set((state) => ({ runs: { ...state.runs, [run.id]: run } }))
      },

      clearFinishedRuns: () => {
        set((state) => ({
          runs: Object.fromEntries(
            Object.entries(state.runs).filter(([, run]) => run.status === 'running' || run.status === 'stopping')
          )
        }))
      },

      appendLog: (entry) => {
        set((state) => {
          const logs = [...state.logs, { ...entry, id: crypto.randomUUID() }]
          return { logs: logs.slice(-SCRIPT_LIMITS.maxLogEntries) }
        })
      },

      clearLogs: (scriptId) => {
        set((state) => ({
          logs: scriptId ? state.logs.filter((entry) => entry.scriptId !== scriptId) : []
        }))
      },

      getScript: (id) => get().scripts.find((script) => script.id === id),

      getRunsForScript: (id) =>
        Object.values(get().runs).filter((run) => run.scriptId === id),

      getActiveRuns: () =>
        Object.values(get().runs).filter(
          (run) => run.status === 'running' || run.status === 'stopping'
        )
    }),
    {
      name: 'dofemu-scripts',
      storage: createJSONStorage(() => electronStorage),
      partialize: (state) => ({
        scripts: state.scripts,
        selectedScriptId: state.selectedScriptId
      })
    }
  )
)

export function logLevelColor(level: ScriptLogLevel): string {
  if (level === 'error') return '#f44'
  if (level === 'warn') return '#d9a441'
  return '#888'
}
