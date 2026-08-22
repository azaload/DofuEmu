export interface GameContext {
  gameSrc: string
  characterImagesSrc: string
  windowId: number
  hash: string
  platform: string
  buildVersion: string
  appVersion: string
}

export interface WindowSettings {
  audioMuted: boolean
  soundOnFocus: boolean
  resolution: Resolution
}

export interface Resolution {
  width: number
  height: number
}

export interface ProxySettings {
  enabled: boolean
  host: string
  port: number
  username: string
  password: string
  protocol: 'http' | 'https' | 'socks5'
}

export interface GameSettings {
  autoGroupEnabled: boolean
  autoInviteEnabled: boolean
  notificationsEnabled: boolean
}

export interface ScriptSettings {
  enabled: boolean
  humanDelays: boolean
  minActionDelayMs: number
  maxActionDelayMs: number
  stopOnFight: boolean
  maxRuntimeMinutes: number
}

export type CombatTargetStrategy = 'nearest' | 'weakest' | 'strongest' | 'first'

export interface CombatSpell {
  id: number
  name: string
  /** Cast on our own cell instead of the target. */
  self?: boolean
  /** Cast range in cells. Overrides what the game reports, when set. */
  range?: number
}

/** A combo that replaces the default one on a given turn of the fight. */
export interface CombatTurnCombo {
  turn: number
  combo: CombatSpell[]
}

export interface CombatSettings {
  enabled: boolean
  combo: CombatSpell[]
  turnCombos: CombatTurnCombo[]
  targetStrategy: CombatTargetStrategy
  autoReady: boolean
  turnStartDelayMs: number
  castDelayMs: number
  /** Pause before pressing ready at the start of a fight. */
  readyDelayMs: number
  /** Random extra time added to every pause, so actions are not clockwork. */
  randomJitterMs: number
  endTurnAfterCombo: boolean
  closeEndScreens: boolean
  /** Walk towards the target with the remaining MP when it is out of range. */
  approachEnemies: boolean
  /** Cast range assumed when the game does not report the spell's own range. */
  defaultSpellRange: number
  /** Move onto a cell lined up with the target when possible. */
  preferLineUp: boolean
  /** How to place the character before casting. */
  positioning: CombatPositioning
  /**
   * Account for tackle: leaving a cell held by a monster costs extra MP and AP,
   * so only escape when it clears melee, and keep points in reserve.
   */
  tackleAware: boolean
  /**
   * Cast each spell once per enemy in range rather than emptying the combo on
   * a single one. With one enemy in range this plays the combo as written.
   */
  spreadCasts: boolean
}

export type CombatPositioning = 'keep-distance' | 'close-in'

export const COMBAT_POSITIONING_LABELS: Record<CombatPositioning, string> = {
  'keep-distance': 'Keep your distance',
  'close-in': 'Close in on the target'
}

export const COMBAT_TARGET_LABELS: Record<CombatTargetStrategy, string> = {
  nearest: 'Nearest enemy',
  weakest: 'Lowest health',
  strongest: 'Highest health',
  first: 'First in the list'
}

export interface AppSettings {
  language: Language
  window: WindowSettings
  proxy: ProxySettings
  game: GameSettings
  scripts: ScriptSettings
  combat: CombatSettings
  version: string
}

export interface NativeNotificationPayload {
  title: string
  body?: string
  tabId?: string
}

export type AppUpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface AppUpdateStatus {
  phase: AppUpdatePhase
  version?: string
  percent?: number
  message?: string
  error?: string
}

export type HotkeyAction =
  | 'switch-tab-1'
  | 'switch-tab-2'
  | 'switch-tab-3'
  | 'switch-tab-4'
  | 'switch-tab-5'
  | 'new-tab'
  | 'close-tab'
  | 'toggle-mute'
  | 'toggle-notifications'
  | 'next-tab'
  | 'prev-tab'
  | 'zoom-in'
  | 'zoom-out'
  | 'run-script'
  | 'stop-scripts'
  | 'toggle-combat-ai'

export interface Character {
  id: string
  name: string
  server: string
  accountId: string
  class?: string
  level?: number
}

export interface Team {
  id: string
  name: string
  leaderId: string
  memberIds: string[]
}

export type ScriptTarget = 'active-tab' | 'all-tabs' | 'team-leader' | 'team-followers'

export interface AutomationScript {
  id: string
  name: string
  description: string
  source: string
  target: ScriptTarget
  loop: boolean
  loopDelayMs: number
  createdAt: number
  updatedAt: number
}

export type ScriptRunStatus = 'running' | 'stopping' | 'stopped' | 'done' | 'error'

export type ScriptLogLevel = 'info' | 'warn' | 'error'

export interface ScriptLogEntry {
  id: string
  runId: string
  scriptId: string
  tabId: string
  level: ScriptLogLevel
  message: string
  timestamp: number
}

export interface ScriptRun {
  id: string
  scriptId: string
  tabId: string
  status: ScriptRunStatus
  iteration: number
  startedAt: number
  endedAt?: number
  error?: string
}

export const SCRIPT_TARGET_LABELS: Record<ScriptTarget, string> = {
  'active-tab': 'Active tab',
  'all-tabs': 'All tabs',
  'team-leader': 'Team leader',
  'team-followers': 'Team followers'
}

export const SCRIPT_LIMITS = {
  maxLogEntries: 300,
  minLoopDelayMs: 0,
  maxLoopDelayMs: 600000,
  minRuntimeMinutes: 1,
  maxRuntimeMinutes: 720
} as const

export interface AutoGroupState {
  enabled: boolean
  leaderTabId: string | null
  leaderMapId: number | null
  leaderPosition: { x: number; y: number } | null
  followerTabIds: string[]
}

export const HOTKEY_ACTIONS: HotkeyAction[] = [
  'switch-tab-1',
  'switch-tab-2',
  'switch-tab-3',
  'switch-tab-4',
  'switch-tab-5',
  'new-tab',
  'close-tab',
  'toggle-mute',
  'toggle-notifications',
  'next-tab',
  'prev-tab',
  'zoom-in',
  'zoom-out',
  'run-script',
  'stop-scripts',
  'toggle-combat-ai'
]

export const HOTKEY_ACTION_LABELS: Record<HotkeyAction, string> = {
  'switch-tab-1': 'Switch to Tab 1',
  'switch-tab-2': 'Switch to Tab 2',
  'switch-tab-3': 'Switch to Tab 3',
  'switch-tab-4': 'Switch to Tab 4',
  'switch-tab-5': 'Switch to Tab 5',
  'new-tab': 'New Tab',
  'close-tab': 'Close Tab',
  'toggle-mute': 'Toggle Mute',
  'toggle-notifications': 'Toggle Notifications',
  'next-tab': 'Next Tab',
  'prev-tab': 'Previous Tab',
  'zoom-in': 'Zoom In',
  'zoom-out': 'Zoom Out',
  'run-script': 'Run Selected Script',
  'stop-scripts': 'Stop All Scripts',
  'toggle-combat-ai': 'Toggle Combat AI'
}

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
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

export const RESOLUTIONS = [
  '800x600',
  '960x600',
  '1280x720',
  '1024x768',
  '1366x768',
  '1440x900',
  '1600x900',
  '1280x1024',
  '1920x1080',
  '2560x1440'
] as const

export const LANGUAGES = [
  { name: 'English', value: 'en' },
  { name: 'Fran\u00e7ais', value: 'fr' },
  { name: 'Espa\u00f1ol', value: 'es' }
] as const

export type Language = (typeof LANGUAGES)[number]['value']

export enum IPCEvents {
  GET_GAME_CONTEXT = 'get_game_context',
  APP_READY_TO_SHOW = 'app_ready_to_show',
  SET_SETTINGS = 'set_settings',
  GET_SETTINGS = 'get_settings',
  OPEN_EXTERNAL = 'open_external',
  AUTH_CALLBACK = 'auth_callback',
  SELECT_TAB = 'select_tab',
  SET_AUDIO_MUTE = 'set_audio_mute',
  SET_SOUND_ON_FOCUS = 'set_sound_on_focus',
  WINDOW_MINIMIZE = 'window_minimize',
  WINDOW_MAXIMIZE = 'window_maximize',
  WINDOW_CLOSE = 'window_close',
  DOWNLOAD_PROGRESS = 'download_progress',
  CHECK_GAME_INSTALLED = 'check_game_installed',
  DOWNLOAD_GAME = 'download_game',
  OPEN_GAME_WINDOW = 'open_game_window',
  SAVE_CHARACTER_IMAGE = 'save_character_image',
  GET_APP_UPDATE_STATUS = 'get_app_update_status',
  CHECK_APP_UPDATE = 'check_app_update',
  INSTALL_APP_UPDATE = 'install_app_update',
  APP_UPDATE_STATUS = 'app_update_status',
  SHOW_NATIVE_NOTIFICATION = 'show_native_notification',
  NATIVE_NOTIFICATION_CLICK = 'native_notification_click',
  STORE_GET = 'store_get',
  STORE_SET = 'store_set',
  STORE_DELETE = 'store_delete'
}
