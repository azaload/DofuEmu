import type { AutomationScript, ScriptLogLevel, ScriptSettings } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import type { CharacterInfo, Direction, MapInfo } from './game-bridge'

export interface WaitUntilOptions {
  timeout?: number
  interval?: number
  message?: string
}

export interface WaitForMessageOptions<T = Record<string, unknown>> {
  timeout?: number
  filter?: (message: T) => boolean
  source?: 'connection' | 'gui'
}

export interface MoveOptions {
  timeout?: number
}

/** Everything a user script can reach through its `api` argument. */
export interface ScriptApi {
  readonly tabId: string
  readonly scriptId: string
  readonly runId: string
  readonly iteration: number

  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  stop: (reason?: string) => never

  wait: (ms: number) => Promise<void>
  waitRandom: (minMs: number, maxMs: number) => Promise<void>
  waitUntil: (predicate: () => boolean | Promise<boolean>, options?: WaitUntilOptions) => Promise<void>
  waitForMessage: <T = Record<string, unknown>>(
    name: string,
    options?: WaitForMessageOptions<T>
  ) => Promise<T>

  character: () => CharacterInfo
  map: () => MapInfo
  mapId: () => number | null
  cellId: () => number | null
  isInFight: () => boolean
  isConnected: () => boolean
  isMoving: () => boolean

  moveToCell: (cellId: number, options?: MoveOptions) => Promise<number>
  move: (direction: Direction | string, options?: MoveOptions) => Promise<number>
  movePath: (path: string | Array<Direction | string>, options?: MoveOptions) => Promise<number>
  changeMap: (mapId: number, options?: MoveOptions) => Promise<number>
  travelTo: (x: number, y: number, options?: MoveOptions & { maxSteps?: number }) => Promise<number>

  interactives: () => Array<Record<string, unknown>>
  interact: (elementId: number, skillUid?: number) => void
  gather: (options?: MoveOptions) => Promise<boolean>

  send: (name: string, data?: unknown) => void
  on: <T = Record<string, unknown>>(
    name: string,
    handler: (message: T) => void,
    source?: 'connection' | 'gui'
  ) => () => void
  chat: (text: string, channel?: number) => void
  invite: (name: string) => void
  acceptInvite: (partyId: number) => void

  broadcast: (channel: string, data: unknown) => void
  onBroadcast: (channel: string, handler: (data: unknown) => void) => () => void

  random: (min: number, max: number) => number
  pick: <T>(items: T[]) => T

  /** Escape hatch: raw handles on the game window for advanced scripts. */
  readonly raw: {
    window: DofusWindow
    gui: DofusWindow['gui']
    isoEngine: DofusWindow['isoEngine']
    connectionManager: unknown
  }
}

export interface ScriptRuntimeHooks {
  onLog: (level: ScriptLogLevel, message: string) => void
  onIteration?: (iteration: number) => void
}

export interface ScriptRuntimeContext {
  script: AutomationScript
  tabId: string
  runId: string
  gameWindow: DofusWindow
  settings: ScriptSettings
  signal: AbortSignal
  hooks: ScriptRuntimeHooks
  getIteration: () => number
  registerCleanup: (dispose: () => void) => void
}

/** Thrown when a run is cancelled — surfaced as "stopped", never as an error. */
export class ScriptAbortError extends Error {
  constructor(message = 'Script stopped') {
    super(message)
    this.name = 'ScriptAbortError'
  }
}
