import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePlan, defaultPlan, expandInputs, stageSockets } from '../server/planner.js'

test('expands the default band and puts vocals first', () => {
  const inputs = expandInputs(defaultPlan)
  assert.equal(inputs.length, 12)
  assert.equal(inputs[0].kind, 'vocal')
  assert.equal(inputs[1].kind, 'vocal')
  assert.equal(inputs.find(item => item.kind === 'guitar').color, 'CY')
  assert.equal(inputs.find(item => item.kind === 'bass').color, 'WH')
  assert.deepEqual(inputs.filter(item => item.kind === 'drums').map(item => item.label), ['Kick', 'Snare', 'Rack Tom', 'Floor Tom', 'OH Left', 'OH Right'])
})

test('models local X32 inputs and two daisy-chained SD8s on AES50-A', () => {
  const sockets = stageSockets()
  assert.equal(sockets.length, 48)
  assert.deepEqual(sockets.find(socket => socket.id === 'L1'), { id: 'L1', label: 'X32 Local · IN 1', group: 'X32 Local', physical: 1, source: 0 })
  assert.deepEqual(sockets.find(socket => socket.id === 'A9'), { id: 'A9', label: 'SD8-2 · IN 1', group: 'AES50-A / SD8', aes50: 9, headamp: 40, source: 40 })
})

test('compiles reviewable commands without phantom power', () => {
  const plan = structuredClone(defaultPlan)
  expandInputs(plan).forEach((item, index) => { plan.patches[item.id] = `A${index + 1}` })
  const result = compilePlan(plan, { channels: [] })
  assert.equal(result.warnings.length, 0)
  assert.ok(result.commands.some(command => command.path === '/ch/01/config/color' && command.value === 'GN'))
  assert.ok(result.commands.some(command => command.path === '/config/userrout/in/01' && command.value === 32))
  assert.equal(result.commands.some(command => command.path.includes('phantom')), false)
})

test('routes local X32 inputs as physical input choices', () => {
  const plan = structuredClone(defaultPlan)
  plan.patches[expandInputs(plan)[0].id] = 'L1'
  const result = compilePlan(plan, { channels: [] })
  assert.ok(result.commands.some(command => command.path === '/config/userrout/in/01' && command.value === 0 && command.note === 'X32 Local · IN 1 → CH 01'))
  assert.ok(result.commands.some(command => command.path === '/ch/01/config/source' && command.value === 1))
})

test('requires every input to have physical routing before sync', () => {
  const plan = structuredClone(defaultPlan)
  const firstInput = expandInputs(plan)[0]
  plan.patches[firstInput.id] = 'A1'
  const result = compilePlan(plan, { channels: [] })
  assert.ok(result.warnings.length > 0)
  assert.ok(result.warnings.every(warning => !warning.includes(firstInput.label)))
})

test('clears unused faders, scribble strips, and bus sends', () => {
  const plan = structuredClone(defaultPlan)
  expandInputs(plan).forEach((item, index) => { plan.patches[item.id] = `A${index + 1}` })
  plan.clearUnused = true
  const result = compilePlan(plan, { channels: [] })
  const firstUnused = String(result.inputs.length + 1).padStart(2, '0')
  assert.ok(result.commands.some(command => command.path === `/ch/${firstUnused}/mix/on` && command.value === 0))
  assert.ok(result.commands.some(command => command.path === `/ch/${firstUnused}/mix/fader` && command.value === 0))
  assert.ok(result.commands.some(command => command.path === `/ch/${firstUnused}/config/name` && command.value === ''))
  assert.ok(result.commands.some(command => command.path === `/ch/${firstUnused}/config/color` && command.value === 'OFF'))
  assert.ok(result.commands.some(command => command.path === `/ch/${firstUnused}/mix/01/on` && command.value === 0))
  assert.ok(result.commands.some(command => command.path === `/ch/${firstUnused}/mix/16/level` && command.value === 0))
})

test('creates main PA and monitor bus commands', () => {
  const plan = structuredClone(defaultPlan)
  expandInputs(plan).forEach((item, index) => { plan.patches[item.id] = `A${index + 1}` })
  const result = compilePlan(plan, { channels: [] })
  assert.equal(result.outputs.mains[0].label, 'Main LR · House PA')
  assert.ok(result.outputs.monitors.length > 0)
  assert.ok(result.commands.some(command => command.path === '/main/st/config/name' && command.value === 'House PA'))
  assert.ok(result.commands.some(command => command.path === '/bus/01/config/name'))
  assert.ok(result.commands.some(command => command.path === '/bus/01/mix/fader' && command.value > 0))
  assert.ok(result.commands.some(command => command.path === '/ch/01/mix/01/level' && command.value > 0))
})

test('expands multiple instruments owned by one performer into separate inputs', () => {
  const plan = { members: [{ id: 'alex', name: 'Alex', vocal: true, monitor: 'wedge', sources: [
    { id: 'electric', label: 'Tele', instrument: 'guitar', connection: 'amp mic' },
    { id: 'acoustic', label: 'Acoustic', instrument: 'guitar', connection: 'DI' },
    { id: 'keys', label: 'Nord', instrument: 'keys', connection: 'stereo DI' }
  ] }] }
  const inputs = expandInputs(plan)
  assert.deepEqual(inputs.map(item => item.label), ['Alex Vox', 'Tele', 'Acoustic', 'Nord L', 'Nord R'])
  assert.equal(new Set(inputs.map(item => item.id)).size, inputs.length)
})

test('applies workspace channel labels, colors, and order overrides', () => {
  const plan = { members: [{ id: 'sam', name: 'Sam', vocal: true, monitor: 'wedge', sources: [{ id: 'bass', label: 'Bass DI', instrument: 'bass', connection: 'DI' }] }], patches: {}, channelOverrides: {
    'sam-vocal': { label: 'Lead Vox', color: 'RD', invert: true, order: 2 },
    'sam-bass-bass': { label: 'P Bass', color: 'WH', order: 1 }
  } }
  const result = compilePlan(plan, { channels: [] })
  assert.equal(result.inputs[0].label, 'P Bass')
  assert.equal(result.inputs[0].color, 'WH')
  assert.equal(result.inputs[1].label, 'Lead Vox')
  assert.equal(result.inputs[1].color, 'RD')
  assert.equal(result.inputs[1].invert, true)
  assert.ok(result.commands.some(command => command.path === '/ch/02/config/color' && command.value === 'RD_INV'))
})
