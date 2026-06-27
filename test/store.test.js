import test from 'node:test'
import assert from 'node:assert/strict'
import { createBandSlot, publicBandSlot, slugify } from '../server/store.js'

test('creates private per-event band intake slots', () => {
  const band = { id: 'band-1', name: 'Test Band', members: [] }
  const first = createBandSlot(band, 12)
  const second = createBandSlot(band, 13)
  assert.equal(first.sceneSlot, 12)
  assert.notEqual(first.intakeToken, second.intakeToken)
  assert.equal(slugify('Summer Session #12'), 'summer-session-12')
  const exposed = publicBandSlot({ id:'e',name:'Event',date:'2026-07-01',venue:'Room' }, first)
  assert.equal(exposed.band.name, 'Test Band')
  assert.equal('intakeToken' in exposed.band, false)
})
