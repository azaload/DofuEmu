import { create } from 'zustand'
import type {
  AppSettings,
  Language,
  ProxySettings,
  GameSettings,
  HotkeyAction,
  ScriptSettings,
  CombatSettings,
  CombatSpell,
  DEFAULT_HOTKEYS
} from '@dofemu/shared'

interface HotkeyMap extends Record<HotkeyAction, string> {}

interface SettingsState {
  language: Language
  window: AppSettings['window']
  hotkeys: HotkeyMap
  proxy: ProxySettings
  game: GameSettings
  scripts: ScriptSettings
  combat: CombatSettings
  version: string
  isLoading: boolean
  isHydrated: boolean

  loadSettings: () => Promise<void>
  setLanguage: (lang: Language) => void
  setWindowSettings: (settings: Partial<AppSettings['window']>) => void
  setHotkey: (action: HotkeyAction, combo: string) => void
  resetHotkeys: () => void
  setProxySettings: (settings: Partial<ProxySettings>) => void
  setGameSettings: (settings: Partial<GameSettings>) => void
  setScriptSettings: (settings: Partial<ScriptSettings>) => void
  toggleScripts: () => void
  setCombatSettings: (settings: Partial<CombatSettings>) => void
  toggleCombatAi: () => void
  addComboSpell: (spell: CombatSpell) => void
  removeComboSpell: (index: number) => void
  moveComboSpell: (index: number, direction: -1 | 1) => void
  setResolution: (width: number, height: number) => void
  toggleAudioMute: () => void
  toggleSoundOnFocus: () => void
  toggleAutoGroup: () => void
  toggleAutoInvite: () => void
  toggleNotifications: () => void
}

const defaultHotkeys: HotkeyMap = {
  'switch-tab-1': 'Ctrl+1',
  'switch-tab-2': 'Ctrl+2',
  'switch-tab-3': 'Ctrl+3',
  'switch-tab-4': 'Ctrl+4',
  'switch-tab-5': 'Ctrl+5',
  'new-tab': 'Ctrl+T',
  'close-tab': 'Ctrl+W',
  'toggle-mute': 'Ctrl+M',
  'toggle-notifications': 'Ctrl+Shift+N',
  'next-tab': 'Ctrl+Tab',
  'prev-tab': 'Ctrl+Shift+Tab',
  'zoom-in': 'Ctrl+=',
  'zoom-out': 'Ctrl+-',
  'run-script': 'Ctrl+Shift+R',
  'stop-scripts': 'Ctrl+Shift+X',
  'toggle-combat-ai': 'Ctrl+Shift+F'
}

const defaultState = {
  language: 'en' as Language,
  window: {
    audioMuted: false,
    soundOnFocus: true,
    resolution: { width: 1280, height: 720 }
  },
  hotkeys: { ...defaultHotkeys },
  proxy: {
    enabled: false,
    host: '',
    port: 8080,
    username: '',
    password: '',
    protocol: 'http' as const
  },
  game: {
    autoGroupEnabled: false,
    autoInviteEnabled: true,
    notificationsEnabled: true
  },
  combat: {
    enabled: false,
    combo: [] as CombatSpell[],
    targetStrategy: 'nearest' as const,
    autoReady: true,
    turnStartDelayMs: 700,
    castDelayMs: 900,
    endTurnAfterCombo: true
  },
  scripts: {
    enabled: true,
    humanDelays: true,
    minActionDelayMs: 250,
    maxActionDelayMs: 900,
    stopOnFight: true,
    maxRuntimeMinutes: 120
  },
  version: '0.1.0'
}

function persist(state: SettingsState) {
  try {
    const payload = JSON.stringify({
      language: state.language,
      window: state.window,
      hotkeys: state.hotkeys,
      proxy: state.proxy,
      game: state.game,
      scripts: state.scripts,
      combat: state.combat,
      version: state.version
    })
    window.dofemu.setSettings(payload)
  } catch {}
}

export const useSettingsStore = create<SettingsState>()((set, get) => {
  const mutate = (updater: (s: SettingsState) => Partial<SettingsState>) => {
    set((state) => {
      const patch = updater(state)
      const merged = { ...state, ...patch } as SettingsState
      persist(merged)
      return patch
    })
  }

  return {
    ...defaultState,
    isLoading: false,
    isHydrated: false,

    loadSettings: async () => {
      try {
        const raw = await window.dofemu.getSettings()
        const parsed = JSON.parse(raw)
        set({
          language: parsed.language ?? defaultState.language,
          window: { ...defaultState.window, ...parsed.window },
          hotkeys: { ...defaultHotkeys, ...parsed.hotkeys },
          proxy: { ...defaultState.proxy, ...parsed.proxy },
          game: { ...defaultState.game, ...parsed.game },
          scripts: { ...defaultState.scripts, ...parsed.scripts },
          combat: { ...defaultState.combat, ...parsed.combat },
          version: parsed.version ?? defaultState.version,
          isHydrated: true
        })
      } catch {
        set({ isHydrated: true })
      }
    },

    setLanguage: (lang) => mutate(() => ({ language: lang })),

    setWindowSettings: (settings) =>
      mutate((s) => ({ window: { ...s.window, ...settings } })),

    setHotkey: (action, combo) =>
      mutate((s) => ({ hotkeys: { ...s.hotkeys, [action]: combo } })),

    resetHotkeys: () => mutate(() => ({ hotkeys: { ...defaultHotkeys } })),

    setProxySettings: (settings) =>
      mutate((s) => ({ proxy: { ...s.proxy, ...settings } })),

    setGameSettings: (settings) =>
      mutate((s) => ({ game: { ...s.game, ...settings } })),

    setScriptSettings: (settings) =>
      mutate((s) => ({ scripts: { ...s.scripts, ...settings } })),

    toggleScripts: () =>
      mutate((s) => ({ scripts: { ...s.scripts, enabled: !s.scripts.enabled } })),

    setCombatSettings: (settings) =>
      mutate((s) => ({ combat: { ...s.combat, ...settings } })),

    toggleCombatAi: () =>
      mutate((s) => ({ combat: { ...s.combat, enabled: !s.combat.enabled } })),

    addComboSpell: (spell) =>
      mutate((s) => ({ combat: { ...s.combat, combo: [...s.combat.combo, spell] } })),

    removeComboSpell: (index) =>
      mutate((s) => ({
        combat: { ...s.combat, combo: s.combat.combo.filter((_, i) => i !== index) }
      })),

    moveComboSpell: (index, direction) =>
      mutate((s) => {
        const combo = [...s.combat.combo]
        const target = index + direction
        if (index < 0 || index >= combo.length || target < 0 || target >= combo.length) {
          return { combat: s.combat }
        }
        const [moved] = combo.splice(index, 1)
        combo.splice(target, 0, moved)
        return { combat: { ...s.combat, combo } }
      }),

    setResolution: (width, height) =>
      mutate((s) => ({
        window: { ...s.window, resolution: { width, height } }
      })),

    toggleAudioMute: () => {
      const newVal = !get().window.audioMuted
      mutate((s) => ({ window: { ...s.window, audioMuted: newVal } }))
      window.dofemu.setAudioMute(newVal)
    },

    toggleSoundOnFocus: () => {
      const newVal = !get().window.soundOnFocus
      mutate((s) => ({ window: { ...s.window, soundOnFocus: newVal } }))
      window.dofemu.setSoundOnFocus(newVal)
    },

    toggleAutoGroup: () =>
      mutate((s) => ({
        game: { ...s.game, autoGroupEnabled: !s.game.autoGroupEnabled }
      })),

    toggleAutoInvite: () =>
      mutate((s) => ({
        game: { ...s.game, autoInviteEnabled: !s.game.autoInviteEnabled }
      })),

    toggleNotifications: () =>
      mutate((s) => ({
        game: { ...s.game, notificationsEnabled: !s.game.notificationsEnabled }
      }))
  }
})
