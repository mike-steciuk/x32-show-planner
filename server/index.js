import express from 'express'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { compilePlan, defaultPlan } from './planner.js'
import { MixerSimulator } from './simulator.js'
import { X32Bridge } from './osc.js'
import { createBandSlot, createId, loadStore, publicBandSlot, saveStore, slugify } from './store.js'
import { calculateEventGear, GEAR_TYPES, generateRunOfShow } from './gear.js'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const simulator = new MixerSimulator()
const bridge = new X32Bridge()
const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
let store = await loadStore()
let plan = structuredClone(defaultPlan)
let consoleState = simulator.state()
let lastSnapshot = null
const syncJobs = new Map()

const COLOR_NAMES = ['OFF', 'RD', 'GN', 'YE', 'BL', 'MG', 'CY', 'WH', 'OFF', 'RD', 'GN', 'YE', 'BL', 'MG', 'CY', 'WH']
const BASE_COLOR_VALUES = Object.fromEntries(COLOR_NAMES.slice(0, 8).map((name, index) => [name, index]))
const COLOR_VALUES = {
  ...BASE_COLOR_VALUES,
  ...Object.fromEntries(Object.entries(BASE_COLOR_VALUES).map(([name, index]) => [`${name}_INV`, index + 8]))
}
const EQ_TYPES = ['LCut', 'LShv', 'PEQ', 'VEQ', 'HShv', 'HCut']
const normalizedFrequency = value => 20 * Math.pow(1000, value)
const normalizedGain = value => -15 + 30 * value
const normalizedQ = value => 10 * Math.pow(.03, value)
const mixerValue = async path => (await bridge.request(path, 1000)).args[0]
const verifiedMixerValue = async path => (await bridge.request(path, 900)).args[0]
const now = () => new Date().toISOString()
const sceneNameForBand = name => (name || 'Untitled Band').trim().slice(0, 12)
const normalizeSceneStart = value => Math.max(0, Number(value ?? 0))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const LIVE_COMMAND_DELAY_MS = Number(process.env.X32_COMMAND_DELAY_MS ?? 50)
const LIVE_SAVE_SETTLE_MS = Number(process.env.X32_SAVE_SETTLE_MS ?? 2500)
const LIVE_VERIFY_DELAY_MS = Number(process.env.X32_VERIFY_DELAY_MS ?? 120)
const TEMPLATE_SCENE_NAME = 'TEMPLATE'
const templateName = () => String(store.settings?.templateSceneName || TEMPLATE_SCENE_NAME).slice(0, 12)

function publicSyncJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    label: job.label,
    eventId: job.eventId,
    slotId: job.slotId,
    inputId: job.inputId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result
  }
}

function createSyncJob({ type, label, eventId, slotId = null, inputId = null, work }) {
  const job = { id: createId('sync'), type, label, eventId, slotId, inputId, status: 'queued', createdAt: now(), startedAt: null, finishedAt: null, error: '', result: null }
  syncJobs.set(job.id, job)
  queueMicrotask(async () => {
    job.status = 'running'; job.startedAt = now(); broadcast('sync-job', publicSyncJob(job))
    try {
      job.result = await work()
      job.status = 'completed'
    } catch (error) {
      job.error = error.message
      job.status = 'failed'
    } finally {
      job.finishedAt = now()
      broadcast('sync-job', publicSyncJob(job))
      setTimeout(() => syncJobs.delete(job.id), 1000 * 60 * 60)
    }
  })
  return publicSyncJob(job)
}

function outgoingValue(path, value) {
  if (/\/config\/color$/.test(path) && typeof value === 'string') return COLOR_VALUES[value] ?? 0
  return value
}

function valuesMatch(expected, actual) {
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) < 0.0005
  return String(expected ?? '') === String(actual ?? '')
}

const blankLiveState = connected => ({
  mode: 'live',
  connected,
  host: store.settings?.mixerHost || '',
  model: connected ? 'X32' : 'Mixer offline',
  firmware: connected ? 'Unknown' : '',
  channels: Array.from({ length: 32 }, (_, index) => ({ number: index + 1, name: `Channel ${index + 1}`, color: 'OFF', icon: 1, level: 0, fader: 0, on: 0, eq: { on: false, bands: [] } })),
  buses: Array.from({ length: 16 }, (_, index) => ({ number: index + 1, name: `Bus ${index + 1}`, color: 'OFF', on: 0, fader: 0 })),
  main: { name: 'House PA', color: 'WH', on: 1, fader: 0.75 },
  parameters: {},
  userRouting: {}
})

async function connectMixer(host, saveHost = true) {
  const connected = await bridge.connect(host)
  if (saveHost) {
    store.settings ||= { mixerHost: '', autoConnectMixer: true }
    store.settings.mixerHost = host
    store.settings.autoConnectMixer = true
    await persist()
  }
  consoleState = {
    ...blankLiveState(true),
    host,
    model: connected.info[2] ?? 'X32',
    firmware: connected.info[3] ?? 'Unknown'
  }
  broadcast('console-state', consoleState)
  hydrateLiveConsole()
  return consoleState
}

async function saveLiveScene(slot, sceneName, note) {
  const args = ['scene', slot, sceneName, note]
  const attempts = []
  for (let attempt = 1; attempt <= 6; attempt++) {
    const responses = await bridge.collect('/save', 1800, args, null)
    const mapped = responses.map(message => ({ address: message.address, args: message.args }))
    attempts.push({ attempt, responses: mapped })
    const status = mapped.find(message => message.address === '/save' && message.args[0] === 'scene')?.args?.[1]
    if (status === 1) return { address: '/save', args, attempts, status }
    await wait(4000)
  }
  return { address: '/save', args, attempts, status: 0 }
}

async function recallLiveScene(slot) {
  const responses = await bridge.collect('/-action/goscene', 1800, slot, null)
  await wait(2200)
  return { address: '/-action/goscene', args: [slot], responses: responses.map(message => ({ address: message.address, args: message.args })) }
}

function templateSceneSlot() {
  return Math.max(0, Math.min(99, Number(store.settings?.templateSceneSlot ?? 99)))
}

function cleanTemplateCommands() {
  const commands = []
  for (let channel = 1; channel <= 32; channel++) {
    const ch = String(channel).padStart(2, '0')
    commands.push(
      { path: `/ch/${ch}/mix/on`, value: 0, section: 'Template clear' },
      { path: `/ch/${ch}/mix/fader`, value: 0, section: 'Template clear' },
      { path: `/ch/${ch}/config/name`, value: '', section: 'Template clear' },
      { path: `/ch/${ch}/config/color`, value: 'OFF', section: 'Template clear' },
      { path: `/ch/${ch}/config/icon`, value: 1, section: 'Template clear' },
      { path: `/ch/${ch}/eq/on`, value: 0, section: 'Template clear' },
      { path: `/ch/${ch}/gate/on`, value: 0, section: 'Template clear' },
      { path: `/ch/${ch}/dyn/on`, value: 0, section: 'Template clear' }
    )
    for (let send = 1; send <= 16; send++) {
      const bus = String(send).padStart(2, '0')
      commands.push(
        { path: `/ch/${ch}/mix/${bus}/on`, value: 0, section: 'Template clear' },
        { path: `/ch/${ch}/mix/${bus}/level`, value: 0, section: 'Template clear' }
      )
    }
  }
  for (let busIndex = 1; busIndex <= 16; busIndex++) {
    const bus = String(busIndex).padStart(2, '0')
    commands.push(
      { path: `/bus/${bus}/mix/on`, value: 0, section: 'Template clear' },
      { path: `/bus/${bus}/mix/fader`, value: 0, section: 'Template clear' },
      { path: `/bus/${bus}/config/name`, value: '', section: 'Template clear' },
      { path: `/bus/${bus}/config/color`, value: 'OFF', section: 'Template clear' }
    )
  }
  commands.push(
    { path: '/main/st/config/name', value: 'House PA', section: 'Template clear' },
    { path: '/main/st/config/color', value: 'WH', section: 'Template clear' },
    { path: '/main/st/mix/on', value: 1, section: 'Template clear' },
    { path: '/main/st/mix/fader', value: 0, section: 'Template clear' }
  )
  return commands.map(command => ({ ...command, changed: true }))
}

function clearUnusedVisibleBankCommands(inputCount, maxChannel = 8) {
  const commands = []
  for (let channel = inputCount + 1; channel <= maxChannel; channel++) {
    const ch = String(channel).padStart(2, '0')
    commands.push(
      { path: `/ch/${ch}/mix/on`, value: 0, section: 'Visible bank clear' },
      { path: `/ch/${ch}/mix/fader`, value: 0, section: 'Visible bank clear' },
      { path: `/ch/${ch}/config/name`, value: '', section: 'Visible bank clear' },
      { path: `/ch/${ch}/config/color`, value: 'OFF', section: 'Visible bank clear' },
      { path: `/ch/${ch}/config/icon`, value: 1, section: 'Visible bank clear' }
    )
    for (let send = 1; send <= 16; send++) {
      const bus = String(send).padStart(2, '0')
      commands.push(
        { path: `/ch/${ch}/mix/${bus}/on`, value: 0, section: 'Visible bank clear' },
        { path: `/ch/${ch}/mix/${bus}/level`, value: 0, section: 'Visible bank clear' }
      )
    }
  }
  return commands.map(command => ({ ...command, changed: true }))
}

function sceneMatches(name, expected) {
  return String(name ?? '').trim() === String(expected ?? '').trim()
}

function parseShowdumpScenes(messages) {
  const scenes = new Map()
  for (const message of messages) {
    const lines = message.args.flatMap(arg => String(arg ?? '').split(/\r?\n/))
    for (const line of lines) {
      const match = line.match(/\/-show\/showfile\/scene\/(\d+)\s+"([^"]*)"(?:\s+"([^"]*)")?/)
      if (!match) continue
      const slot = Number(match[1])
      scenes.set(slot, { slot, name: match[2], note: match[3] ?? '' })
    }
  }
  return scenes
}

async function validateLiveScene(slot, expectedName) {
  let lastError = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    const messages = await bridge.collect('/showdump', 2500, undefined, ['node', '/node'])
    const scenes = parseShowdumpScenes(messages)
    if (!messages.length) lastError = new Error(`X32 did not return /showdump data after saving scene ${slot} (${expectedName})`)
    else {
      const scene = scenes.get(slot)
      if (!scene) lastError = new Error(`Scene ${slot} was not found in /showdump after saving ${expectedName}`)
      else if (!sceneMatches(scene.name, expectedName)) lastError = new Error(`Scene ${slot} saved as "${scene.name}", expected "${expectedName}"`)
      else return scene
    }
    await wait(1000)
  }
  throw lastError
}

async function readLiveScenes() {
  const messages = await bridge.collect('/showdump', 2500, undefined, ['node', '/node'])
  return parseShowdumpScenes(messages)
}

async function bandSceneExists(slot) {
  if (consoleState.mode !== 'live') return true
  const scene = (await readLiveScenes()).get(slot.sceneSlot)
  return Boolean(scene && sceneMatches(scene.name, sceneNameForBand(slot.bandName)))
}

async function ensureBandSceneLoaded(event, slot) {
  if (consoleState.mode !== 'live') return { loaded: false, created: false }
  if (!(await bandSceneExists(slot))) {
    const created = await syncBandSlot(event, slot, { saveScene: true, useTemplate: store.settings?.useTemplateScene, skipEnsureLoaded: true })
    await recallLiveScene(slot.sceneSlot)
    return { loaded: true, created: true, createdScene: created }
  }
  const recallResult = await recallLiveScene(slot.sceneSlot)
  return { loaded: true, created: false, recallResult }
}

async function ensureTemplateScene() {
  if (consoleState.mode !== 'live' || !store.settings?.useTemplateScene) return { enabled: false }
  const slot = templateSceneSlot()
  const name = templateName()
  const current = (await readLiveScenes()).get(slot)
  if (current && sceneMatches(current.name, name)) {
    await recallLiveScene(slot)
    try {
      const verifiedBase = await verifyLiveChannelCommands(cleanTemplateCommands(), [])
      if (verifiedBase.verified === false) return { enabled: true, slot, name, created: false, verifiedBase }
      if (verifiedBase.verified && !verifiedBase.retries) return { enabled: true, slot, name, created: false, verifiedBase }
      await wait(3000)
      const saveResult = await saveLiveScene(slot, name, 'Clean template')
      if (saveResult.status !== 1) throw new Error(`X32 rejected /save for repaired template scene ${slot}: ${JSON.stringify(saveResult.attempts?.slice(-3) ?? [])}`)
      const verifiedScene = await validateLiveScene(slot, name)
      return { enabled: true, slot, name, created: false, repaired: true, verifiedBase, saveResult, verifiedScene }
    } catch {}
  }
  await applyCommands(cleanTemplateCommands())
  await wait(8000)
  const verifiedBase = await verifyLiveChannelCommands(cleanTemplateCommands(), [])
  await wait(3000)
  const saveResult = await saveLiveScene(slot, name, 'Clean template')
  if (saveResult.status !== 1) throw new Error(`X32 rejected /save for template scene ${slot}: ${JSON.stringify(saveResult.attempts?.slice(-3) ?? [])}`)
  const verifiedScene = await validateLiveScene(slot, name)
  return { enabled: true, slot, name, created: true, verifiedBase, saveResult, verifiedScene }
}

app.use(express.json({ limit: '2mb' }))
app.use(express.static('dist'))

const broadcast = (type, payload) => {
  const message = JSON.stringify({ type, payload })
  for (const client of wss.clients) if (client.readyState === 1) client.send(message)
}

const persist = async () => {
  await saveStore(store)
  broadcast('store-updated', { events: store.events.length, bands: store.bands.length })
}

const findEvent = id => store.events.find(event => event.id === id)
const findBand = id => store.bands.find(band => band.id === id)
const findIntake = token => {
  for (const event of store.events) {
    const slot = event.bands.find(candidate => candidate.intakeToken === token)
    if (slot) return { event, slot }
  }
  return null
}

async function readLiveChannel(number) {
  const ch = String(number).padStart(2, '0')
  const prefix = `/ch/${ch}`
  const paths = [`${prefix}/config/name`, `${prefix}/config/color`, `${prefix}/config/icon`, `${prefix}/mix/on`, `${prefix}/mix/fader`, `${prefix}/eq/on`]
  for (let band = 1; band <= 4; band++) paths.push(`${prefix}/eq/${band}/type`, `${prefix}/eq/${band}/f`, `${prefix}/eq/${band}/g`, `${prefix}/eq/${band}/q`)
  const values = []
  for (const path of paths) values.push(await mixerValue(path))
  const bands = []
  for (let band = 0; band < 4; band++) {
    const offset = 6 + band * 4
    bands.push({ type: typeof values[offset] === 'number' ? EQ_TYPES[values[offset]] : values[offset], f: normalizedFrequency(values[offset + 1]), g: normalizedGain(values[offset + 2]), q: normalizedQ(values[offset + 3]) })
  }
  const colorValue = values[1]
  const color = typeof colorValue === 'number' ? COLOR_NAMES[colorValue] : String(colorValue ?? 'OFF').replace(/_INV$/, '')
  const colorInverted = typeof colorValue === 'number' ? colorValue >= 8 : /_INV$/.test(String(colorValue ?? ''))
  return { number, name: values[0], color, colorInverted, icon: values[2], on: values[3], fader: values[4], level: 0, eq: { on: Boolean(values[5]), bands } }
}

async function hydrateLiveConsole(channelNumbers = Array.from({ length: 32 }, (_, index) => index + 1)) {
  for (const number of channelNumbers) {
    if (consoleState.mode !== 'live' || !consoleState.connected) break
    try {
      consoleState.channels[number - 1] = await readLiveChannel(number)
      broadcast('console-state', consoleState)
    } catch (error) { broadcast('error', `Channel ${number} refresh failed: ${error.message}`) }
  }
  return consoleState
}

async function verifyLiveChannelCommands(commands, inputs = []) {
  const channelNumbers = new Set([...inputs.map(input => input.channel), ...Array.from({ length: 8 }, (_, index) => index + 1)])
  const important = commands.filter(command => {
    const match = command.path.match(/^\/ch\/(\d{2})\/(?:config\/(?:name|color|icon)|mix\/(?:on|fader))$/)
    return match && channelNumbers.has(Number(match[1]))
  })
  const byPath = new Map(important.map(command => [command.path, command]))
  let failed = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    failed = []
    for (const command of byPath.values()) {
      const expected = outgoingValue(command.path, command.value)
      let actual
      try {
        actual = await verifiedMixerValue(command.path)
      } catch (error) {
        failed.push({ command, actual: error.message })
        continue
      }
      if (!valuesMatch(expected, actual)) failed.push({ command, actual })
      await wait(LIVE_VERIFY_DELAY_MS)
    }
    if (!failed.length) return { verified: true, checked: byPath.size, retries: attempt - 1 }
    for (const { command } of failed) {
      bridge.send(command.path, outgoingValue(command.path, command.value))
      await wait(LIVE_COMMAND_DELAY_MS)
    }
    await wait(700)
  }
  const mismatches = failed.filter(item => !String(item.actual).startsWith('No response from '))
  if (mismatches.length) throw new Error(`X32 reported ${mismatches.length} incorrect visible-bank channel settings: ${mismatches.slice(0, 8).map(item => `${item.command.path} expected ${JSON.stringify(outgoingValue(item.command.path, item.command.value))} got ${JSON.stringify(item.actual)}`).join('; ')}`)
  return { verified: false, checked: byPath.size, retries: 2, unconfirmed: failed.map(item => item.command.path) }
}

async function verifyLiveRoutingCommands(commands) {
  const important = commands.filter(command => /^\/config\/(?:routing|userrout)\//.test(command.path) || /^\/ch\/\d{2}\/config\/source$/.test(command.path))
  const byPath = new Map(important.map(command => [command.path, command]))
  let failed = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    failed = []
    for (const command of byPath.values()) {
      const expected = outgoingValue(command.path, command.value)
      let actual
      try {
        actual = await verifiedMixerValue(command.path)
      } catch (error) {
        failed.push({ command, actual: error.message })
        continue
      }
      if (!valuesMatch(expected, actual)) failed.push({ command, actual })
      await wait(LIVE_VERIFY_DELAY_MS)
    }
    if (!failed.length) return { verified: true, checked: byPath.size, retries: attempt - 1 }
    for (const { command } of failed) {
      bridge.send(command.path, outgoingValue(command.path, command.value))
      await wait(LIVE_COMMAND_DELAY_MS)
    }
    await wait(700)
  }
  const mismatches = failed.filter(item => !String(item.actual).startsWith('No response from '))
  if (mismatches.length) throw new Error(`X32 reported ${mismatches.length} incorrect routing settings: ${mismatches.slice(0, 8).map(item => `${item.command.path} expected ${JSON.stringify(outgoingValue(item.command.path, item.command.value))} got ${JSON.stringify(item.actual)}`).join('; ')}`)
  return { verified: false, checked: byPath.size, retries: 2, unconfirmed: failed.map(item => item.command.path) }
}

function isProcessingPath(path) {
  return /^\/ch\/\d{2}\/(?:preamp\/(?:hpon|hpf)|eq\/on|eq\/[1-4]\/(?:type|f|g|q)|gate\/(?:on|mode|thr|range|attack|hold|release)|dyn\/(?:on|mode|det|env|thr|ratio|knee|mgain|attack|hold|release|pos))$/.test(path)
}

async function verifyLiveProcessingCommands(commands, inputs = []) {
  const channelNumbers = new Set(inputs.map(input => input.channel))
  const important = commands.filter(command => {
    const match = command.path.match(/^\/ch\/(\d{2})\//)
    return match && channelNumbers.has(Number(match[1])) && isProcessingPath(command.path)
  }).slice(0, 8)
  const byPath = new Map(important.map(command => [command.path, command]))
  let failed = []
  for (let attempt = 1; attempt <= 1; attempt++) {
    failed = []
    for (const command of byPath.values()) {
      const expected = outgoingValue(command.path, command.value)
      let actual
      try {
        actual = await verifiedMixerValue(command.path)
      } catch (error) {
        failed.push({ command, actual: error.message })
        continue
      }
      if (!valuesMatch(expected, actual)) failed.push({ command, actual })
      await wait(LIVE_VERIFY_DELAY_MS)
    }
    if (!failed.length) return { verified: true, checked: byPath.size, retries: attempt - 1 }
    for (const { command } of failed) {
      bridge.send(command.path, outgoingValue(command.path, command.value))
      await wait(LIVE_COMMAND_DELAY_MS)
    }
    await wait(700)
  }
  const mismatches = failed.filter(item => !String(item.actual).startsWith('No response from '))
  if (mismatches.length) throw new Error(`X32 reported ${mismatches.length} incorrect processing settings: ${mismatches.slice(0, 8).map(item => `${item.command.path} expected ${JSON.stringify(outgoingValue(item.command.path, item.command.value))} got ${JSON.stringify(item.actual)}`).join('; ')}`)
  return { verified: false, checked: byPath.size, retries: 1, unconfirmed: failed.map(item => item.command.path) }
}

function applyOptimisticState(commands) {
  consoleState.parameters ||= {}
  consoleState.userRouting ||= {}
  for (const command of commands.filter(item => item.changed)) {
    consoleState.parameters[command.path] = command.value
    const config = command.path.match(/^\/ch\/(\d+)\/config\/(name|color|icon|source)$/)
    if (config && consoleState.channels[Number(config[1]) - 1]) consoleState.channels[Number(config[1]) - 1][config[2]] = command.value
    const channelMix = command.path.match(/^\/ch\/(\d+)\/mix\/(on|fader)$/)
    if (channelMix && consoleState.channels[Number(channelMix[1]) - 1]) consoleState.channels[Number(channelMix[1]) - 1][channelMix[2]] = command.value
    const route = command.path.match(/^\/config\/userrout\/in\/(\d+)$/)
    if (route) consoleState.userRouting[route[1]] = command.value
    const busConfig = command.path.match(/^\/bus\/(\d+)\/config\/(name|color)$/)
    if (busConfig && consoleState.buses?.[Number(busConfig[1]) - 1]) consoleState.buses[Number(busConfig[1]) - 1][busConfig[2]] = command.value
    const busMix = command.path.match(/^\/bus\/(\d+)\/mix\/(on|fader)$/)
    if (busMix && consoleState.buses?.[Number(busMix[1]) - 1]) consoleState.buses[Number(busMix[1]) - 1][busMix[2]] = command.value
    const mainConfig = command.path.match(/^\/main\/st\/config\/(name|color)$/)
    if (mainConfig) { consoleState.main ||= {}; consoleState.main[mainConfig[1]] = command.value }
    const mainMix = command.path.match(/^\/main\/st\/mix\/(on|fader)$/)
    if (mainMix) { consoleState.main ||= {}; consoleState.main[mainMix[1]] = command.value }
  }
}

async function applyCommands(commands) {
  const changed = commands.filter(item => item.changed)
  if (consoleState.mode === 'simulator') consoleState = simulator.apply(changed)
  else {
    for (const command of changed) {
      bridge.send(command.path, outgoingValue(command.path, command.value))
      await wait(LIVE_COMMAND_DELAY_MS)
    }
    await wait(LIVE_SAVE_SETTLE_MS)
    applyOptimisticState(changed)
  }
  return changed.length
}

simulator.on('state', state => { if (consoleState.mode === 'simulator') { consoleState = state; broadcast('console-state', state) } })
bridge.on('message', message => broadcast('osc-message', message))
bridge.on('error', error => broadcast('error', error.message))

app.get('/api/status', (_request, response) => response.json({ ok: true, console: { mode: consoleState.mode, connected: consoleState.connected, host: consoleState.host || store.settings?.mixerHost || '', model: consoleState.model, firmware: consoleState.firmware } }))

app.get('/api/events', (_request, response) => response.json(store.events.slice().sort((a, b) => b.date.localeCompare(a.date))))
app.post('/api/events', async (request, response) => {
  const event = { id: createId('event'), slug: slugify(request.body.name), name: request.body.name || 'Untitled event', date: request.body.date || new Date().toISOString().slice(0, 10), venue: request.body.venue || '', loadIn: request.body.loadIn || '', notes: request.body.notes || '', status: 'planning', sceneStart: normalizeSceneStart(request.body.sceneStart), outputPatches: { mainL: 'A1', mainR: 'A2' }, bands: [], house: { requirements: [] }, gear: { items: [] }, runOfShow: [], createdAt: now(), updatedAt: now() }
  store.events.push(event); await persist(); response.status(201).json(event)
})
app.get('/api/events/:id', (request, response) => { const event = findEvent(request.params.id); event ? response.json(event) : response.status(404).json({ error: 'Event not found' }) })
app.put('/api/events/:id', async (request, response) => {
  const event = findEvent(request.params.id)
  if (!event) return response.status(404).json({ error: 'Event not found' })
  Object.assign(event, request.body, { id: event.id, sceneStart: normalizeSceneStart(request.body.sceneStart ?? event.sceneStart), bands: request.body.bands ?? event.bands, updatedAt: now() }); await persist(); response.json(event)
})
app.post('/api/events/:id/bands', async (request, response) => {
  const event = findEvent(request.params.id)
  if (!event) return response.status(404).json({ error: 'Event not found' })
  let band = request.body.bandId ? findBand(request.body.bandId) : null
  if (!band) {
    band = { id: createId('band'), name: request.body.name || 'New band', contactName: '', contactEmail: '', notes: '', members: [], setups: [], createdAt: now(), updatedAt: now() }
    store.bands.push(band)
  }
  const slot = createBandSlot(band, event.sceneStart + event.bands.length)
  event.bands.push(slot); event.updatedAt = now(); await persist(); response.status(201).json(slot)
})
app.put('/api/events/:id/bands/:slotId', async (request, response) => {
  const event = findEvent(request.params.id); const slot = event?.bands.find(candidate => candidate.id === request.params.slotId)
  if (!slot) return response.status(404).json({ error: 'Band slot not found' })
  Object.assign(slot, request.body, { id: slot.id, intakeToken: slot.intakeToken }); event.updatedAt = now(); await persist(); response.json(slot)
})
app.delete('/api/events/:id/bands/:slotId', async (request, response) => {
  const event = findEvent(request.params.id)
  if (!event) return response.status(404).json({ error: 'Event not found' })
  event.bands = event.bands.filter(slot => slot.id !== request.params.slotId); event.bands.forEach((slot, index) => { slot.sceneSlot = event.sceneStart + index }); await persist(); response.status(204).end()
})

function compileBandSlot(event, slot, template = { enabled: false }, options = {}) {
  const compiled = compilePlan({ members: slot.members, monitors: slot.monitors, patches: slot.patches, channelOverrides: slot.channelOverrides, monitorPatches: slot.monitorPatches, outputPatches: event.outputPatches, clearUnused: Boolean(options.clearUnused) }, consoleState)
  if (!compiled.inputs.length) throw new Error(`${slot.bandName} has not submitted an input list`)
  if (compiled.warnings.length) throw new Error(`${slot.bandName} has incomplete input routing: ${compiled.warnings.join('; ')}`)
  if (template.enabled && options.clearVisibleBank) compiled.commands.push(...clearUnusedVisibleBankCommands(compiled.inputs.length))
  if (options.inputId) {
    const input = compiled.inputs.find(candidate => candidate.id === options.inputId)
    if (!input) throw new Error('Input channel not found in this artist setup')
    const ch = String(input.channel).padStart(2, '0')
    const routingBlock = input.channel <= 8 ? '/config/routing/IN/1-8' : input.channel <= 16 ? '/config/routing/IN/9-16' : input.channel <= 24 ? '/config/routing/IN/17-24' : '/config/routing/IN/25-32'
    compiled.commands = compiled.commands.filter(command => command.path.startsWith(`/ch/${ch}/`) || command.path === `/config/userrout/in/${ch}` || command.path === routingBlock)
    compiled.inputs = [input]
  }
  if (consoleState.mode === 'live') compiled.commands = compiled.commands.map(command => ({ ...command, changed: true }))
  return compiled
}

async function syncBandSlot(event, slot, options = {}) {
  const index = event.bands.findIndex(candidate => candidate.id === slot.id)
  if (index < 0) throw new Error('Band slot not found')
  slot.sceneSlot = event.sceneStart + index
  const sceneLoad = !options.saveScene && !options.skipEnsureLoaded ? await ensureBandSceneLoaded(event, slot) : null
  const template = options.template ?? (options.useTemplate ? await ensureTemplateScene() : { enabled: false })
  if (template.enabled && slot.sceneSlot === template.slot) throw new Error(`Scene ${template.slot} is reserved for the clean template scene`)
  if (options.saveScene && template.enabled && consoleState.mode === 'live') await recallLiveScene(template.slot)
  const compiled = compileBandSlot(event, slot, template, { clearUnused: options.saveScene && !template.enabled, clearVisibleBank: options.saveScene && template.enabled, inputId: options.inputId })
  await applyCommands(compiled.commands)
  const sceneName = sceneNameForBand(slot.bandName)
  const note = `${event.name} - ${event.date}`.slice(0, 64)
  let verifiedScene = null
  let recalledScene = null
  if (options.saveScene || options.persistScene) {
    verifiedScene = { slot: slot.sceneSlot, name: sceneName, note, verified: true }
    if (consoleState.mode === 'simulator') consoleState = simulator.saveScene(slot.sceneSlot, sceneName, note, slot.bandId)
    else {
      const verifiedChannels = await verifyLiveChannelCommands(compiled.commands, compiled.inputs)
      const verifiedRouting = await verifyLiveRoutingCommands(compiled.commands)
      const verifiedProcessing = await verifyLiveProcessingCommands(compiled.commands, compiled.inputs)
      const saveResult = await saveLiveScene(slot.sceneSlot, sceneName, note)
      try {
        if (saveResult.status !== 1) throw new Error(`X32 rejected /save for scene ${slot.sceneSlot} (${sceneName})`)
        verifiedScene = { ...await validateLiveScene(slot.sceneSlot, sceneName), saveResult, verifiedChannels, verifiedRouting, verifiedProcessing, verified: true }
      } catch (error) {
        const responseSummary = JSON.stringify(saveResult.attempts?.slice(-2) ?? [])
        throw new Error(`${error.message}; /save response: ${responseSummary}`)
      }
      if (options.saveScene) recalledScene = await recallLiveScene(slot.sceneSlot)
    }
    slot.syncedAt = now()
    if (options.saveScene) {
      const setup = { id: createId('setup'), eventId: event.id, eventName: event.name, date: event.date, sceneSlot: slot.sceneSlot, sceneName, verifiedScene, members: structuredClone(slot.members), patches: structuredClone(slot.patches), channelOverrides: structuredClone(slot.channelOverrides ?? {}), inputs: compiled.inputs, commandCount: compiled.commands.length, syncedAt: slot.syncedAt }
      const band = findBand(slot.bandId)
      if (band) { band.setups ||= []; band.setups.push(setup); band.updatedAt = now() }
    }
  }
  return { bandId: slot.bandId, bandName: slot.bandName, sceneName, sceneSlot: slot.sceneSlot, commandCount: compiled.commands.length, inputCount: compiled.inputs.length, mode: options.inputId ? 'input' : options.saveScene ? 'scene' : 'channels', sceneLoad, verifiedScene, recalledScene }
}

app.post('/api/events/:id/sync', async (request, response) => {
  const event = findEvent(request.params.id)
  if (!event) return response.status(404).json({ error: 'Event not found' })
  if (!event.bands.length) return response.status(409).json({ error: 'Add at least one band first' })
  event.sceneStart = normalizeSceneStart(event.sceneStart)
  if (event.sceneStart + event.bands.length > 100) return response.status(409).json({ error: 'The event would exceed X32 scene slot 99' })
  const job = createSyncJob({
    type: 'event',
    label: `Sync ${event.bands.length} scenes for ${event.name}`,
    eventId: event.id,
    work: async () => {
      lastSnapshot = structuredClone(consoleState)
      const scenes = []
      const template = await ensureTemplateScene()
      if (template.enabled && event.bands.some((_, index) => event.sceneStart + index === template.slot)) throw new Error(`Scene ${template.slot} is reserved for the clean template scene`)
      for (const slot of event.bands) scenes.push(await syncBandSlot(event, slot, { saveScene: true, template }))
      event.status = 'synced'; event.lastSyncedAt = now(); event.updatedAt = now(); await persist(); broadcast('console-state', consoleState)
      return { eventId: event.id, template, scenes }
    }
  })
  response.status(202).json({ job })
})

app.post('/api/events/:id/bands/:slotId/sync', async (request, response) => {
  const event = findEvent(request.params.id); const slot = event?.bands.find(candidate => candidate.id === request.params.slotId)
  if (!slot) return response.status(404).json({ error: 'Band slot not found' })
  event.sceneStart = normalizeSceneStart(event.sceneStart)
  const saveScene = request.body.mode !== 'channels'
  const job = createSyncJob({
    type: saveScene ? 'artist-scene' : 'artist-channels',
    label: `${saveScene ? 'Sync scene' : 'Apply channels'} for ${slot.bandName}`,
    eventId: event.id,
    slotId: slot.id,
    work: async () => {
      lastSnapshot = structuredClone(consoleState)
      const result = await syncBandSlot(event, slot, { saveScene, persistScene: !saveScene, useTemplate: saveScene && store.settings?.useTemplateScene })
      if (saveScene) { event.status = 'synced'; event.lastSyncedAt = now() }
      event.updatedAt = now(); await persist(); broadcast('console-state', consoleState)
      return { eventId: event.id, result }
    }
  })
  response.status(202).json({ job })
})

app.post('/api/events/:id/bands/:slotId/inputs/:inputId/sync', async (request, response) => {
  const event = findEvent(request.params.id); const slot = event?.bands.find(candidate => candidate.id === request.params.slotId)
  if (!slot) return response.status(404).json({ error: 'Band slot not found' })
  event.sceneStart = normalizeSceneStart(event.sceneStart)
  const job = createSyncJob({
    type: 'input-channel',
    label: `Apply one channel for ${slot.bandName}`,
    eventId: event.id,
    slotId: slot.id,
    inputId: request.params.inputId,
    work: async () => {
      lastSnapshot = structuredClone(consoleState)
      const result = await syncBandSlot(event, slot, { saveScene: false, persistScene: true, useTemplate: false, inputId: request.params.inputId })
      event.updatedAt = now(); await persist(); broadcast('console-state', consoleState)
      return { eventId: event.id, result }
    }
  })
  response.status(202).json({ job })
})

app.get('/api/sync-jobs/:id', (request, response) => {
  const job = syncJobs.get(request.params.id)
  job ? response.json(publicSyncJob(job)) : response.status(404).json({ error: 'Sync job not found' })
})

app.get('/api/events/:id/gear', (request, response) => { const event = findEvent(request.params.id); event ? response.json(calculateEventGear(event, store.inventory)) : response.status(404).json({ error: 'Event not found' }) })
app.put('/api/events/:id/gear', async (request, response) => { const event = findEvent(request.params.id); if (!event) return response.status(404).json({ error: 'Event not found' }); event.gear = { items: request.body.items ?? [] }; event.updatedAt = now(); await persist(); response.json(calculateEventGear(event, store.inventory)) })
app.post('/api/events/:id/run-of-show/generate', async (request, response) => { const event = findEvent(request.params.id); if (!event) return response.status(404).json({ error: 'Event not found' }); event.runOfShow = generateRunOfShow(event, store.inventory); event.updatedAt = now(); await persist(); response.json(event.runOfShow) })
app.put('/api/events/:id/run-of-show', async (request, response) => { const event = findEvent(request.params.id); if (!event) return response.status(404).json({ error: 'Event not found' }); event.runOfShow = request.body.steps ?? []; event.updatedAt = now(); await persist(); response.json(event.runOfShow) })

app.get('/api/bands', (_request, response) => response.json(store.bands.slice().sort((a, b) => a.name.localeCompare(b.name))))
app.post('/api/bands', async (request, response) => {
  const band = { id: createId('band'), name: request.body.name || 'New band', contactName: request.body.contactName || '', contactEmail: request.body.contactEmail || '', notes: request.body.notes || '', members: request.body.members || [], setups: [], createdAt: now(), updatedAt: now() }
  store.bands.push(band); await persist(); response.status(201).json(band)
})
app.get('/api/bands/:id', (request, response) => { const band = findBand(request.params.id); band ? response.json(band) : response.status(404).json({ error: 'Band not found' }) })
app.put('/api/bands/:id', async (request, response) => { const band = findBand(request.params.id); if (!band) return response.status(404).json({ error: 'Band not found' }); Object.assign(band, request.body, { id: band.id, setups: band.setups, updatedAt: now() }); await persist(); response.json(band) })

app.get('/api/inventory/types', (_request, response) => response.json(GEAR_TYPES))
app.get('/api/inventory', (_request, response) => response.json(store.inventory.slice().sort((a, b) => a.name.localeCompare(b.name))))
app.post('/api/inventory', async (request, response) => { const item = { id: createId('gear'), name: request.body.name || 'Unnamed item', type: request.body.type || 'other', quantity: Math.max(0, Number(request.body.quantity || 0)), length: request.body.length || '', notes: request.body.notes || '', createdAt: now(), updatedAt: now() }; store.inventory.push(item); await persist(); response.status(201).json(item) })
app.put('/api/inventory/:id', async (request, response) => { const item = store.inventory.find(candidate => candidate.id === request.params.id); if (!item) return response.status(404).json({ error: 'Inventory item not found' }); Object.assign(item, request.body, { id: item.id, quantity: Math.max(0, Number(request.body.quantity || 0)), updatedAt: now() }); await persist(); response.json(item) })
app.delete('/api/inventory/:id', async (request, response) => { const exists = store.inventory.some(item => item.id === request.params.id); if (!exists) return response.status(404).json({ error: 'Inventory item not found' }); store.inventory = store.inventory.filter(item => item.id !== request.params.id); for (const event of store.events) event.gear.items = event.gear.items.filter(item => item.inventoryId !== request.params.id); await persist(); response.status(204).end() })

app.get('/api/intake/:token', (request, response) => { const found = findIntake(request.params.token); found ? response.json(publicBandSlot(found.event, found.slot)) : response.status(404).json({ error: 'This intake link is invalid or expired' }) })
app.put('/api/intake/:token', async (request, response) => {
  const found = findIntake(request.params.token)
  if (!found) return response.status(404).json({ error: 'This intake link is invalid or expired' })
  Object.assign(found.slot, { contactName: request.body.contactName || '', contactEmail: request.body.contactEmail || '', members: request.body.members || [], monitors: request.body.monitors || [], notes: request.body.notes || '', intakeStatus: 'submitted', submittedAt: now() })
  const band = findBand(found.slot.bandId)
  if (band) Object.assign(band, { contactName: found.slot.contactName, contactEmail: found.slot.contactEmail, members: structuredClone(found.slot.members), monitors: structuredClone(found.slot.monitors ?? []), notes: found.slot.notes, updatedAt: now() })
  found.event.updatedAt = now(); await persist(); response.json(publicBandSlot(found.event, found.slot))
})

app.get('/api/plan', (_request, response) => response.json(plan))
app.put('/api/plan', (request, response) => { plan = request.body; response.json(plan) })
app.post('/api/plan/compile', (request, response) => response.json(compilePlan(request.body ?? plan, consoleState)))
app.get('/api/console/state', (_request, response) => response.json({ ...consoleState, host: consoleState.host || store.settings?.mixerHost || '', settings: store.settings }))
app.get('/api/console/scenes', async (_request, response) => {
  try {
    if (consoleState.mode !== 'live' || !consoleState.connected) return response.json({ mode: consoleState.mode, scenes: consoleState.scenes ?? [] })
    const messages = await bridge.collect('/showdump', 2500, undefined, ['node', '/node'])
    response.json({ messages: messages.length, scenes: Array.from(parseShowdumpScenes(messages).values()).sort((a, b) => a.slot - b.slot) })
  } catch (error) { response.status(500).json({ error: error.message }) }
})
app.put('/api/settings', async (request, response) => {
  store.settings ||= {}
  if (request.body.mixerHost !== undefined) store.settings.mixerHost = String(request.body.mixerHost)
  if (request.body.autoConnectMixer !== undefined) store.settings.autoConnectMixer = Boolean(request.body.autoConnectMixer)
  if (request.body.useTemplateScene !== undefined) store.settings.useTemplateScene = Boolean(request.body.useTemplateScene)
  if (request.body.templateSceneSlot !== undefined) store.settings.templateSceneSlot = Math.max(0, Math.min(99, Number(request.body.templateSceneSlot)))
  if (request.body.templateSceneName !== undefined) store.settings.templateSceneName = String(request.body.templateSceneName || TEMPLATE_SCENE_NAME).slice(0, 12)
  await persist()
  response.json(store.settings)
})
app.post('/api/console/template-scene', async (request, response) => {
  try {
    if (consoleState.mode !== 'live' || !consoleState.connected) return response.status(409).json({ error: 'Connect a live X32 first' })
    if (request.body.slot !== undefined || request.body.name !== undefined) {
      store.settings ||= {}
      if (request.body.slot !== undefined) store.settings.templateSceneSlot = Math.max(0, Math.min(99, Number(request.body.slot)))
      if (request.body.name !== undefined) store.settings.templateSceneName = String(request.body.name || TEMPLATE_SCENE_NAME).slice(0, 12)
      await persist()
    }
    response.json(await ensureTemplateScene())
  } catch (error) { response.status(500).json({ error: error.message }) }
})
app.post('/api/console/mode', (request, response) => { if (request.body.mode === 'simulator') { bridge.close(); consoleState = { ...simulator.state(), host: store.settings?.mixerHost || '', settings: store.settings } }; response.json(consoleState) })
app.post('/api/console/connect', async (request, response) => {
  try {
    response.json(await connectMixer(request.body.host))
  } catch (error) { consoleState = { ...blankLiveState(false), host: request.body.host || store.settings?.mixerHost || '', autoConnectError: error.message }; response.status(504).json({ error: error.message }) }
})
app.post('/api/console/refresh', async (request, response) => { if (consoleState.mode !== 'live' || !consoleState.connected) return response.status(409).json({ error: 'Connect a live X32 first' }); response.json(await hydrateLiveConsole(request.body.channels?.length ? request.body.channels : undefined)) })
app.post('/api/console/apply', async (request, response) => { const commands = request.body.commands ?? []; if (request.body.dryRun) return response.json({ dryRun: true, count: commands.filter(item => item.changed).length }); lastSnapshot = structuredClone(consoleState); try { const applied = await applyCommands(commands); response.json({ applied, snapshotAvailable: true, state: consoleState }) } catch (error) { response.status(500).json({ error: error.message }) } })
app.post('/api/console/rollback', (_request, response) => { if (!lastSnapshot) return response.status(409).json({ error: 'No snapshot is available' }); if (consoleState.mode === 'simulator') { consoleState = lastSnapshot; simulator.channels = structuredClone(lastSnapshot.channels); simulator.buses = structuredClone(lastSnapshot.buses ?? simulator.buses); simulator.main = structuredClone(lastSnapshot.main ?? simulator.main); simulator.userRouting = structuredClone(lastSnapshot.userRouting ?? {}); simulator.parameters = structuredClone(lastSnapshot.parameters ?? {}); simulator.scenes = structuredClone(lastSnapshot.scenes ?? []); broadcast('console-state', consoleState) }; response.json({ rolledBack: true, state: consoleState }) })

app.get('*path', (_request, response) => response.sendFile('index.html', { root: distDirectory }))

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Stop the existing server or set a different PORT.`)
  else console.error(error)
  process.exit(1)
})
server.listen(port, host, () => {
  console.log(`The Ferndale Set production API listening on http://${host}:${port}`)
  const savedHost = store.settings?.mixerHost
  if (store.settings?.autoConnectMixer && savedHost) {
    connectMixer(savedHost, false)
      .then(() => console.log(`Auto-connected to X32 at ${savedHost}`))
      .catch(error => {
        console.warn(`X32 auto-connect to ${savedHost} failed: ${error.message}`)
        consoleState = { ...simulator.state(), host: savedHost, settings: store.settings, autoConnectError: error.message }
      })
  }
})
