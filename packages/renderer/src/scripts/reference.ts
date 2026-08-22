export interface ApiReferenceEntry {
  signature: string
  description: string
}

export interface ApiReferenceGroup {
  title: string
  entries: ApiReferenceEntry[]
}

/** Shown in the Scripts tab and mirrored in docs/scripting.md. */
export const API_REFERENCE: ApiReferenceGroup[] = [
  {
    title: 'Movement',
    entries: [
      { signature: 'api.move(direction)', description: 'Change map towards top / bottom / left / right.' },
      { signature: 'api.movePath(path)', description: 'Run a sequence of directions ("right right bottom").' },
      { signature: 'api.changeMap(mapId)', description: 'Change to an adjacent map by id.' },
      { signature: 'api.travelTo(x, y)', description: 'Walk map by map to world coordinates.' },
      { signature: 'api.moveToCell(cellId)', description: 'Walk to a cell on the current map.' }
    ]
  },
  {
    title: 'State',
    entries: [
      { signature: 'api.map()', description: 'Current map: id, x, y, subAreaId, neighbours.' },
      { signature: 'api.mapId() / api.cellId()', description: 'Current map id and character cell.' },
      { signature: 'api.character()', description: 'Character id, name, level, kamas.' },
      { signature: 'api.isInFight() / api.isMoving()', description: 'Live character state.' },
      { signature: 'api.isConnected()', description: 'Whether the game session is connected.' }
    ]
  },
  {
    title: 'Timing',
    entries: [
      { signature: 'await api.wait(ms)', description: 'Pause, cancellable when the script is stopped.' },
      { signature: 'await api.waitRandom(min, max)', description: 'Pause for a random duration.' },
      { signature: 'await api.waitUntil(fn, opts)', description: 'Poll until fn() is true (timeout, interval).' },
      { signature: 'await api.waitForMessage(name)', description: 'Wait for a network message (timeout, filter).' }
    ]
  },
  {
    title: 'Monsters',
    entries: [
      { signature: 'api.monsters(filter)', description: 'Monster groups on the map, nearest first (minLevel, maxLevel, minSize, maxSize).' },
      { signature: 'await api.attack(group)', description: 'Walk to a group and start the fight; false when no fight started.' },
      { signature: 'api.closePopups()', description: 'Close the fight results and level-up screens; returns what was closed.' },
      { signature: 'api.inspectMap()', description: 'Log what the game exposes about the current map, when a helper cannot find it.' }
    ]
  },
  {
    title: 'Interaction',
    entries: [
      { signature: 'await api.gather()', description: 'Harvest the first available resource on the map.' },
      { signature: 'api.interactives()', description: 'Interactive elements of the current map.' },
      { signature: 'api.interact(elementId, skillUid)', description: 'Use an interactive element.' },
      { signature: 'api.chat(text, channel)', description: 'Send a chat message.' },
      { signature: 'api.invite(name) / api.acceptInvite(id)', description: 'Party invitations.' }
    ]
  },
  {
    title: 'Fight',
    entries: [
      { signature: 'api.fight.isActive() / isMyTurn()', description: 'Fight and turn state.' },
      { signature: 'await api.fight.waitForTurn()', description: 'Wait until it is our turn (also waitForTurnEnd, waitForFight, waitForFightEnd).' },
      { signature: 'api.fight.target(strategy)', description: 'Pick an enemy: nearest, weakest, strongest, first.' },
      { signature: 'await api.fight.cast(spellId, target)', description: 'Cast a spell on a fighter or a cell; false when refused.' },
      { signature: 'api.fight.endTurn() / ready()', description: 'Pass the turn, or ready up at fight start.' },
      { signature: 'api.fight.me() / enemies() / allies()', description: 'Fighters with cell, life and team.' },
      { signature: 'api.fight.spells()', description: 'Spells of the current character, with ids.' }
    ]
  },
  {
    title: 'Protocol & tabs',
    entries: [
      { signature: 'api.send(name, data)', description: 'Send any raw network message.' },
      { signature: 'api.on(name, handler)', description: 'Listen to a message; auto-removed when the run ends.' },
      { signature: 'api.broadcast(channel, data)', description: 'Send data to scripts running on other tabs.' },
      { signature: 'api.onBroadcast(channel, handler)', description: 'Receive data from other tabs.' },
      { signature: 'api.raw', description: 'Raw window, gui, isoEngine and connectionManager handles.' }
    ]
  },
  {
    title: 'Control',
    entries: [
      { signature: 'api.log() / api.warn() / api.error()', description: 'Write to the script log panel.' },
      { signature: 'api.stop(reason)', description: 'Stop the current run immediately.' },
      { signature: 'api.iteration', description: 'Current loop iteration (starts at 1).' },
      { signature: 'api.random(min, max) / api.pick(list)', description: 'Randomness helpers.' }
    ]
  }
]
