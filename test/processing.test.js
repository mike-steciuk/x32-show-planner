import test from 'node:test'
import assert from 'node:assert/strict'
import { processingCommands, processingPreset } from '../server/processing.js'

test('creates conservative instrument-aware starting processing', () => {
  const vocal = processingPreset({ kind: 'vocal', label: 'Lead Vox' })
  const kick = processingPreset({ kind: 'drums', label: 'Kick' })
  assert.equal(vocal.eq.hpf, 100)
  assert.equal(vocal.gate.on, false)
  assert.equal(kick.gate.on, true)
  assert.equal(kick.compressor.ratio, '4.0')
  const commands = processingCommands(1, vocal)
  assert.ok(commands.length >= 38)
  assert.ok(commands.every(command => typeof command.value === 'string' || (command.value >= 0 && command.value <= 1)))
  assert.equal(commands.some(command => command.path.includes('phantom')), false)
})
