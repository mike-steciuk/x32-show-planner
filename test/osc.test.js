import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeMessage, encodeMessage } from '../server/osc.js'

test('encodes and decodes X32 OSC values', () => {
  assert.deepEqual(decodeMessage(encodeMessage('/ch/01/config/name', 'Amy Vox')), { address: '/ch/01/config/name', args: ['Amy Vox'] })
  assert.deepEqual(decodeMessage(encodeMessage('/ch/01/config/icon', 8)), { address: '/ch/01/config/icon', args: [8] })
  const float = decodeMessage(encodeMessage('/ch/01/eq/1/f', .25))
  assert.equal(float.address, '/ch/01/eq/1/f')
  assert.ok(Math.abs(float.args[0] - .25) < .00001)
  assert.deepEqual(decodeMessage(encodeMessage('/ch/01/mix/fader', 0)), { address: '/ch/01/mix/fader', args: [0] })
  assert.deepEqual(decodeMessage(encodeMessage('/save', ['scene', 4, 'Band Name', 'Event note'])), { address: '/save', args: ['scene', 4, 'Band Name', 'Event note'] })
})
