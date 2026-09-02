/**
 * The combat core.
 *
 * Six pieces, each answering one question and none of them talking to the
 * game twice:
 *
 * - `geometry`   — the map: what is walkable, what sees what, how far a walk
 *                  reaches. Cached for as long as the fight has not moved.
 * - `battlefield`— who stands where, with what life and what resistances.
 * - `spellbook`  — every spell the character owns and whether it may be cast
 *                  right now, at what price, and why not when it may not.
 * - `aiming`     — where a spell may legally be thrown, and what each of
 *                  those cells would cover. A cast is aimed at a cell, never
 *                  at a fighter: that is what lets one area catch three.
 * - `evaluate`   — what a cast is worth against these monsters, and what the
 *                  fight looks like once it has landed.
 * - `planner`    — the turn itself, as a sequence of moves and casts.
 *
 * Two things are built on top: `placement` chooses the cell the fight starts
 * on, and `snapshot`/`prompt` write the same information out for a local
 * model to pick from.
 */

export { readSpellCatalogue, readRangeBonus } from '../spell-catalogue'
export type { SpellDetails, SpellEffect } from '../spell-catalogue'
export { readDamageProfile, readResistances, damageAgainst, damageWith } from '../damage'
export { zoneShapeOf } from '../zones'

export * from './geometry'
export * from './battlefield'
export * from './spellbook'
export * from './aiming'
export * from './evaluate'
export * from './planner'
export * from './placement'
export * from './snapshot'
export * from './prompt'
