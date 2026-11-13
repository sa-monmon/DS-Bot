import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

// A team with one Main Bot and one ordinary Bot, enough for subbot derivation (#421).
const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

function start(seed = team(), { models = ['deepseek-v4-flash'], folders = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-subbot-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  // The approval service is mounted so a folder outside the team workspace can be
  // granted the way the real host grants it.
  const ctx = fakeContext({ services: { approval: fakeApproval() } })
  const agents = new Map()
  const sent = []
  const archived = []
  let sessions = 0
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId },
        id: sessionId,
        followup: message => sent.push({ sessionId, message }),
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => (models.length > 0 ? [{ id: 'deepseek', name: 'DeepSeek' }] : []),
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async () => ({}),
      resolveModelInfoFor: async () => undefined,
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async path => folders.find(folder => folder.path === path),
      create: async path => {
        const workspace = { id: `w-${path}`, path }
        folders.push(workspace)
        return workspace
      },
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  // A real exec carries the Agent, whose Session the folder approval reads.
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: `${name}-${sessionId}-${Date.now()}` })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, tool, sent, archived, agents, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}

test('a Bot derives a subbot that reports to it instead of greeting the user', async (t) => {
  const { rt, tool, sent, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'a')

  const out = await tool('create_subbot', { role: 'Work', task: 'Fix the failing test in branch hotfix.' }, 'b')
  assert.match(out, /Derived Writer-work\./)
  assert.match(out, /result comes back to you as a reply/)

  const sub = Object.values(rt.state.bots).find(bot => bot.parentBotId === 'b')
  assert.equal(sub.role, 'Work')
  assert.equal(sub.createdBy, 'b')

  // The first message is the parent's work, not a greeting to the user, and it says who
  // is being reported to.
  await until(() => sent.some(entry => entry.sessionId === sub.id))
  const first = sent.find(entry => entry.sessionId === sub.id)
  assert.equal(first.message.source.role, 'request')
  assert.equal(first.message.source.senderSessionId, 'b')
  const text = first.message.content[0].text
  assert.match(text, /derived by Writer/)
  assert.match(text, /Fix the failing test in branch hotfix\./)
  assert.doesNotMatch(text, /Greet the user/)
  assert.match(text, /Do not greet the user/)
})

test('without a task the subbot waits for work and says so', async (t) => {
  const { rt, tool, sent, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'a')

  const out = await tool('create_subbot', { role: 'Work' }, 'b')
  assert.match(out, /waits for work/)

  const sub = Object.values(rt.state.bots).find(bot => bot.parentBotId === 'b')
  await until(() => sent.some(entry => entry.sessionId === sub.id))
  const first = sent.find(entry => entry.sessionId === sub.id)
  assert.equal(first.message.source.role, 'kickoff')
  assert.match(first.message.content[0].text, /Report to Writer/)
  assert.doesNotMatch(first.message.content[0].text, /Greet the user/)
})

test('a subbot derives none of its own, and a parent may have at most four', async (t) => {
  const { rt, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'a')

  await tool('create_subbot', { name: 'One', role: 'Work' }, 'b')
  const sub = rt.findBot('One')
  assert.equal(sub.parentBotId, 'b')
  assert.match(await tool('create_subbot', { name: 'Nested', role: 'Work' }, sub.id), /is itself a subbot/)

  // The cap counts the active subbots of that parent only.
  for (const name of ['Two', 'Three', 'Four']) {
    assert.match(await tool('create_subbot', { name, role: 'Work' }, 'b'), /Derived /)
  }
  assert.match(await tool('create_subbot', { name: 'Five', role: 'Work' }, 'b'), /already has 4 subbots/)
  // Another Bot is not affected by Writer's cap.
  assert.match(await tool('create_subbot', { name: 'Other', role: 'Work' }, 'a'), /Derived /)
})

test('reclaim keeps the working folder unless it is asked to delete it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-subbot-work-'))
  const kept = join(dir, 'kept')
  const gone = join(dir, 'gone')
  mkdirSync(kept)
  mkdirSync(gone)
  const { rt, tool, archived, stop } = start()
  t.after(stop)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await tool('list_bots', {}, 'a')
  rt.state.workspaceId = (await rt.ensureWorkspace())

  const a = await tool('create_subbot', { name: 'Keep', role: 'Work', work_dir: kept }, 'b')
  assert.match(a, /working in /)
  const b = await tool('create_subbot', { name: 'Drop', role: 'Work', work_dir: gone }, 'b')
  assert.match(b, /working in /)

  const keptOut = await tool('reclaim_subbot', { bot: 'Keep' }, 'b')
  assert.match(keptOut, /Reclaimed Keep/)
  assert.match(keptOut, /is kept with its branch/)
  assert.equal(rt.findBot('Keep'), undefined)
  assert.deepEqual(archived.map(([id]) => id).includes(rt.state.bots.Keep?.id), false)

  const dropOut = await tool('reclaim_subbot', { bot: 'Drop', remove_worktree: true }, 'b')
  assert.match(dropOut, /was deleted/)
  assert.equal(rt.findBot('Drop'), undefined)
})

test('only the parent or a Main Bot reclaims a subbot, and a plain Bot is not one', async (t) => {
  const { rt, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'a')
  rt.state.workspaceId = await rt.ensureWorkspace()
  await tool('create_subbot', { name: 'Child', role: 'Work' }, 'b')

  // Writer may not reclaim its sibling; only its own subbot and the Main Bot may.
  const other = await tool('create_subbot', { name: 'Sibling', role: 'Work' }, 'a')
  assert.match(other, /Derived /)
  assert.match(await tool('reclaim_subbot', { bot: 'Sibling' }, 'b'), /only it or a Main Bot/)
  assert.match(await tool('reclaim_subbot', { bot: 'Chief' }, 'b'), /is not a subbot/)
  assert.match(await tool('reclaim_subbot', { bot: 'Sibling' }, 'a'), /Reclaimed Sibling/)
})

test('stop_bot reaches a Bot\'s own subbot only', async (t) => {
  const { rt, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'a')
  rt.state.workspaceId = await rt.ensureWorkspace()
  await tool('create_subbot', { name: 'Worker', role: 'Work' }, 'b')

  // Nothing is running yet, so the refusal is about running, not about rights.
  let out
  try {
    out = await tool('stop_bot', { bot: 'Worker' }, 'b')
  } catch (error) {
    out = error.message
  }
  assert.match(out, /is not running right now/)

  // A non-Main Bot still may not stop a Bot that is not its subbot.
  try {
    out = await tool('stop_bot', { bot: 'Chief' }, 'b')
  } catch (error) {
    out = error.message
  }
  assert.match(out, /Only a Main Bot can stop other Bots/)
})

test('deleting a Bot carries its subbots, and a Bot that lost its parent is promoted', async (t) => {
  const { rt, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'a')
  rt.state.workspaceId = await rt.ensureWorkspace()
  await tool('create_subbot', { name: 'Carried', role: 'Work' }, 'b')

  await rt.deleteBot('b')
  assert.equal(rt.state.bots.b, undefined)
  assert.equal(Object.values(rt.state.bots).some(bot => bot.parentBotId === 'b'), false)

  // A record whose parent is not in the team loses the link instead of the Bot.
  const orphan = start({
    ...team(),
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      c: { id: 'c', name: 'Leftover', role: 'Work', sessionId: 'c', createdAt: 2, parentBotId: 'gone' },
    },
  })
  t.after(orphan.stop)
  await orphan.tool('list_bots', {}, 'a')
  assert.equal(orphan.rt.state.bots.c.parentBotId, undefined)
})

test('list_bots names who derived a subbot', async (t) => {
  const { rt, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'a')
  rt.state.workspaceId = await rt.ensureWorkspace()
  await tool('create_subbot', { name: 'Tea', role: 'Work' }, 'b')
  const out = await tool('list_bots', {}, 'a')
  assert.match(out, /Tea \(Work, model [^,]+, derived by Writer\)/)
})
