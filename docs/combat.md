# Combat AI

The Combat AI plays fight turns for you. In its current form it does one thing, on every
turn, on every connected tab: cast a fixed spell combo on a target, then pass the turn.

Configure it in **Settings → Combat**. `Ctrl+Shift+F` toggles it on and off.

## How a turn is played

1. A fight starts — if **Ready up automatically** is on, the AI sends the ready signal.
2. Your character's turn begins. The AI waits for the server to declare the turn playable
   and for any animation still running, picks the combo for that turn number (see below),
   then waits **turn start delay** milliseconds.
3. For each spell of the combo, in order: pick a target with the configured strategy,
   walk closer if it is out of range, cast, then wait **cast delay** milliseconds.
4. Once the combo is done, the turn is passed (unless **End turn after the combo** is off).

Settings are read at the start of every turn, so editing the combo mid-fight applies from
the next turn — nothing to restart.

Every action waits for the client to be idle: the AI never casts or passes the turn while
an animation sequence is playing, and never sends anything belonging to a turn that has
already moved on. Acting too early is what freezes a fight — the client keeps waiting for
a handshake that never comes.

## End-of-fight screens

When a fight ends the game shows its results screen, and sometimes a level-up window on
top of it. Both stay up until dismissed and block the next move, so **Close end screens**
(on by default) closes them for you. The sweep runs three times over the five seconds
following the end of the fight, because the level-up window often lands after the results.

Only those screens are targeted — an inventory or a chat window you opened stays open.
In a script the same thing is `api.closePopups()`, which returns what it closed.

## The combo

Spells are identified by their in-game spell id. Two ways to fill the list:

- **Detect spells** reads the spell list of the character in the active tab and offers it
  in a dropdown. This needs the tab to be connected and in game.
- **Manual entry**: type the spell id (and, optionally, a name for your own reference).

Use the arrows to reorder, the cross to remove. The number on the left is the cast order.

Tick **on me** on a spell to cast it on your own character — buffs, heals, summons at your
feet. A self spell needs no target and no movement: it is cast even when every enemy is out
of reach.

The number next to it is that spell's **cast range in cells**. Leave it empty to use the
range the game reports, and the **Fallback range** setting when it reports none. Set it
when a ranged spell keeps walking towards the enemy instead of casting: that means the
range could not be read and the fallback (1, melee) was used.

## A different combo on a given turn

The default combo runs on every turn. To open a fight differently — buffs on turn 1, then
the usual rotation — add a turn-specific combo: in the **Spell combo** section, type a turn
number next to **Add turn** and fill the list that appears.

- The tabs show **Default** plus one per configured turn, with the number of spells in each.
- Turn numbers count *your own* turns in the current fight: turn 1 is your first turn. The
  counter resets at the start of every fight.
- A turn with no override plays the default combo.
- An override with an empty list is meaningful: that turn casts nothing and passes.

## Moving towards enemies

With **Move towards enemies** on (the default), a target out of range does not waste the
turn. Cells reachable with the movement points left are ranked like this:

1. **In range and lined up** with the target — the best spot.
2. **In range** — the cheapest one, so movement points are kept.
3. **Neither** — the target is too far to reach this turn, so the AI walks anyway to close
   distance, spending the points it has rather than standing still.

**Line up with the target** (on by default) makes the AI favour cells sharing a row or a
column with the enemy, which is what line-only spells need. Out of range, lining up wins
over one extra cell of progress — but only when the move still gets closer; it never
trades progress for an alignment that goes nowhere.

The range used is the one set on the spell, then the game's own value, then the **Fallback
range** setting (1 = melee). Cells occupied by other fighters are skipped.

The engine sometimes walks less far than asked — a blocked path, a shorter route. The AI
checks where it actually landed and tries again while it makes progress and has points
left, at most three times per spell, then casts from wherever it stands. Every step is in
the activity log with the distance and the range used, so a spell the server refuses can be
traced back to its cause.

Distances are grid distances — obstacles and the real path length are not simulated — so
the move is a best effort. If nothing can be improved, or there are no movement points
left, it says so in the activity log and casts anyway (the server refuses what is out of
range).

## Target strategies

| Strategy | Picks |
|----------|-------|
| Nearest enemy | Smallest grid distance from your fighter |
| Lowest health | Enemy with the fewest life points |
| Highest health | Enemy with the most life points |
| First in the list | First living enemy the fight manager reports |

The target is re-evaluated before each cast, so a combo that kills its target moves on to
the next enemy.

## Current limits

This is deliberately the basic version:

- No line of sight or action-point checks — a cast the server refuses is simply skipped,
  and the AI moves on to the next spell.
- Movement is limited to closing in on the target: no kiting, no cover, no repositioning
  between casts.
- No spell conditions (cooldowns, states) beyond the turn-number combos above.
- The AI does not look for fights: pair it with the hunt script below to farm.

## Chaining fights automatically

The Combat AI only plays the turns of a fight it is already in — it does not look for
fights. To farm, pair it with the **Hunt: fight a map circuit** script
([scripting.md](scripting.md#farming-a-map-circuit)): the script walks your map list and
starts the fights, the Combat AI plays them.

## Going further with scripts

Everything the AI does is available to scripts through `api.fight`, so custom logic
(conditions, positioning, buff-then-attack sequences) can be written in **Settings →
Scripts**. The **Combat: spell combo** template is the same behaviour in script form —
start from it:

```js
await api.fight.waitForTurn({ timeout: 600000 })

const target = api.fight.target('weakest')
if (target && api.fight.distanceTo(target) <= 4) {
  await api.fight.cast(161, target)
}

api.fight.endTurn()
```

See [scripting.md](scripting.md) for the full `api.fight` reference.

## Tests

`pnpm run test:scripts` covers the controller against a stub game window: ready-up, combo
order, target selection, passing the turn, ignoring other fighters' turns, and doing
nothing while disabled.
