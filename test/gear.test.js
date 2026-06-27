import test from 'node:test'
import assert from 'node:assert/strict'
import { bandGearRequirements, calculateEventGear, generateRunOfShow } from '../server/gear.js'

const slot = { id:'slot-1', bandName:'Test Band', sceneSlot:4, setTime:'20:00', members:[{ id:'m1',name:'Alex',vocal:true,monitor:'wedge',sources:[{id:'g1',instrument:'guitar',connection:'amp mic'},{id:'g2',instrument:'guitar',connection:'DI'}] }] }

test('calculates show shortages from band inputs and owned allocations', () => {
  const requirements = bandGearRequirements(slot)
  assert.deepEqual(requirements, { 'vocal-mic':1, xlr:3, 'mic-stand':2, 'instrument-mic':1, 'di-box':1 })
  const inventory = [{id:'xlr',name:'25 ft XLR',type:'xlr',quantity:2},{id:'mic',name:'SM58',type:'vocal-mic',quantity:1}]
  const event = { bands:[slot], gear:{items:[{inventoryId:'xlr',quantity:2,setup:false},{inventoryId:'mic',quantity:1,setup:true}]}, runOfShow:[], loadIn:'17:00' }
  const report = calculateEventGear(event, inventory)
  assert.equal(report.requirements.find(item => item.type === 'xlr').shortage, 1)
  assert.ok(report.shortageCount > 1)
})

test('generates setup, changeover, and scene checklist steps', () => {
  const second = { ...slot, id:'slot-2', bandName:'Second Band', sceneSlot:5, setTime:'21:00' }
  const event = { loadIn:'17:00', gear:{items:[{inventoryId:'xlr',quantity:3,setup:false}]}, bands:[slot,second], runOfShow:[{id:'custom',generated:false,type:'changeover',time:'20:50',title:'Swap guitar',completed:false}] }
  const steps = generateRunOfShow(event, [{id:'xlr',name:'25 ft XLR',type:'xlr',quantity:10}])
  assert.ok(steps.some(step => step.title === 'Set up 3 x 25 ft XLR'))
  assert.ok(steps.some(step => step.title === 'Change over to Second Band'))
  assert.ok(steps.some(step => step.id === 'custom'))
})

test('adds house requirements to event gear demand and generated setup', () => {
  const event = { loadIn:'17:00', gear:{items:[]}, bands:[slot], house:{requirements:[{id:'pa',type:'pa-speaker',quantity:2,label:'Main PA',notes:'House left and right'}]}, runOfShow:[] }
  const report = calculateEventGear(event, [])
  assert.equal(report.requirements.find(item => item.type === 'pa-speaker').required, 2)
  assert.equal(report.requirements.find(item => item.type === 'pa-speaker').shortage, 2)
  const steps = generateRunOfShow(event, [])
  assert.ok(steps.some(step => step.title === 'House: 2 x Main PA'))
})
