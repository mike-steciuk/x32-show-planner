import { expandInputs } from './planner.js'

export const GEAR_TYPES = [
  { id: 'pa-speaker', label: 'PA speaker' },
  { id: 'subwoofer', label: 'Subwoofer' },
  { id: 'monitor-wedge', label: 'Monitor wedge' },
  { id: 'xlr', label: 'XLR cable' },
  { id: 'vocal-mic', label: 'Vocal microphone' },
  { id: 'instrument-mic', label: 'Instrument microphone' },
  { id: 'condenser-mic', label: 'Condenser microphone' },
  { id: 'di-box', label: 'DI box' },
  { id: 'mic-stand', label: 'Microphone stand' },
  { id: 'drum-clip', label: 'Drum microphone clip' },
  { id: 'power', label: 'Power cable / strip' },
  { id: 'other', label: 'Other' }
]

const add = (requirements, type, quantity = 1) => { requirements[type] = (requirements[type] ?? 0) + quantity }

export function bandGearRequirements(slot) {
  const requirements = {}
  for (const input of expandInputs({ members: slot.members ?? [] })) {
    const connection = (input.connection ?? '').toLowerCase()
    if (input.kind === 'vocal') {
      add(requirements, 'vocal-mic'); add(requirements, 'xlr'); add(requirements, 'mic-stand')
    } else if (input.kind === 'drums') {
      add(requirements, /oh/i.test(input.label) ? 'condenser-mic' : 'instrument-mic'); add(requirements, 'xlr')
      if (/oh|kick/i.test(input.label)) add(requirements, 'mic-stand'); else add(requirements, 'drum-clip')
    } else if (connection.includes('condenser')) {
      add(requirements, 'condenser-mic'); add(requirements, 'xlr'); add(requirements, 'mic-stand')
    } else if (connection.includes('mic')) {
      add(requirements, 'instrument-mic'); add(requirements, 'xlr'); add(requirements, 'mic-stand')
    } else if (connection.includes('di')) {
      add(requirements, 'di-box'); add(requirements, 'xlr')
    }
  }
  return requirements
}

export function calculateEventGear(event, inventory) {
  const perBand = (event.bands ?? []).map(slot => ({ slotId: slot.id, bandName: slot.bandName, requirements: bandGearRequirements(slot) }))
  const required = {}
  for (const band of perBand) for (const [type, quantity] of Object.entries(band.requirements)) required[type] = Math.max(required[type] ?? 0, quantity)
  for (const need of event.house?.requirements ?? []) {
    const quantity = Math.max(0, Number(need.quantity || 0))
    if (need.type && quantity) required[need.type] = (required[need.type] ?? 0) + quantity
  }
  const allocations = event.gear?.items ?? []
  const allocatedByType = {}
  for (const allocation of allocations) {
    const item = inventory.find(candidate => candidate.id === allocation.inventoryId)
    if (item) allocatedByType[item.type] = (allocatedByType[item.type] ?? 0) + Number(allocation.quantity || 0)
  }
  const labels = Object.fromEntries(GEAR_TYPES.map(type => [type.id, type.label]))
  const house = event.house?.requirements ?? []
  const requirements = Object.entries(required).map(([type, quantity]) => ({ type, label: labels[type] ?? type, required: quantity, allocated: allocatedByType[type] ?? 0, shortage: Math.max(0, quantity - (allocatedByType[type] ?? 0)), houseNotes: house.filter(need => need.type === type && need.notes).map(need => need.notes) }))
  const allocationDetails = allocations.map(allocation => {
    const item = inventory.find(candidate => candidate.id === allocation.inventoryId)
    return { ...allocation, itemName: item?.name ?? 'Missing inventory item', type: item?.type ?? 'other', owned: item?.quantity ?? 0, overAllocated: Math.max(0, Number(allocation.quantity || 0) - Number(item?.quantity || 0)) }
  })
  return { requirements, perBand, allocations: allocationDetails, shortageCount: requirements.reduce((sum, item) => sum + item.shortage, 0), setupComplete: allocationDetails.length > 0 && allocationDetails.every(item => item.setup) }
}

export function generateRunOfShow(event, inventory) {
  const custom = (event.runOfShow ?? []).filter(step => !step.generated)
  const generated = []
  for (const allocation of event.gear?.items ?? []) {
    const item = inventory.find(candidate => candidate.id === allocation.inventoryId)
    if (item && allocation.quantity > 0) generated.push({ id: `setup-${allocation.inventoryId}`, generated: true, type: 'setup', time: event.loadIn ?? '', bandSlotId: null, title: `Set up ${allocation.quantity} x ${item.name}`, details: allocation.location || '', completed: Boolean(allocation.setup), order: generated.length })
  }
  for (const need of event.house?.requirements ?? []) {
    if (Number(need.quantity || 0) > 0) generated.push({ id: `house-${need.id}`, generated: true, type: 'setup', time: event.loadIn ?? '', bandSlotId: null, title: `House: ${need.quantity} x ${need.label || need.type}`, details: need.notes || '', completed: false, order: generated.length })
  }
  for (const [index, slot] of (event.bands ?? []).entries()) {
    if (index > 0) generated.push({ id: `change-${slot.id}`, generated: true, type: 'changeover', time: slot.setTime ?? '', bandSlotId: slot.id, title: `Change over to ${slot.bandName}`, details: 'Complete custom swap steps, then verify the patch.', completed: false, order: generated.length })
    generated.push({ id: `scene-${slot.id}`, generated: true, type: 'scene', time: slot.setTime ?? '', bandSlotId: slot.id, title: `Recall scene ${slot.sceneSlot}: ${slot.bandName}`, details: 'Confirm channels are muted before line check.', completed: false, order: generated.length })
  }
  return [...generated, ...custom].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || (a.order ?? 999) - (b.order ?? 999))
}
