import type {
  AutomationScript,
  ScriptLogLevel,
  ScriptRun,
  ScriptRunStatus,
  ScriptSettings
} from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import { createScriptApi } from './api'
import { ScriptAbortError, type ScriptApi } from './types'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (api: ScriptApi) => Promise<unknown>

export interface ScriptRunnerHooks {
  onStatus: (run: ScriptRun) => void
  onLog: (level: ScriptLogLevel, message: string, run: ScriptRun) => void
}

export interface ScriptRunnerOptions {
  script: AutomationScript
  tabId: string
  gameWindow: DofusWindow
  settings: ScriptSettings
  hooks: ScriptRunnerHooks
}

export function compileScript(source: string): (api: ScriptApi) => Promise<unknown> {
  return new AsyncFunction('api', `"use strict";\n${source}\n`)
}

export class ScriptRunner {
  readonly runId = crypto.randomUUID()
  readonly script: AutomationScript
  readonly tabId: string

  private readonly controller = new AbortController()
  private readonly cleanups: Array<() => void> = []
  private readonly options: ScriptRunnerOptions
  private status: ScriptRunStatus = 'running'
  private iteration = 0
  private startedAt = Date.now()
  private endedAt: number | undefined
  private error: string | undefined
  private runtimeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: ScriptRunnerOptions) {
    this.options = options
    this.script = options.script
    this.tabId = options.tabId
  }

  get key(): string {
    return `${this.script.id}|${this.tabId}`
  }

  snapshot(): ScriptRun {
    return {
      id: this.runId,
      scriptId: this.script.id,
      tabId: this.tabId,
      status: this.status,
      iteration: this.iteration,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.error
    }
  }

  private setStatus(status: ScriptRunStatus, error?: string) {
    this.status = status
    this.error = error
    if (status !== 'running' && status !== 'stopping') this.endedAt = Date.now()
    this.options.hooks.onStatus(this.snapshot())
  }

  private log(level: ScriptLogLevel, message: string) {
    this.options.hooks.onLog(level, message, this.snapshot())
  }

  stop(reason?: string) {
    if (this.status !== 'running') return
    this.setStatus('stopping')
    if (reason) this.log('info', reason)
    this.controller.abort()
  }

  private dispose() {
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer)
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup()
      } catch {}
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms))
      this.controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
  }

  async run(): Promise<ScriptRun> {
    const { script, settings } = this.options
    this.startedAt = Date.now()
    this.setStatus('running')

    let compiled: (api: ScriptApi) => Promise<unknown>
    try {
      compiled = compileScript(script.source)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log('error', `Syntax error: ${message}`)
      this.setStatus('error', message)
      return this.snapshot()
    }

    const api = createScriptApi({
      script,
      tabId: this.tabId,
      runId: this.runId,
      gameWindow: this.options.gameWindow,
      settings,
      signal: this.controller.signal,
      hooks: { onLog: (level, message) => this.log(level, message) },
      getIteration: () => this.iteration,
      registerCleanup: (dispose) => this.cleanups.push(dispose)
    })

    const maxRuntimeMs = Math.max(1, settings.maxRuntimeMinutes) * 60_000
    this.runtimeTimer = setTimeout(() => {
      this.stop(`Reached the ${settings.maxRuntimeMinutes} minute runtime limit`)
    }, maxRuntimeMs)

    this.log('info', `Started "${script.name}" on tab ${this.tabId}`)

    try {
      do {
        this.iteration += 1
        await compiled(api)
        if (!script.loop || this.controller.signal.aborted) break
        if (script.loopDelayMs > 0) await this.sleep(script.loopDelayMs)
      } while (!this.controller.signal.aborted)

      if (this.controller.signal.aborted) {
        this.setStatus('stopped')
        this.log('info', 'Script stopped')
      } else {
        this.setStatus('done')
        this.log('info', `Script finished after ${this.iteration} iteration(s)`)
      }
    } catch (err) {
      if (err instanceof ScriptAbortError) {
        this.setStatus('stopped')
        this.log('info', err.message)
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.log('error', message)
        this.setStatus('error', message)
      }
    } finally {
      this.dispose()
    }

    return this.snapshot()
  }
}

const runners = new Map<string, ScriptRunner>()

export function registerRunner(runner: ScriptRunner) {
  runners.set(runner.runId, runner)
}

export function unregisterRunner(runner: ScriptRunner) {
  runners.delete(runner.runId)
}

export function getRunner(runId: string): ScriptRunner | undefined {
  return runners.get(runId)
}

export function findRunner(scriptId: string, tabId: string): ScriptRunner | undefined {
  for (const runner of runners.values()) {
    if (runner.script.id === scriptId && runner.tabId === tabId) return runner
  }
  return undefined
}

export function listRunners(): ScriptRunner[] {
  return [...runners.values()]
}

export function stopAllRunners(reason?: string) {
  for (const runner of runners.values()) runner.stop(reason)
}
