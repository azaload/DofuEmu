import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Eraser, Plus, Search, X } from 'lucide-react'
import { Row, Section, Select, TextInput, Toggle, ghostBtn, hoverColor } from '@/components/form'
import { useSettingsStore } from '@/stores/settingsStore'
import { useGameTabStore } from '@/stores/gameTabStore'
import { useCombatStore } from '@/stores/combatStore'
import { getSpells, isFightStarted, type SpellInfo } from '@/scripts/fight-bridge'
import { colors } from '@/theme'
import { COMBAT_POSITIONING_LABELS, COMBAT_TARGET_LABELS } from '@dofemu/shared'
import type { CombatPositioning, CombatTargetStrategy } from '@dofemu/shared'

const TARGET_OPTIONS = (Object.keys(COMBAT_TARGET_LABELS) as CombatTargetStrategy[]).map((value) => ({
  value,
  label: COMBAT_TARGET_LABELS[value]
}))

const POSITIONING_OPTIONS = (Object.keys(COMBAT_POSITIONING_LABELS) as CombatPositioning[]).map(
  (value) => ({ value, label: COMBAT_POSITIONING_LABELS[value] })
)

function activeGameWindow() {
  const activeTabId = useGameTabStore.getState().activeTabId
  if (!activeTabId) return undefined
  return window.$gameWindows?.find((gameWindow) => gameWindow.$game_id === activeTabId)
}

function iconBtn(disabled = false): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, borderRadius: 5, border: 'none',
    background: colors.surfaceHover, color: disabled ? colors.textDisabled : colors.textMuted,
    cursor: disabled ? 'default' : 'pointer'
  }
}

function ComboEditor() {
  const {
    combat,
    addComboSpell,
    removeComboSpell,
    moveComboSpell,
    toggleComboSpellSelf,
    setComboSpellRange,
    addTurnCombo,
    removeTurnCombo
  } = useSettingsStore()
  // null = the default combo, a number = the override for that turn.
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null)
  const [newTurn, setNewTurn] = useState('')
  const [detected, setDetected] = useState<SpellInfo[] | null>(null)
  const [manualId, setManualId] = useState('')
  const [manualName, setManualName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const detect = () => {
    const gameWindow = activeGameWindow()
    if (!gameWindow) {
      setNotice('No connected tab — open the game first')
      return
    }
    const spells = getSpells(gameWindow)
    setDetected(spells)
    setNotice(
      spells.length > 0
        ? `Found ${spells.length} spell(s) on the active character`
        : 'Could not read the spell list on this build — add spell ids manually'
    )
  }

  const activeCombo =
    selectedTurn === null
      ? combat.combo
      : combat.turnCombos.find((entry) => entry.turn === selectedTurn)?.combo ?? []

  const addManual = () => {
    const id = parseInt(manualId, 10)
    if (!Number.isFinite(id) || id <= 0) {
      setNotice('Enter a numeric spell id')
      return
    }
    addComboSpell(selectedTurn, { id, name: manualName.trim() || `Spell ${id}` })
    setManualId('')
    setManualName('')
  }

  const addTurn = () => {
    const turn = parseInt(newTurn, 10)
    if (!Number.isFinite(turn) || turn < 1) {
      setNotice('Enter a turn number (1 or more)')
      return
    }
    if (combat.turnCombos.some((entry) => entry.turn === turn)) {
      setNotice(`Turn ${turn} already has its own combo`)
      setSelectedTurn(turn)
      return
    }
    addTurnCombo(turn)
    setSelectedTurn(turn)
    setNewTurn('')
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 11,
    background: active ? colors.accentFocus : colors.surface,
    border: `1px solid ${active ? colors.accentBorder : colors.borderSubtle}`,
    color: active ? colors.accentText : colors.textMuted
  })

  return (
    <Section title="Spell combo">
      <div style={{ fontSize: 11, color: colors.textDesc, lineHeight: 1.5, padding: '2px 0 8px' }}>
        {selectedTurn === null
          ? 'Cast in this order on every turn without its own combo, then the turn is passed.'
          : `Replaces the default combo on turn ${selectedTurn}. An empty combo passes the turn.`}
        {' '}Tick <em>on me</em> for a spell cast on your own character (buffs, heals). The
        number is the cast range in cells — leave it empty to use the game's own value.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingBottom: 10 }}>
        <button onClick={() => setSelectedTurn(null)} style={tabStyle(selectedTurn === null)}>
          Default ({combat.combo.length})
        </button>
        {combat.turnCombos.map((entry) => (
          <button
            key={entry.turn}
            onClick={() => setSelectedTurn(entry.turn)}
            style={tabStyle(selectedTurn === entry.turn)}
          >
            Turn {entry.turn} ({entry.combo.length})
            <X
              size={10}
              onClick={(event) => {
                event.stopPropagation()
                removeTurnCombo(entry.turn)
                if (selectedTurn === entry.turn) setSelectedTurn(null)
              }}
            />
          </button>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            value={newTurn}
            onChange={(event) => setNewTurn(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addTurn() }}
            placeholder="turn"
            type="number"
            style={{
              width: 54, background: colors.input, border: `1px solid ${colors.border}`,
              borderRadius: 999, color: colors.textLight, fontSize: 11, padding: '4px 8px', outline: 'none'
            }}
          />
          <button onClick={addTurn} style={tabStyle(false)}>
            <Plus size={10} /> Add turn
          </button>
        </div>
      </div>

      {activeCombo.map((spell, index) => (
        <div
          key={`${spell.id}-${index}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginBottom: 4,
            background: colors.surface, border: `1px solid ${colors.borderSubtle}`, borderRadius: 6
          }}
        >
          <span style={{ fontSize: 10, color: colors.accentText, fontFamily: 'monospace', width: 16 }}>
            {index + 1}
          </span>
          <span style={{ fontSize: 12, color: colors.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {spell.name}
          </span>
          <span style={{ fontSize: 10, color: colors.textFaint, fontFamily: 'monospace' }}>#{spell.id}</span>
          <input
            type="number"
            min={0}
            value={spell.range === undefined ? '' : String(spell.range)}
            placeholder="auto"
            title="Cast range in cells. Empty uses the game's own value, then the fallback."
            onChange={(event) => {
              const value = event.target.value.trim()
              const parsed = parseInt(value, 10)
              setComboSpellRange(
                selectedTurn,
                index,
                value === '' || !Number.isFinite(parsed) || parsed < 0 ? undefined : parsed
              )
            }}
            style={{
              width: 52, background: colors.input, border: `1px solid ${colors.border}`,
              borderRadius: 5, color: colors.textLight, fontSize: 10, padding: '3px 6px', outline: 'none'
            }}
          />
          <label
            title="Cast this spell on my own character"
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: spell.self ? colors.accentText : colors.textFaint, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={spell.self === true}
              onChange={() => toggleComboSpellSelf(selectedTurn, index)}
              style={{ accentColor: colors.accent, cursor: 'pointer', margin: 0 }}
            />
            on me
          </label>
          <button
            onClick={() => moveComboSpell(selectedTurn, index, -1)}
            disabled={index === 0}
            style={iconBtn(index === 0)}
          >
            <ArrowUp size={11} />
          </button>
          <button
            onClick={() => moveComboSpell(selectedTurn, index, 1)}
            disabled={index === activeCombo.length - 1}
            style={iconBtn(index === activeCombo.length - 1)}
          >
            <ArrowDown size={11} />
          </button>
          <button onClick={() => removeComboSpell(selectedTurn, index)} style={iconBtn()}>
            <X size={11} />
          </button>
        </div>
      ))}

      {activeCombo.length === 0 && (
        <div style={{ color: colors.textDisabled, fontSize: 12, padding: 12, textAlign: 'center' }}>
          {selectedTurn === null
            ? 'No spell yet — detect them or add an id below.'
            : `Turn ${selectedTurn} casts nothing and passes.`}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '10px 0 6px' }}>
        <button
          onClick={detect}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, background: colors.surfaceHover,
            border: 'none', borderRadius: 6, color: colors.textMuted, fontSize: 11,
            padding: '6px 12px', cursor: 'pointer'
          }}
        >
          <Search size={11} /> Detect spells
        </button>
        {detected && detected.length > 0 && (
          <Select
            value=""
            onChange={(value) => {
              const spell = detected.find((candidate) => String(candidate.id) === value)
              if (spell) {
                addComboSpell(selectedTurn, { id: spell.id, name: spell.name ?? `Spell ${spell.id}` })
              }
            }}
            options={[
              { value: '', label: 'Add a detected spell...' },
              ...detected.map((spell) => ({
                value: String(spell.id),
                label: spell.name ? `${spell.name} (#${spell.id})` : `Spell #${spell.id}`
              }))
            ]}
            width={210}
          />
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 6 }}>
        <TextInput value={manualId} onChange={setManualId} placeholder="Spell id" type="number" />
        <TextInput value={manualName} onChange={setManualName} placeholder="Name (optional)" />
        <button
          onClick={addManual}
          style={{ background: colors.accent, border: 'none', borderRadius: 6, color: colors.white, fontSize: 12, padding: '0 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <Plus size={11} /> Add
        </button>
      </div>

      {notice && <div style={{ fontSize: 11, color: colors.accentText, paddingTop: 8 }}>{notice}</div>}
    </Section>
  )
}

function CombatLog() {
  const { logs, clearLogs } = useCombatStore()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs.length])

  return (
    <Section title="Activity">
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 4 }}>
        <button
          onClick={clearLogs}
          style={{ ...ghostBtn, display: 'flex', alignItems: 'center', gap: 4 }}
          onMouseEnter={(e) => hoverColor(e, colors.hoverLight)}
          onMouseLeave={(e) => hoverColor(e, colors.textFaint)}
        >
          <Eraser size={10} /> Clear
        </button>
      </div>
      <div
        ref={ref}
        style={{
          height: 130, overflow: 'auto', background: colors.input,
          border: `1px solid ${colors.borderSubtle}`, borderRadius: 6, padding: 8,
          fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, color: colors.textMuted
        }}
      >
        {logs.length === 0 && <div style={{ color: colors.textDisabled }}>Nothing yet.</div>}
        {logs.map((entry) => (
          <div key={entry.id}>
            <span style={{ color: colors.textDisabled }}>
              {new Date(entry.timestamp).toLocaleTimeString()}{' '}
            </span>
            {entry.message}
          </div>
        ))}
      </div>
    </Section>
  )
}

export function CombatScreen() {
  const { combat, setCombatSettings, toggleCombatAi } = useSettingsStore()
  const [fighting, setFighting] = useState(false)

  useEffect(() => {
    const timer = setInterval(() => {
      const gameWindow = activeGameWindow()
      setFighting(gameWindow ? isFightStarted(gameWindow) : false)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <Section title="Combat AI">
        <Row label="Enable" desc="Play every turn automatically on all connected tabs">
          <Toggle checked={combat.enabled} onChange={toggleCombatAi} />
        </Row>
        <Row label="Status" desc="Active tab">
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: fighting ? '#4ade80' : colors.textFaint }}>
            {fighting ? 'in fight' : 'out of fight'}
          </span>
        </Row>
        <Row label="Target" desc="Which enemy the combo is cast on">
          <Select
            value={combat.targetStrategy}
            onChange={(value) => setCombatSettings({ targetStrategy: value as CombatTargetStrategy })}
            options={TARGET_OPTIONS}
          />
        </Row>
        <Row label="Ready up automatically" desc="Send ready when a fight starts">
          <Toggle checked={combat.autoReady} onChange={(v) => setCombatSettings({ autoReady: v })} />
        </Row>
        <Row label="Move in fights" desc="Spend the movement points to get in position">
          <Toggle
            checked={combat.approachEnemies}
            onChange={(v) => setCombatSettings({ approachEnemies: v })}
          />
        </Row>
        {combat.approachEnemies && (
          <Row label="Positioning" desc="Where to stand before casting">
            <Select
              value={combat.positioning}
              onChange={(value) => setCombatSettings({ positioning: value as CombatPositioning })}
              options={POSITIONING_OPTIONS}
            />
          </Row>
        )}
        {combat.approachEnemies && (
          <Row
            label="Never move in contact"
            desc="A monster next to you holds it: the turn goes to casting, not to a tackle"
          >
            <Toggle
              checked={combat.tackleAware}
              onChange={(v) => setCombatSettings({ tackleAware: v })}
            />
          </Row>
        )}
        {combat.approachEnemies && (
          <Row label="Line up with the target" desc="Prefer cells sharing a row or column with the enemy">
            <Toggle
              checked={combat.preferLineUp}
              onChange={(v) => setCombatSettings({ preferLineUp: v })}
            />
          </Row>
        )}
        {combat.approachEnemies && (
          <Row label="Fallback range" desc="Cast range assumed when the game does not report the spell's">
            <div style={{ width: 90 }}>
              <TextInput
                type="number"
                value={String(combat.defaultSpellRange)}
                onChange={(v) => setCombatSettings({ defaultSpellRange: Math.max(1, parseInt(v, 10) || 1) })}
              />
            </div>
          </Row>
        )}
        <Row
          label="Spread the casts"
          desc="One cast per enemy in range, instead of emptying the combo on one"
        >
          <Toggle
            checked={combat.spreadCasts}
            onChange={(v) => setCombatSettings({ spreadCasts: v })}
          />
        </Row>
        <Row label="Close end screens" desc="Dismiss the fight results and level-up windows">
          <Toggle
            checked={combat.closeEndScreens}
            onChange={(v) => setCombatSettings({ closeEndScreens: v })}
          />
        </Row>
        <Row label="End turn after the combo">
          <Toggle
            checked={combat.endTurnAfterCombo}
            onChange={(v) => setCombatSettings({ endTurnAfterCombo: v })}
          />
        </Row>
        <Row label="Ready delay (ms)" desc="Pause before pressing ready when a fight opens">
          <div style={{ width: 90 }}>
            <TextInput
              type="number"
              value={String(combat.readyDelayMs)}
              onChange={(v) => setCombatSettings({ readyDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
          </div>
        </Row>
        <Row label="Random jitter (ms)" desc="Random extra time added to every pause">
          <div style={{ width: 90 }}>
            <TextInput
              type="number"
              value={String(combat.randomJitterMs)}
              onChange={(v) => setCombatSettings({ randomJitterMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
          </div>
        </Row>
        <Row label="Delays (ms)" desc="Before the first cast / between casts">
          <div style={{ display: 'flex', gap: 6, width: 180 }}>
            <TextInput
              type="number"
              value={String(combat.turnStartDelayMs)}
              onChange={(v) => setCombatSettings({ turnStartDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
            <TextInput
              type="number"
              value={String(combat.castDelayMs)}
              onChange={(v) => setCombatSettings({ castDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
          </div>
        </Row>
      </Section>

      <ComboEditor />
      <CombatLog />

      <div style={{ fontSize: 10, color: colors.textDesc, lineHeight: 1.5, padding: '8px 0 4px' }}>
        The combo is cast as-is every turn: no line of sight, range or action-point check is done
        yet, so a cast the server refuses is simply skipped. Check your server rules before
        automating fights.
      </div>
    </>
  )
}
