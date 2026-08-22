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

### Pauses

Every pause carries a random tail, so two actions are never the same distance apart:

| Setting | What it spaces |
|---------|----------------|
| **Ready delay** | Before pressing ready when a fight opens (900 ms by default). Pressing it instantly leaves the client showing *"waiting for…"*. |
| **Turn start delay** | Between the turn opening and the first action (250 ms). |
| **Cast delay** | Between two spells (350 ms). |
| **Random jitter** | Added at random to each of the above, from 0 to its value (600 ms). |

Delays are deliberately short — a turn costs about a second plus those pauses. If the AI
feels slow, they are the first place to look: a profile created before these defaults keeps
its older, larger values.

Whatever happens during a turn — an unexpected message, a spell that cannot be cast, an
error — the turn is always passed at the end when **End turn after the combo** is on. A
fight never stalls waiting for the AI.

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

## Letting a local model play the turn

**Decides the turn** switches between the built-in rules and a model running on your own
machine through [Ollama](https://ollama.com). Nothing leaves the machine, and no key is
needed.

```bash
ollama pull qwen2.5:1.5b-instruct
```

The Windows and macOS installers already run the server in the background, so `ollama serve`
answers *"Only one usage of each socket address"* — that error means it is up, not broken.
`ollama list` confirms it.

Then set **Decides the turn** to *Local model*, check the endpoint (`http://127.0.0.1:11434`
by default) and the model name, and press **Test**: it sends one tiny request and reports
the round trip, or what failed.

The first request after a model is pulled loads it into memory and takes a few seconds;
the ones after that are the speed you will get in fights.

### What the model receives

Not the raw fight — a snapshot where the hard parts are already solved:

- your cell, life, action and movement points, **who holds you in contact** and whether
  moving is allowed at all
- the spells of the combo, with their range, whether they push their target, and, for each,
  **the enemies it can actually hit right now** (range and line of sight already checked)
- every enemy and ally with position, life, distance, line of sight and alignment
- **the cells you can reach this turn**, each with its cost in movement points, its
  distance to the closest enemy, and which enemies it sees or lines up with — the list is
  empty while a monster holds you, so a move cannot even be considered
- the fight's challenges when the client exposes them

A one- or two-billion-parameter model cannot work out geometry on its own; it can pick from
a list of legal options. That is the whole design.

### What comes back

A plan: an ordered list of `move` and `cast` actions. Enemies are numbered 1, 2, 3 in the
snapshot and the model aims with those numbers, which small models handle far better than
raw fighter ids.

Every action is checked against the snapshot before anything reaches the game — a cell that is not reachable, a spell that is
not in the combo, a target out of reach or unknown — and what is dropped is written to the
activity log. A cast is never dropped for a bad target: a model that invents one, or aims out of reach,
has its cast **re-aimed** at an enemy the spell can actually hit. A turn spent attacking the
wrong monster still ends the fight; a turn spent doing nothing does not.

And a plan that only walks does not end the turn: the configured combo is cast on top of it.
Whatever the model decides, a turn where an enemy is in reach ends with an attack.

If the model does not answer within **Answer timeout**, answers nothing usable, or is not
running at all, the built-in rules play the turn instead. A fight is never lost to a model
that stalls.

### Challenges

Challenges change what a good turn is, so they are captured from the fight itself — the
`ChallengeInfoMessage` the server sends, and the wording shown in the challenge panel, which
is what actually says what is asked.

Three constraints are read from that wording, in French or English, and **enforced** rather
than suggested:

| Wording | Effect |
|---------|--------|
| *ne pas se déplacer*, *statique*, *do not move* | no move is planned, and none is accepted from the model |
| *un seul ennemi*, *une seule cible*, *single target*, *focus* | a single enemy is hit for the turn, spreading is turned off |
| a challenge naming a fighter | only that fighter is attacked |
| *corps à corps*, *melee*, *adjacent* | passed on as "do not end the turn next to an enemy" |

Anything else is passed to the model verbatim — name, description and the fighter it points
at — with **Play the challenges** telling it to hold them even at the cost of damage. That
is where a model earns its place: it reads a challenge no keyword covers.

The active challenges are named in the activity log at the start of each turn, so you can
see what the AI is working with.

### Honest limits

- A small model on CPU answers in roughly half a second to two seconds. Fast, not instant.
- It is asked once per turn, and plans the whole turn at once.
- The rules remain the safety net, and the validation the guardrail: the model chooses,
  it never bypasses what the game allows.

## A different combo on a given turn

The default combo runs on every turn. To open a fight differently — buffs on turn 1, then
the usual rotation — add a turn-specific combo: in the **Spell combo** section, type a turn
number next to **Add turn** and fill the list that appears.

- The tabs show **Default** plus one per configured turn, with the number of spells in each.
- Turn numbers count *your own* turns in the current fight: turn 1 is your first turn. The
  counter resets at the start of every fight.
- A turn with no override plays the default combo.
- An override with an empty list is meaningful: that turn casts nothing and passes.

## Positioning

With **Move in fights** on (the default), the AI places the character **once per turn**,
before casting anything — one move, followed to its end. Asking again while the engine is
still walking is what made a character cross three cells one step at a time.

Two modes:

- **Keep your distance** (default) — stand as far from every enemy as the spells still
  allow, so the character fights at range instead of drifting into melee. Once a monster
  *is* in contact, see **Tackle** below: the AI stays and casts.
- **Close in on the target** — walk up to the target instead, for melee builds.

The range used for the decision is the **shortest** range in the combo, so every spell can
still reach from where the character ends up. It comes from the range set on the spell, then
the game's own value, then the **Fallback range** setting.

**Line up with the target** (on by default) comes first among the cells that can cast: a
line spell that cannot be thrown makes the safest cell worthless. Distance from the enemies
then decides between the cells that are lined up.

Already in range, the AI only moves for something the cast needs — lining up, or backing
away from the enemies. It does not walk closer for its own sake: that spends points and
invites melee.

### Tackle

A monster standing next to the character holds it. Leaving that cell is tackled: it costs
more movement points than the distance walked, can cost action points, and often fails
outright — the character ends up still in contact, with nothing left to cast.

**Never move in contact** (on by default) makes the rule absolute: as soon as one enemy is
in contact, **no move is planned at all** and the whole turn goes to casting, whatever the
positioning mode and however many movement points are left. The log says so:
`Held by 2 monster(s) in contact: not moving, casting from here`.

Turn it off only if you want the AI to attempt escapes; it will then place itself as it
would out of melee, and report what the tackle really cost.

### Breaking a hold with a push

Fleeing on foot is tackled — pushing the monster away is not. Tick **push** on a spell that
throws its target back, and in *Keep your distance* the AI casts it at the start of the turn
when **exactly one** enemy holds the character, freeing it for the rest of the turn.

With two or more monsters in contact it is not used: pushing one leaves the other holding,
for nothing.

## Spreading the casts

**Spread the casts** (on by default) plays a turn across the group rather than dumping it
on one enemy: each spell of the combo is cast **once per enemy within its range**, in the
order the target strategy gives.

- Two enemies in range, combo `A, B` → `A` on the first, `A` on the second, then `B` on
  each.
- One enemy in range → the combo runs as written: `A` then `B` on it.

Turn it off to send the whole combo at a single target.

Only enemies actually within the spell's range are considered, so a cast is no longer
thrown at someone out of reach.

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
- One placement per turn: no repositioning between two casts of the same turn.
- No line-of-sight or cover reasoning — "keep your distance" maximises raw distance from
  enemies, nothing more.
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
