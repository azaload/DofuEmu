# Automation scripts

DofEmu can run user-written JavaScript against any game tab: movement paths, resource
circuits, group relays, message watchers — anything the game client itself can do.

Scripts live in **Settings → Scripts**. Each script is plain JavaScript executed by the
client with an injected `api` object; there is no build step and no import syntax.

> Automating gameplay may be against your server's rules, and a script runs with the same
> privileges as the client itself. Only run scripts you wrote or trust.

## Anatomy of a script

The body of a script is an async function body — `await` works at the top level:

```js
api.log('Starting on map', api.mapId())

await api.movePath('right right bottom')
await api.waitRandom(500, 1500)

while (await api.gather()) {
  api.log('Harvested one resource')
}
```

Each script has:

| Field | Meaning |
|-------|---------|
| **Target** | Which tabs the script runs on: active tab, all tabs, team leader, team followers |
| **Loop** | Re-run the body until stopped |
| **Loop delay** | Pause between two iterations, in milliseconds |

`Ctrl+Shift+R` runs the selected script, `Ctrl+Shift+X` stops every running script (both
rebindable in **Settings → Hotkeys**). The lightning icon in the title bar opens the Scripts
tab and turns gold with a counter while scripts are running — click it to stop them all.

## Runner settings

Under **Settings → Scripts → Runner**:

- **Enable automation** — master switch; nothing starts while it is off.
- **Human-like delays** — random pause after every in-game action, bounded by the
  min/max values.
- **Stop on fight** — a run aborts as soon as the character enters a fight.
- **Runtime limit** — hard stop after N minutes, so a runaway loop cannot run forever.

## API reference

### Movement

| Call | Description |
|------|-------------|
| `await api.move(direction)` | Change map towards `top`, `bottom`, `left` or `right` (aliases: `up`, `down`, `north`, `n`…). Walks to a map-change cell first. |
| `await api.movePath(path)` | A sequence of directions, as a string (`'right right bottom'`) or an array. |
| `await api.changeMap(mapId)` | Change to an adjacent map by id. |
| `await api.travelTo(x, y)` | Walk map by map towards world coordinates. Accepts `{ maxSteps }`. |
| `await api.moveToCell(cellId)` | Walk to a cell on the current map. |

Movement helpers resolve once the game confirms arrival and reject on timeout
(default 20s, override with `{ timeout }`).

### State

| Call | Description |
|------|-------------|
| `api.map()` | `{ id, x, y, subAreaId, neighbours }` — `neighbours` holds the adjacent map ids per direction, or `null`. |
| `api.mapId()` / `api.cellId()` | Current map id and character cell. |
| `api.character()` | `{ id, name, level, kamas }`. |
| `api.isInFight()` / `api.isMoving()` / `api.isConnected()` | Live character state. |

### Timing

| Call | Description |
|------|-------------|
| `await api.wait(ms)` | Pause. Cancelled immediately when the script is stopped. |
| `await api.waitRandom(min, max)` | Pause for a random duration. |
| `await api.waitUntil(fn, { timeout, interval, message })` | Poll until `fn()` returns true. |
| `await api.waitForMessage(name, { timeout, filter, source })` | Resolve with the next matching network message. |

### Fight

| Call | Description |
|------|-------------|
| `api.fight.isActive()` / `isMyTurn()` | Fight and turn state. |
| `await api.fight.waitForTurn()` | Wait for our turn. Also `waitForTurnEnd()`, `waitForFight()`, `waitForFightEnd()`. |
| `api.fight.target(strategy)` | Pick an enemy: `nearest`, `weakest`, `strongest`, `first`. |
| `await api.fight.cast(spellId, target)` | Cast on a fighter or a cell id; resolves `false` when the server refuses. |
| `api.fight.endTurn()` / `ready()` | Pass the turn, ready up at fight start. |
| `api.fight.me()` / `enemies()` / `allies()` | Fighters with cell, life and team. |
| `api.fight.spells()` | Spells of the current character, with their ids. |
| `api.fight.distanceTo(target)` | Grid distance from our fighter. |

The no-code version of a fixed combo lives in **Settings → Combat** — see
[combat.md](combat.md).

### Monsters

| Call | Description |
|------|-------------|
| `api.monsters(filter)` | Monster groups on the current map, nearest first. Filter with `minLevel`, `maxLevel`, `minSize`, `maxSize` (`level` is the summed level of the whole group), or pass `nearestFirst: false` to keep the game's order. |
| `await api.attack(group)` | Walk next to the group and start the fight. Resolves `false` when no fight started within the timeout; `{ approach: false }` skips the walk. Each step is written to the script log. |
| `api.closePopups()` | Close the fight results and level-up screens, which block the next move. Returns what was closed. |

### Interaction

| Call | Description |
|------|-------------|
| `await api.gather()` | Harvest the first available resource on the map. Returns `false` when there is nothing to harvest. |
| `api.interactives()` | Interactive elements of the current map. |
| `api.interact(elementId, skillUid)` | Use an interactive element. |
| `api.chat(text, channel)` | Send a chat message. |
| `api.invite(name)` / `api.acceptInvite(partyId)` | Party invitations. |

### Protocol and cross-tab messaging

| Call | Description |
|------|-------------|
| `api.send(name, data)` | Send any raw network message, e.g. `api.send('ChangeMapMessage', { mapId })`. |
| `api.on(name, handler, source)` | Listen to a message. `source` is `'connection'` (default) or `'gui'`. Removed automatically when the run ends. |
| `api.broadcast(channel, data)` | Send data to scripts running on the other tabs. |
| `api.onBroadcast(channel, handler)` | Receive data from other tabs. |
| `api.raw` | `{ window, gui, isoEngine, connectionManager }` for anything the helpers do not cover. |

### Control

| Call | Description |
|------|-------------|
| `api.log()` / `api.warn()` / `api.error()` | Write to the log panel under the editor. |
| `api.stop(reason)` | Stop the current run immediately. |
| `api.iteration` | Loop iteration, starting at 1. |
| `api.tabId` / `api.scriptId` / `api.runId` | Identifiers of the current run. |
| `api.random(min, max)` / `api.pick(list)` | Randomness helpers. |

## Templates

The **From template…** menu creates a ready-made script:

- **Map patrol** — walks a path of map changes and comes back.
- **Travel to coordinates** — goes to a `[x, y]` position.
- **Resource circuit** — harvests everything on a map, then moves to the next one.
- **Follow the leader** — the leader broadcasts its map changes, followers reproduce them.
- **Anti-AFK** — small random moves at random intervals.
- **Hunt: fight a map circuit** — walks a list of maps and fights the groups that match your filters.
- **Patrol a line and fight** — back and forth along one row of maps, fighting on each.
- **Combat: spell combo** — casts a combo each turn and passes the turn.
- **Fight watcher** — logs fight starts and notifies the other tabs.

## Farming a map circuit

The **Hunt: fight a map circuit** template chains fights over maps you pick:

```js
const MAPS = [{ x: 3, y: -5 }, { x: 4, y: -5 }]
const FILTER = { minLevel: 1, maxLevel: 200, maxSize: 8 }
```

For each map it travels there, attacks every matching group one after another, waits for
each fight to end, then moves on. With **Loop** on, the circuit restarts from the top.

To fill `MAPS`, walk your character to a map: its coordinates are displayed at the top of
the Scripts tab, with a **copy** button that puts `{ x: …, y: … }` on the clipboard.

The turns themselves are played by the [Combat AI](combat.md) — enable it, or replace the
`waitForFightEnd` call with your own `api.fight` logic.

After each fight the template calls `api.closePopups()` twice: the results screen appears
right away, the level-up window sometimes a moment later, and both block the next move.
The Combat AI does the same on its own when **Close end screens** is on.

## Patrolling a line of maps

**Patrol a line and fight** walks a row back and forth — the whole trip is one lap:

```js
const Y = -21
const FROM_X = -2
const TO_X = 7
```

It travels to each map in turn, fights every group matching `FILTER`, dismisses the
end-of-fight screens, and comes back the other way. With **Loop** on, laps chain.

## Import and export

**Export** copies every script to the clipboard as JSON. **Import** reads that same JSON
back from a file. Imported scripts are never started automatically — open one and press
**Run**.

## How movement is implemented

`api.move()` reads the neighbour map ids exposed by the game's map renderer, picks a cell
flagged as an exit in that direction (`mapChangeData`), walks the character there, then
sends `ChangeMapMessage` and waits for the new map. When a game build does not expose a
movement entry point the helper throws a descriptive error — `api.send()` and `api.raw`
remain available to drive the client directly.

## Tests

`pnpm run test:scripts` bundles the engine and runs it against a stub game window: map
changes, travel, loops, cancellation, error handling and listener cleanup.
