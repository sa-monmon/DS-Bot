import assert from 'node:assert/strict'
import { test } from 'node:test'
import { indexRoster } from '../src/client/sources.js'

// The sidebar draws a subbot under the Bot that derived it and leaves it out of the
// flat list (#421). Both decisions come from two plain fields on the Bot record, so a
// roster as the host sends it answers them without a DOM.
const roster = value => indexRoster({ rooms: [], agents: [], sections: [], exchangeTurns: {}, questions: {}, ...value })

const team = () => roster({
  mainBotId: 'chief',
  mainBotIds: ['chief'],
  bots: [
    { id: 'chief', sessionId: 'chief', name: 'Chief', parts: [] },
    { id: 'writer', sessionId: 'writer', name: 'Writer', parts: [] },
    { id: 'fix', sessionId: 'fix', name: 'Fix', parentBotId: 'writer', parts: [] },
    { id: 'probe', sessionId: 'probe', name: 'Probe', parentBotId: 'writer', parts: [] },
    { id: 'lonely', sessionId: 'lonely', name: 'Lonely', parts: [] },
  ],
  prefs: {},
})

// The map the sidebar builds from the roster.
const subbotsOf = (bots) => {
  const map = {}
  for (const bot of bots) {
    if (bot.parentBotId === undefined) continue
    ;(map[bot.parentBotId] ??= []).push(bot)
  }
  return map
}

test('a subbot is listed under its parent, not in the flat list', () => {
  const value = team()
  const map = subbotsOf(value.bots)
  assert.deepEqual(map.writer.map(bot => bot.name), ['Fix', 'Probe'])
  assert.equal(map.chief, undefined)
  // The flat list keeps the Bot that derived them and every Bot nobody derived.
  const flat = value.bots.filter(bot => bot.id !== value.mainBotId && bot.parentBotId === undefined)
  assert.deepEqual(flat.map(bot => bot.name), ['Writer', 'Lonely'])
})

test('a Bot with no subbot draws no fold, and a subbot still resolves by every part', () => {
  const value = team()
  assert.equal(subbotsOf(value.bots).lonely, undefined)
  // A subbot's earlier parts resolve to it, so opening the fold shows the right Bot.
  const parts = { ...value.byId.fix, parts: ['fix-2'], sessionId: 'fix-1' }
  const wider = roster({ ...value, bots: value.bots.map(bot => (bot.id === 'fix' ? parts : bot)) })
  assert.equal(wider.byId['fix-2'].name, 'Fix')
  assert.equal(wider.byId['fix-1'].name, 'Fix')
})

test('the fold state is per parent and folded until the user opens it', () => {
  // A parent nobody folded has no entry, and the sidebar reads that as folded.
  const prefs = { subbotsOpen: { writer: true } }
  assert.equal(prefs.subbotsOpen.writer, true)
  assert.equal(prefs.subbotsOpen.chief, undefined)
})
