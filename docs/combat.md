# Combat AI

The Combat AI plays fight turns for you. In its current form it does one thing, on every
turn, on every connected tab: cast a fixed spell combo on a target, then pass the turn.

Configure it in **Settings → Combat**. `Ctrl+Shift+F` toggles it on and off.

## How a turn is played

1. A fight starts — if **Ready up automatically** is on, the AI sends the ready signal.
2. Your character's turn begins. The AI waits **turn start delay** milliseconds.
3. For each spell of the combo, in order: pick a target with the configured strategy and
   cast, then wait **cast delay** milliseconds.
4. Once the combo is done, the turn is passed (unless **End turn after the combo** is off).

Settings are read at the start of every turn, so editing the combo mid-fight applies from
the next turn — nothing to restart.

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

- No line of sight, range or action-point checks — a cast the server refuses is simply
  skipped, and the AI moves on to the next spell.
- No movement: the character stays where it is.
- No positioning, no spell conditions, no target switching rules beyond the strategy above.
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
