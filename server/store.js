import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const dataDirectory = path.resolve('data')
const storePath = path.join(dataDirectory, 'store.json')

const seedBand = {
  id: 'band-ferndale-house',
  name: 'Ferndale House Band',
  contactName: '',
  contactEmail: '',
  notes: 'Example band - replace with your regular performers.',
  members: [],
  setups: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}

const initialStore = { version: 2, events: [], bands: [seedBand], inventory: [], settings: { mixerHost: '', autoConnectMixer: true, useTemplateScene: true, templateSceneSlot: 99, templateSceneName: 'TEMPLATE' } }

export const slugify = value => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'event'
export const createId = prefix => `${prefix}-${randomUUID()}`

function legacyMonitorsFromMembers(members = []) {
  return members
    .filter(member => member.monitor && member.monitor !== 'none')
    .map((member, index) => ({
      id: `mon-${member.id}`,
      memberId: member.id,
      label: `${member.name || 'Player'} ${member.monitor === 'iem' ? 'IEM' : 'monitor'}`,
      kind: member.monitor,
      color: member.monitor === 'iem' ? 'CY' : 'YE',
      output: index + 3 <= 16 ? `A${index + 3}` : '',
      order: index
    }))
}

export async function loadStore() {
  await mkdir(dataDirectory, { recursive: true })
  try {
    const store = JSON.parse((await readFile(storePath, 'utf8')).replace(/^\uFEFF/, ''))
    store.version = 2
    store.inventory ||= []
    store.settings ||= { mixerHost: '', autoConnectMixer: true, useTemplateScene: true, templateSceneSlot: 99, templateSceneName: 'TEMPLATE' }
    store.settings.autoConnectMixer ??= true
    store.settings.mixerHost ||= ''
    store.settings.useTemplateScene ??= true
    store.settings.templateSceneSlot ??= 99
    store.settings.templateSceneName ||= 'TEMPLATE'
    for (const event of store.events ?? []) {
      event.gear ||= { items: [] }
      event.house ||= { requirements: [] }
      event.outputPatches ||= { mainL: 'A1', mainR: 'A2' }
      event.outputPatches.mainL ||= 'A1'
      event.outputPatches.mainR ||= 'A2'
      event.runOfShow ||= []
      for (const slot of event.bands ?? []) {
        slot.channelOverrides ||= {}
        slot.monitorPatches ||= {}
        slot.monitors ||= legacyMonitorsFromMembers(slot.members)
      }
    }
    return store
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await saveStore(structuredClone(initialStore))
    return structuredClone(initialStore)
  }
}

export async function saveStore(store) {
  await mkdir(dataDirectory, { recursive: true })
  const temporary = `${storePath}.tmp`
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(temporary, storePath)
  return store
}

export function createBandSlot(band, sceneSlot = 0) {
  return {
    id: createId('slot'),
    bandId: band.id,
    bandName: band.name,
    intakeToken: randomUUID(),
    intakeStatus: band.members?.length ? 'ready' : 'invited',
    members: structuredClone(band.members ?? []),
    patches: {},
    channelOverrides: {},
    monitorPatches: {},
    monitors: structuredClone(band.monitors ?? legacyMonitorsFromMembers(band.members)),
    sceneSlot,
    setTime: '',
    notes: '',
    submittedAt: null,
    syncedAt: null
  }
}

export function publicBandSlot(event, slot) {
  return {
    event: { id: event.id, name: event.name, date: event.date, venue: event.venue, loadIn: event.loadIn },
    band: { name: slot.bandName, contactName: slot.contactName ?? '', contactEmail: slot.contactEmail ?? '', members: slot.members, monitors: slot.monitors ?? legacyMonitorsFromMembers(slot.members), notes: slot.notes },
    status: slot.intakeStatus
  }
}
