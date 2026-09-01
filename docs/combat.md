# Combat AI

The Combat AI plays fight turns for you, on every connected tab: it takes a starting cell,
reads the character's spellbook, and plans each turn from it — where to stand, what to
throw, at which cell, and in what order — then passes the turn.

It can also be told to cast a fixed combo instead, or to hand the choice to a small model
running on your own machine. All three go through the same engine: the same geometry, the
same spell reading, the same legality checks.

Configure it in **Settings → Combat**. The crossed-swords button in the title bar, between
the scripts button and the settings gear, turns it on and off at a glance — gold when it is
playing, struck through when it is paused. `Ctrl+Shift+F` does the same from the keyboard.

## How a turn is played

1. A fight starts — the AI takes a starting cell (see [Choosing a starting
   cell](#choosing-a-starting-cell)), then, if **Ready up automatically** is on, sends the
   ready signal.
2. Your character's turn begins. The AI waits for the server to declare the turn playable
   and for any animation still running, then waits **turn start delay** milliseconds.
3. It plans the turn, plays the first action, and **plans again from what the game now
   reports** — so a monster that died, a push that moved one, or points a boost handed back
   are all taken into account. Between two actions it waits **cast delay** milliseconds.
4. When nothing is left worth doing, the turn is passed (unless **End turn after the
   combo** is off).

In manual mode step 3 is the configured combo instead, cast in order.

Settings are read at the start of every turn, so editing them mid-fight applies from the
next turn — nothing to restart.

### Pauses

Every pause carries a random tail, so two actions are never the same distance apart:

| Setting | What it spaces |
|---------|----------------|
| **Ready delay** | Before pressing ready when a fight opens (900 ms by default). Pressing it instantly leaves the client showing *"waiting for…"*. The placement is taken half way through it. |
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

Not the raw fight, and not geometry to work out: a snapshot where **every legal
action has already been computed and given a key**. The model picks keys.

- **`me`** — cell, life, action and movement points, the Portée already added to the
  spell ranges, who holds it in contact, and whether moving is allowed at all.
- **`enemies`** and **`allies`** — position, life and life percentage, distance, line of
  sight, whether they are lined up, how far each one can move *and hit* next turn, and
  the percentage each of them resists per element.
- **`spells`** — every spell the character owns: action-point cost, range as min-max,
  area shape and size, straight line, line of sight, cooldown, casts left this turn,
  whether it is a mastery, why it cannot be cast when it cannot — and, for each enemy,
  **the damage it would really take off that one**, resistances applied.
- **`casts`** — every legal cast from where the character stands, each with a key, the
  cell it is aimed at, its cost, the enemies its area covers, the allies it would catch,
  the damage, and which enemies it finishes off.
- **`moves`** — every cell worth walking to, with its cost, the distance to the closest
  monster from there, how many monsters could reach that cell next turn, and **the casts
  that become possible once standing there**, each with its own key.
- **`notes`** — a line or two in plain words: held in contact, nothing in reach, the
  mastery is ready.
- The fight's challenges, when the client exposes them and **Play the challenges** is on.

A one- or two-billion-parameter model cannot work out geometry: ask it which cell an
area spell should land on and it will invent one. Nothing is left for it to invent.

### What comes back

A list of keys:

```json
{"plan":["m2","m2c1","m2c3"],"why":"walk out of reach, then hit both"}
```

At most one move, and it comes first; after a move, only the casts listed inside that
move may be used. The action points spent may not exceed what the turn has. Every key is
checked against the snapshot it came from before anything reaches the game, and what is
dropped is written to the activity log with the reason.

**A model that hallucinates cannot produce an illegal turn.** The worst it can do is
choose a worse legal one — and the cells it casts at were computed here, so an area
spell it picks still lands where that area covers the most.

The older answer shape — `{"actions":[{"type":"cast","spellId":161,"targetId":2}]}` — is
still understood and mapped onto the best matching precomputed cast, so a model prompted
by an earlier version of this app keeps working.

If the model does not answer within **Answer timeout**, answers nothing usable, or is not
running at all, the built-in rules play the turn instead. A turn where the model only
walked is finished on the rules rather than passed: points left at the end of a turn are
points thrown away.

### Challenges

Challenges are read from the fight and named in the activity log, but they **do not
constrain the AI**. Holding a challenge is worth nothing if it costs the fight or drags it
out, and a fragile character pays that price quickly.

The wording still reaches the local model when **Play the challenges** is on, so it may
favour them when it is cheap to do so — but nothing is forbidden on their account, and the
built-in rules ignore them entirely.

### Honest limits

- A small model on CPU answers in roughly half a second to two seconds. Fast, not instant.
- It is asked once per turn, and plans the whole turn at once.
- It chooses; it never computes. Every option it is offered was worked out by the same
  code the rules use, and the rules remain the safety net when it stalls.

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

With **Move in fights** on (the default), the movement points are part of the plan rather
than a step before it: the AI compares the best run of casts it can make where it stands
against what a step sideways would unlock, and does whichever is worth more. So the points
may be spent before the first spell, between two of them, or not at all.

Two modes:

- **Keep your distance** (default) — stand as far from every enemy as the spells still
  allow, so the character fights at range instead of drifting into melee. Distance is only
  worth anything from a cell a spell can be cast from: with nothing in reach anywhere, the
  character closes in — to the **edge of its own range**, never into contact.
- **Close in on the target** — walk up to the target instead, for melee builds.

Whatever is left at the end of the turn is spent backing out of the monsters' reach. Each
monster's own movement decides how far that is, and a cell no monster can reach next turn
is worth more than one extra cell of distance. Never past the character's own range,
though: leaving the fight only postpones it, and the next turn would open with a walk.

### Choosing a starting cell

**Choose a starting cell** (on by default) uses the placement phase instead of readying
where the fight dropped you. This is a rules decision, never the model's.

The cell wanted is **the furthest one the fight can still be opened from**. In order:

1. **It must open the fight.** From the cell itself, or from anywhere the **first turn's
   movement points** can walk to, at least one of the character's spells must legally reach
   a monster — range, minimum range, straight line and a clear line of sight all checked.
   A cell that cannot is taken last, however safe it looks: it costs a whole turn.
2. **Out of the pack's first-turn reach.** A monster's movement plus its one cell of melee
   is how far it gets on its own first turn. A cell no monster reaches is worth more than
   one more cell of distance.
3. **As far back as those two allow.** Among the cells that qualify, the furthest wins.
4. Then a cell that shoots without walking, then one that sees more monsters, then one
   lined up with one, then the cheapest opening walk.

The movement points are read from the fighter, and before the first turn — when the fight
has not handed them out yet — from the character sheet. Placement that ignores them stands
several cells closer than it needs to: a cell two steps short of a bow's range still opens
the fight, and it is two cells further from the pack.

*Close in on the target* reverses the order and nothing else: the closest cell that can
still open the fight.

The choice is written to the activity log in full — `Taking starting cell 267 of 8 from
the preparation message: as far back as it can still shoot: 8 cell(s) from the closest
monster, shooting after 2 MP, out of their first-turn reach, seeing 2 (3 MP on turn one,
5 spell(s) to open with)` — so a placement that looks wrong can be argued with rather than
guessed at.

The cells come from the preparation message, and when that is missed — a build that names
it differently, a mod loaded a moment too late — they are read off the client instead, with
the source named in the log. They are taken once the game has both offered them **and**
placed the monsters: choosing before either is known scores every cell the same and takes
the first one, which is what "the placement does nothing" looks like from the outside.

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

## Letting the AI choose its spells

**Spells** decides what the built-in AI casts: *The combo I configured*, or *Choose from my
spells* (the default). In the second mode it reads the character's spellbook from the game
and plans the whole turn itself — where to stand, what to throw, and in which order.

A fight also reports the statistics behind the choice — `Stats: earth 110, fire 0, water 0,
air 20` — and which elements are ticked, naming every spell that ticking disables. All
statistics at zero means the character sheet was not found and every spell then looks
equally good, which is exactly how a fire arrow ends up cast by an earth character.

A monster that has just died stays in the client's list until its death has played out, and
is reported with no life left rather than absent. Anything at zero life, and anything the
fight has announced dead, is left alone: a spell aimed at a corpse lands on whatever else
the area covers.

The starting cell is chosen by the rules described under [Choosing a starting
cell](#choosing-a-starting-cell), from the spells this mode will actually be casting.

A move says what it really does — `closing on Piou Vert, 19 to 14 cell(s)`, `backing off`,
`sidestepping` — rather than repeating the positioning setting, and whether it ended in
range. A combo holding a spell that must be thrown along an axis lines the character up
whatever the setting says: from off the line that spell can only ever be skipped.

The combo measures its reach against the spellbook, Portée included, rather than the printed
range, and re-reads its targets before every cast: one killed by the entry before is dropped
for the next monster instead of ending the combo, and one pushed since is aimed at where it
now stands. An entry with nothing in reach is skipped, not the whole combo.

In the manual combo, a spell is aimed by its own rules rather than at the target's cell: one
with a minimum range cannot be thrown at a monster in melee, so the cast is placed beside it
where the area still covers it, and among the cells that cover the named target the one
catching the most enemies wins. Spells the client does not describe keep the configured
range and are aimed as before.

Movement is spent in two halves. Before the combo, only for what a cast needs — getting in
range, or onto a line. After it, and only then, for backing away: a monster killed in
between frees those points for reaching another one, which is why keeping your distance
waits for the spells to be played. A combo entry with nothing in reach may walk once to
find a target, and a walk the game refuses or cuts short ends the walking for that turn
rather than being asked again a cell at a time.

A wall between the character and the pack is walked around: a clear line is worth a move on
its own, whichever side of the obstacle it turns up on, and when nothing within reach can
see the target at all the character closes in until something opens up — from contact there
is always a line. Holding the right distance behind cover is holding still for the fight.

**Keeping your distance** applies to closing in as much as to backing off. With nothing
castable from anywhere in reach — the pack too far, or the line blocked — walking as close
as the points allow puts a ranged character in contact and costs the next turn to a tackle.
It therefore walks to the **edge of its own range** instead, and never ends a step in
another monster's contact for the sake of one cell.

Movement points left at the end of a turn are spent backing out of the monsters' reach —
each one's own movement decides how far that is — but never past the character's own range,
since leaving the fight only postpones it. Short of a kill, arrows go to the monster closest
to death: one that falls stops playing its turn, which is the cheapest defence there is.

A cooldown counts the turns to wait **between** casts, so a spell without one may be cast
again on the same turn — twice, three times, as long as the points last. A spell that grows
with use, costing a point more on each cast, is re-priced from what the game accepts rather
than dropped after its first refusal.

### Keeping the mastery up

A **mastery** is a boost the character puts on itself that makes the spells after it hit
harder or reach further — a bow mastery, a Portée buff. It is read as one when it is cast
on its own cell and raises the range or the damage of what follows.

With **Keep the mastery up** on (the default), it is cast **first, every time its cooldown
allows it** — but only when the action points left after it still pay for an attack. That
last clause is the whole of the adaptation to the points available:

| Action points | 2-point mastery, 4-point arrow | What is played |
|---------------|-------------------------------|----------------|
| 4 | one arrow, or the mastery and nothing | the arrow |
| 6 | the mastery and one arrow | the mastery, then the arrow |
| 8 | the mastery and two arrows | the mastery, then both |

It is skipped on the turn everything is going to die anyway — a buff that outlives the
fight is a wasted cast — and while its cooldown is running, which the turn says outright.
The range it grants is applied to the rest of the same turn, so the casts it puts in reach
are planned with it, not after it: a buffed turn is one plan, not a buff and then a shrug.

Turn the setting off and a boost is weighed like any other cast — it then loses to an area
spell that catches three monsters, and wins when nothing better is available.

### Hitting as many as possible

A cast is aimed at a **cell**, never at a fighter. Every cell a spell may legally be thrown
at is considered — range, minimum range, straight line, diagonal, line of sight, free or
occupied cell — and the one whose area covers the most monsters wins.

That is what lets an area spell aimed at empty ground catch two monsters that no cell on
either of them could cover, and what lets a spell with a minimum range be thrown *beside*
a monster in contact rather than skipped. Between two casts of equal damage the one
touching more monsters wins; a cast that would catch an ally loses to one that does not,
even when it touches fewer monsters.

Pushes and pulls are part of the plan: a spell that shoves its targets a cell back moves
them for every cast that follows, and a pull that groups a scattered pack makes the area
cast after it worth more — which the search sees, because it plans the sequence rather
than the next cast.

Statistics are looked for by what they contain rather than by where they should be: the
first object carrying the primary characteristics wins, and the path it was found at is
written to the log. A sheet that cannot be found is said outright, because with every
statistic at zero fire scores exactly as well as earth on a strength character.

A cast the server refuses — an obstacle in the way, a state the spell forbids — comes back
as silence rather than an error. The AI waits for the confirmation, and when none arrives it
says so, drops that spell on that cell for the rest of the turn and plans something else,
instead of holding the turn until the clock runs out. Pushes and pulls are part of the plan
too: a spell that shoves its targets a cell back moves them for every cast that follows, so
a second area spell is aimed where they now stand rather than where they were.

A turn that ends with action points to spare says what it left out and why: an element not
ticked, a cooldown, a range or a straight line missed, effects this code cannot read.

Which mode is running is written to the activity log when a fight opens — `Fight: automatic
mode, rules brain, Portée +2, 14 spell(s) read, 9 usable`, or a line saying the manual combo
is on and the planner is off. A turn then names its mode too, so a log always says whether
the spells cast were chosen or configured.

### What it reads from each spell

| Read | Used for |
|------|----------|
| Action point cost | chaining casts until the points run out |
| Range, minimum range | which cells the spell may be aimed at |
| Range boostable | whether the character's Portée adds to that range |
| Straight line only, diagonal only | a spell that must be thrown along an axis is only aimed there |
| Line of sight required | a blocked line rules the cell out, for that spell alone |
| Free cell / occupied cell required | a spell that must land on someone is never thrown at empty ground, and the reverse |
| Area shape, size and minimum size | what a cast really covers, hollow areas included |
| Cooldown, casts per turn, casts per target | when a spell is available again, and on whom |
| Effects | damage per element, healing, boosts, pushes, summons |

A range the build works out for itself — a spell exposing `getRange()` and the like — is
taken as the authority, since it knows about bonuses this code has no name for. Failing
that, a spell's printed range is only its base. Everything the game flags **boostable** — and everything whose build never mentions the flag,
since the spells that do not take the Portée are the ones that say so — reaches
as far as the character's **Portée** takes it, gear and fight buffs included, so a bow
mastery that grants range is worth casting before shooting rather than after: the plan
knows what the buff opens up and uses it in the same turn.

Shapes are read as the game gives them — point, circle, square, line, perpendicular bar,
cross, diagonal cross, ring, whole map. A shape letter the client uses and this code does
not know falls back to a circle, which over-estimates rather than misses.

### How a turn is chosen

**A cast is aimed at a cell, never at a fighter.** That is what lets an area spell catch two
monsters at once or reach one it may not target directly — the case in the screenshots where
*Flèche de Barrage* covers a group.

At every step the AI compares two things: **the best run of casts** it can make where it
stands, and what a step sideways would unlock. It then does whichever is worth more, and
repeats. So the movement points can be spent before the first spell, between two of them, or
not at all — whatever the turn is worth the most.

It weighs runs, not single casts, because the best next cast is often the wrong one: with
four action points, a four-point spell worth forty loses to two two-point spells worth sixty
together. A few sequences are played out and the best total wins.

### Statistics and resistances

A spell's printed damage is only a starting point. The AI reads the character's own
characteristics — strength, intelligence, chance, agility, the percentage bonus and the flat
ones — and each monster's **resistances**, then works out what a spell would really take off
**that** target: base × (1 + stat% + damage%) + flat, minus the target's percentage
resistance, minus its flat reduction.

So the choice follows the monster: the fire spell against something that resists earth, the
earth one against something that resists fire, even when the character's strength is far
higher. Anything the client does not expose counts as zero, which leaves the printed value
untouched rather than inventing a bonus.

A cast is scored on what it actually achieves:

- damage counted **only up to what the target has left**, so two spells are never both spent
  on a monster the first already kills;
- a heavy bonus when a cast finishes an enemy off;
- allies caught in the area cost several times the damage they take, and the caster costs
  more still;
- healing counts only the life actually missing;
- boosts come **before** the attacks while their cooldown allows and enough action points
  remain to still hit — a mastery lasting several turns is worth more than one extra cast —
  and are skipped entirely on the turn everything is going to die anyway;
- a boost that grants range is followed, within the same plan, by the casts it puts in
  reach — a buffed turn is planned as one move, not as a buff and then a shrug;
- walking is charged a little, so a move has to earn its points.

**Elements** ticks which damage the AI may use. A spell whose element the client does not
expose is never filtered out, so a gap in that reading cannot silently disable a spell.

The plan is redone **after every action**, from the points the game really reports. A boost
that grants action or movement points mid-turn is therefore used, and a fight that changes
under the AI — a monster dying, a push, new gear between fights — is taken into account
without any setting to adjust.

When nothing can be planned, the reason is written to the activity log — the spellbook could
not be read, every spell is filtered out by the chosen elements, everything is on cooldown,
no spell fits the action points left, or no cell brings an enemy in reach. The configured
combo is then played as a fallback, and a cast it aims further than the spell can reach is
skipped and reported rather than thrown at nothing.

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

What the automatic mode still does not do:

- **The manual combo is deliberately dumber.** It casts the list as written; ranges, areas
  and the Portée are honoured, but nothing is weighed. Switch **Spells** to *Choose from my
  spells* for the planner.
- **One turn at a time.** The plan is redone after every action from the points the game
  really reports, but nothing is held back for the turn after — no saving a mastery for a
  better moment, no keeping points for an escape.
- **Monsters are read, not predicted.** Their reach next turn is worked out from their
  movement points; what they will actually cast is not.
- **States and effects this code cannot name are left alone.** A spell whose effects are
  unrecognised is never cast by the planner, and is listed as such in the log rather than
  played blind.
- **Challenges are reported, never enforced.**
- **The AI does not look for fights**: pair it with the hunt script below to farm.

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

`pnpm test` runs four suites.

- **`test:scripts`** covers the controller against a stub game window: ready-up, combo
  order, target selection, passing the turn, ignoring other fighters' turns, the placement
  step, the model brain and its fallback, and doing nothing while disabled.
- **`test:main`** covers the local file server.
- **`test:fights`** plays whole fights out (below).
- **`test:combat`** hammers the combat core (below).

### Whole fights

`test:fights` runs the planner against monsters that behave differently — one that stands
still, one that closes in, one that runs faster than the character, a mixed group, a wall in
the way, and a turn with a single action point — plus a Crâ off the game's own spell sheets
against a group of Pious, with and without earth resistance. This file plays the part of the
server: it refuses what the game would refuse and records it, so a turn spending more action
points than it has, a spell thrown out of range or past a wall, or a character walking
through a monster fails the run.

It also checks the shape of the fight, not just its legality: the group is worked through,
the character never walks in circles without casting, and it never backs away from a fight
it cannot yet reach — which is how it used to end up in a corner.

### The combat core

`test:combat` checks each layer against an answer worked out independently of it, over
**generated fights** — three seeds by default, and `COMBAT_SEED=1234 pnpm test:combat`
replays any one of them.

| What | Checked against |
|------|-----------------|
| Range bands | a sweep of all 560 cells, 400 times a seed |
| Area shapes | every cell they cover, against the reach the aiming searches within |
| Walks | every reachable cell's path: adjacent steps, no walls, no fighters, cost = length |
| Aiming | an exhaustive search of every legal cell on the map, over ~180 arrangements a seed |
| Placement | a reference walk of the first turn's movement points, over ~170 offers a seed |
| The model's options | every offered cast re-checked for range, sight and cost |
| The model's answers | random and invented key lists — nothing illegal may come out |
| The mastery | cast, skipped, on cooldown, and with the setting off |
| Whole fights | 200 generated fights a seed, refereed action by action |
| Speed | a six-monster, eight-spell turn planned in under 100 ms |

The generated fights are the important ones: random walls, one to four monsters, one to
four spells with random shapes, costs, ranges, lines and cast limits, random statistics,
and six turns each. Anything the referee would refuse — a point overspent, a wall walked
through, a claimed hit that lands on nobody — fails the run and prints the seed to replay.
