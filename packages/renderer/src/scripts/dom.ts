import type { DofusWindow } from '@/types/dofus-window'

/** Small DOM helpers shared by the parts that drive the game's own interface. */

export const CLICKABLE_SELECTOR =
  'button, .button, [role="button"], .btn, .greenButton, .confirmButton, span, div, li, a'

export function isVisibleElement(element: Element): boolean {
  const host = element as HTMLElement
  if (typeof host.offsetParent === 'undefined') return true
  if (host.offsetParent === null) return false
  const rect = host.getBoundingClientRect?.()
  return !rect || (rect.width > 0 && rect.height > 0)
}

/** Text of an element, without the accents and casing that vary by locale. */
export function labelOf(element: Element): string {
  const raw = (element as HTMLElement).innerText ?? element.textContent ?? ''
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The innermost visible element whose label matches, so a click lands on the
 * control itself rather than on a panel that ignores it.
 */
export function findByLabel(
  gameWindow: DofusWindow,
  pattern: RegExp,
  maxLength = 40
): HTMLElement | null {
  try {
    const matches: HTMLElement[] = []
    for (const element of gameWindow.document.querySelectorAll(CLICKABLE_SELECTOR)) {
      const label = labelOf(element)
      if (label.length === 0 || label.length > maxLength) continue
      if (!pattern.test(label)) continue
      if (!isVisibleElement(element)) continue
      matches.push(element as HTMLElement)
    }

    return (
      matches
        .filter((element) => !matches.some((other) => other !== element && element.contains(other)))
        .shift() ?? null
    )
  } catch {
    return null
  }
}

/** Whether any visible text on screen matches — used to spot a dialog. */
export function screenHasText(gameWindow: DofusWindow, pattern: RegExp): boolean {
  try {
    for (const element of gameWindow.document.querySelectorAll('div, span, p')) {
      if (!isVisibleElement(element)) continue
      if (pattern.test(labelOf(element))) return true
    }
  } catch {}
  return false
}
