const COLORS = {
  vocal: 'GN', guitar: 'CY', bass: 'WH', drums: 'YE', keys: 'RD',
  playback: 'MG', brass: 'BL', strings: 'BL', other: 'WH'
}

const PRIORITY = {
  vocal: 10, guitar: 20, bass: 30, keys: 40,
  brass: 50, strings: 55, playback: 60, other: 70, drums: 90
}

const ICONS = {
  vocal: 8, guitar: 23, bass: 25, drums: 18, keys: 31,
  playback: 42, brass: 37, strings: 35, other: 1
}

const SEND_COUNT = 16
const SEND_START_LEVEL = 0.32
const MAIN_START_LEVEL = 0.75
const MONITOR_START_LEVEL = 0.7
const MAIN_OUTPUT_SOURCE = { L: 1, R: 2 }
const monitorOutputSource = bus => 3 + Number(bus)
const USER_INPUT_BLOCK_SOURCE = { '1-8': 20, '9-16': 21, '17-24': 22, '25-32': 23 }
const AES50_OUTPUT_BLOCK_SOURCE = { '1-8': 20, '9-16': 21 }
const OUTPUT_STAGING_SOURCE = { '1-4': 20, '5-8': 20, '9-12': 21, '13-16': 21 }

export const defaultPlan = {
  showName: 'Friday Night Set',
  venue: '',
  members: [
    { id: 'm1', name: 'Amy', vocal: true, instrument: 'vocal', connection: 'microphone', monitor: 'wedge', notes: 'Lead vocal' },
    { id: 'm2', name: 'Chris', vocal: true, instrument: 'guitar', connection: 'amp mic', monitor: 'wedge', notes: 'Electric guitar + backing vocal' },
    { id: 'm3', name: 'Jordan', vocal: false, instrument: 'bass', connection: 'DI', monitor: 'iem', notes: '' },
    { id: 'm4', name: 'Sam', vocal: false, instrument: 'drums', connection: 'kit', monitor: 'wedge', notes: 'Kick, snare, rack, floor, OH L/R' },
    { id: 'm5', name: 'Riley', vocal: false, instrument: 'keys', connection: 'stereo DI', monitor: 'iem', notes: '' }
  ],
  patches: {},
  preferences: { vocalsFirst: true, stereoKeys: true }
}

const short = (value, length = 12) => value.trim().slice(0, length)
const input = (member, kind, label, suffix = '', sequence = 0, sourceKey = '') => ({
  id: `${member.id}-${sourceKey ? `${sourceKey}-` : ''}${kind}${suffix}`,
  memberId: member.id,
  memberName: member.name,
  kind,
  label: short(label),
  color: COLORS[kind] ?? COLORS.other,
  icon: ICONS[kind] ?? ICONS.other,
  priority: PRIORITY[kind] ?? PRIORITY.other,
  sequence,
  phantom: /condenser/i.test(member.connection) || suffix.startsWith('oh'),
  connection: member.connection,
  monitor: member.monitor
})

export function expandInputs(plan) {
  const result = []
  for (const member of plan.members) {
    if (member.vocal) result.push(input(member, 'vocal', `${member.name} Vox`))
    const sources = member.sources?.length ? member.sources : [{ id: '', instrument: member.instrument, connection: member.connection, label: '' }]
    for (const [sourceIndex, source] of sources.entries()) {
      const kind = source.instrument || 'other'
      const sourceKey = source.id || ''
      const sourceMember = { ...member, connection: source.connection || member.connection }
      const sameKindCount = sources.filter(candidate => candidate.instrument === kind).length
      const kindOrdinal = sources.slice(0, sourceIndex + 1).filter(candidate => candidate.instrument === kind).length
      const number = sameKindCount > 1 ? ` ${kindOrdinal}` : ''
      if (kind === 'vocal') {
        if (!member.vocal) result.push(input(sourceMember, 'vocal', source.label || `${member.name} Vox${number}`, '', sourceIndex, sourceKey))
      } else if (kind === 'drums') {
        for (const [sequence, [suffix, label]] of [['kick', 'Kick'], ['snare', 'Snare'], ['rack', 'Rack Tom'], ['floor', 'Floor Tom'], ['oh-l', 'OH Left'], ['oh-r', 'OH Right']].entries()) {
          const drumLabel = source.label ? `${source.label} ${label}` : label
          result.push(input(sourceMember, kind, drumLabel, suffix, sequence, sourceKey))
        }
      } else if (kind === 'keys' && /stereo/i.test(sourceMember.connection)) {
        const base = source.label || `${member.name} Key${number}`
        result.push(input(sourceMember, kind, `${base} L`, 'l', sourceIndex, sourceKey), input(sourceMember, kind, `${base} R`, 'r', sourceIndex, sourceKey))
      } else if (kind && kind !== 'none') {
        const noun = kind === 'guitar' ? 'Gtr' : kind[0].toUpperCase() + kind.slice(1)
        result.push(input(sourceMember, kind, source.label || `${member.name} ${noun}${number}`, '', sourceIndex, sourceKey))
      }
    }
  }
  return result.sort((a, b) => a.priority - b.priority || a.memberName.localeCompare(b.memberName) || a.sequence - b.sequence || a.label.localeCompare(b.label))
}

export function stageSockets() {
  const localInputs = Array.from({ length: 32 }, (_, index) => ({
    id: `L${index + 1}`,
    label: `X32 Local \u00b7 IN ${index + 1}`,
    group: 'X32 Local',
    physical: index + 1,
    source: index + 1
  }))
  const aes50Inputs = Array.from({ length: 16 }, (_, index) => ({
    id: `A${index + 1}`,
    label: `SD8-${index < 8 ? 1 : 2} \u00b7 IN ${index % 8 + 1}`,
    group: 'AES50-A / SD8',
    aes50: index + 1,
    headamp: 32 + index,
    source: index + 33
  }))
  return [...localInputs, ...aes50Inputs]
}

export function stageOutputSockets() {
  return Array.from({ length: 16 }, (_, index) => ({
    id: `A${index + 1}`,
    label: `SD8-${index < 8 ? 1 : 2} \u00b7 OUT ${index % 8 + 1}`,
    group: 'AES50-A / SD8',
    aes50: index + 1,
    outputSlot: index + 1,
    routingPath: `/config/routing/AES50A/${index < 8 ? '1-8' : '9-16'}`,
    routingValue: index < 8 ? AES50_OUTPUT_BLOCK_SOURCE['1-8'] : AES50_OUTPUT_BLOCK_SOURCE['9-16']
  }))
}


function userInputBlockForChannel(channel) {
  if (channel <= 8) return { path: '/config/routing/IN/1-8', value: USER_INPUT_BLOCK_SOURCE['1-8'], label: 'UIN1-8' }
  if (channel <= 16) return { path: '/config/routing/IN/9-16', value: USER_INPUT_BLOCK_SOURCE['9-16'], label: 'UIN9-16' }
  if (channel <= 24) return { path: '/config/routing/IN/17-24', value: USER_INPUT_BLOCK_SOURCE['17-24'], label: 'UIN17-24' }
  return { path: '/config/routing/IN/25-32', value: USER_INPUT_BLOCK_SOURCE['25-32'], label: 'UIN25-32' }
}

function userInputBlockCommands(inputs) {
  const blocks = new Map()
  for (const input of inputs) {
    const block = userInputBlockForChannel(input.channel)
    blocks.set(block.path, block)
  }
  return [...blocks.values()].map(block => ({ path: block.path, value: block.value, section: 'Input routing blocks', note: `Console input block uses ${block.label}` }))
}

export function outputBuses(plan) {
  const configured = plan.monitors?.length ? plan.monitors : (plan.members ?? [])
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
  const monitors = configured
    .slice()
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map((monitor, index) => ({
      id: monitor.id || `mon-${index + 1}`,
      memberId: monitor.memberId || '',
      bus: index + 1,
      name: short(monitor.name || monitor.label || `Monitor ${index + 1}`),
      label: monitor.label || monitor.name || `Monitor ${index + 1}`,
      kind: monitor.kind || 'wedge',
      color: monitor.color || (monitor.kind === 'iem' ? 'CY' : 'YE'),
      output: monitor.output || ''
    }))
  return {
    mains: [{ id: 'main-lr', name: 'House PA', label: 'Main LR \u00b7 House PA', path: '/main/st', kind: 'pa' }],
    monitors: monitors.slice(0, SEND_COUNT),
    warnings: monitors.length > SEND_COUNT ? [`${monitors.length - SEND_COUNT} monitor mixes exceed the 16 available X32 mix buses`] : []
  }
}

function mainOutputPatchCommands(outputPatches = {}, outputSockets, warnings) {
  const commands = []
  const assigned = [
    { side: 'L', key: 'mainL', label: 'Main L' },
    { side: 'R', key: 'mainR', label: 'Main R' }
  ]
  const requiredBlocks = new Map()
  for (const assignment of assigned) {
    const socketId = outputPatches[assignment.key]
    if (!socketId) continue
    const socket = outputSockets.find(candidate => candidate.id === socketId)
    if (!socket) {
      warnings.push(`${assignment.label} is assigned to an unknown stage output (${socketId})`)
      continue
    }
    const slot = String(socket.outputSlot).padStart(2, '0')
    commands.push({ path: `/config/userrout/out/${slot}`, value: MAIN_OUTPUT_SOURCE[assignment.side], section: 'Main LR output patch', note: `${assignment.label} \u2192 ${socket.label}` })
    const staging = outputStagingBlockForSlot(socket.outputSlot)
    commands.push({ path: staging.path, value: staging.value, section: 'Main LR output patch', note: staging.note })
    requiredBlocks.set(socket.routingPath, socket.routingValue)
  }
  for (const [path, value] of requiredBlocks) commands.push({ path, value, section: 'Main LR output patch', note: value === AES50_OUTPUT_BLOCK_SOURCE['1-8'] ? 'AES50-A 1-8 uses OUT1-8' : 'AES50-A 9-16 uses OUT9-16' })
  return commands
}

function monitorOutputPatchCommands(monitors = [], monitorPatches = {}, outputSockets, warnings) {
  const commands = []
  const requiredBlocks = new Map()
  for (const monitor of monitors) {
    const defaultSocketId = monitor.bus + 2 <= 16 ? `A${monitor.bus + 2}` : ''
    const socketId = monitor.output || monitorPatches[monitor.id] || defaultSocketId
    if (!socketId) continue
    const socket = outputSockets.find(candidate => candidate.id === socketId)
    if (!socket) {
      warnings.push(`${monitor.label} is assigned to an unknown stage output (${socketId})`)
      continue
    }
    const slot = String(socket.outputSlot).padStart(2, '0')
    commands.push({ path: `/config/userrout/out/${slot}`, value: monitorOutputSource(monitor.bus), section: 'Monitor output patch', note: `${monitor.label} \u2192 ${socket.label}` })
    const staging = outputStagingBlockForSlot(socket.outputSlot)
    commands.push({ path: staging.path, value: staging.value, section: 'Monitor output patch', note: staging.note })
    requiredBlocks.set(socket.routingPath, socket.routingValue)
  }
  for (const [path, value] of requiredBlocks) commands.push({ path, value, section: 'Monitor output patch', note: value === AES50_OUTPUT_BLOCK_SOURCE['1-8'] ? 'AES50-A 1-8 uses OUT1-8' : 'AES50-A 9-16 uses OUT9-16' })
  return commands
}

function outputStagingBlockForSlot(slot) {
  if (slot <= 4) return { path: '/config/routing/OUT/1-4', value: OUTPUT_STAGING_SOURCE['1-4'], note: 'OUT 1-4 follows User Out 1-4' }
  if (slot <= 8) return { path: '/config/routing/OUT/5-8', value: OUTPUT_STAGING_SOURCE['5-8'], note: 'OUT 5-8 follows User Out 5-8' }
  if (slot <= 12) return { path: '/config/routing/OUT/9-12', value: OUTPUT_STAGING_SOURCE['9-12'], note: 'OUT 9-12 follows User Out 9-12' }
  return { path: '/config/routing/OUT/13-16', value: OUTPUT_STAGING_SOURCE['13-16'], note: 'OUT 13-16 follows User Out 13-16' }
}

export function compilePlan(plan, consoleState) {
  const overrides = plan.channelOverrides ?? {}
  const inputs = expandInputs(plan)
    .map((item, index) => {
      const override = overrides[item.id] ?? {}
      return {
        ...item,
        label: override.label ? short(override.label) : item.label,
        color: override.color || item.color,
        invert: Boolean(override.invert),
        icon: Number(override.icon || item.icon),
        customOrder: Number.isFinite(Number(override.order)) ? Number(override.order) : index
      }
    })
    .sort((a, b) => a.customOrder - b.customOrder || a.priority - b.priority || a.memberName.localeCompare(b.memberName) || a.sequence - b.sequence || a.label.localeCompare(b.label))
    .slice(0, 32)
    .map((item, index) => ({ ...item, channel: index + 1, processing: processingPreset(item) }))
  const sockets = stageSockets()
  const outputSockets = stageOutputSockets()
  const outputs = outputBuses(plan)
  const commands = []
  const warnings = [...outputs.warnings]

  commands.push(...userInputBlockCommands(inputs))

  for (const item of inputs) {
    const ch = String(item.channel).padStart(2, '0')
    commands.push({ path: `/ch/${ch}/config/name`, value: item.label, section: 'Identity' })
    commands.push({ path: `/ch/${ch}/config/color`, value: item.invert ? `${item.color}_INV` : item.color, section: 'Identity' })
    commands.push({ path: `/ch/${ch}/config/icon`, value: item.icon, section: 'Identity' })
    commands.push({ path: `/ch/${ch}/mix/on`, value: 0, section: 'Safe startup', note: 'Start muted for line check' })
    commands.push({ path: `/ch/${ch}/mix/fader`, value: 0, section: 'Safe startup', note: 'Start at -\u221e for line check' })
    commands.push(...processingCommands(item.channel, item.processing))
    const socketId = plan.patches?.[item.id]
    if (socketId) {
      const socket = sockets.find(candidate => candidate.id === socketId)
      if (socket) {
        commands.push({ path: `/config/userrout/in/${ch}`, value: socket.source, section: 'Routing', note: `${socket.label} \u2192 CH ${ch}` })
        commands.push({ path: `/ch/${ch}/config/source`, value: item.channel, section: 'Routing' })
      } else {
        warnings.push(`${item.label} is assigned to an unknown physical input (${socketId})`)
      }
    } else {
      warnings.push(`${item.label} has no physical input assigned`)
    }
  }

  for (const main of outputs.mains) {
    commands.push({ path: `${main.path}/config/name`, value: main.name, section: 'Output buses' })
    commands.push({ path: `${main.path}/config/color`, value: 'WH', section: 'Output buses' })
    commands.push({ path: `${main.path}/mix/on`, value: 1, section: 'Output buses' })
    commands.push({ path: `${main.path}/mix/fader`, value: MAIN_START_LEVEL, section: 'Output buses', note: main.label })
  }

  for (const output of outputs.monitors) {
    const bus = String(output.bus).padStart(2, '0')
    commands.push({ path: `/bus/${bus}/config/name`, value: output.name, section: 'Monitor buses' })
    commands.push({ path: `/bus/${bus}/config/color`, value: output.color || (output.kind === 'iem' ? 'CY' : 'YE'), section: 'Monitor buses' })
    commands.push({ path: `/bus/${bus}/mix/on`, value: 1, section: 'Monitor buses' })
    commands.push({ path: `/bus/${bus}/mix/fader`, value: MONITOR_START_LEVEL, section: 'Monitor buses' })
    for (const item of inputs) {
      const ch = String(item.channel).padStart(2, '0')
      const isTargetedMix = output.memberId ? item.memberId === output.memberId : true
      commands.push({ path: `/ch/${ch}/mix/${bus}/on`, value: isTargetedMix ? 1 : 0, section: 'Monitor sends', note: `${item.label} \u2192 ${output.label}` })
      commands.push({ path: `/ch/${ch}/mix/${bus}/level`, value: isTargetedMix ? SEND_START_LEVEL : 0, section: 'Monitor sends' })
    }
  }

  commands.push(...mainOutputPatchCommands(plan.outputPatches ?? {}, outputSockets, warnings))
  commands.push(...monitorOutputPatchCommands(outputs.monitors, plan.monitorPatches ?? {}, outputSockets, warnings))

  if (plan.clearUnused) {
    for (let channel = inputs.length + 1; channel <= 32; channel++) {
      const ch = String(channel).padStart(2, '0')
      commands.push({ path: `/ch/${ch}/mix/on`, value: 0, section: 'Clear unused channels' })
      commands.push({ path: `/ch/${ch}/mix/fader`, value: 0, section: 'Clear unused channels' })
      commands.push({ path: `/ch/${ch}/config/name`, value: '', section: 'Clear unused channels' })
      commands.push({ path: `/ch/${ch}/config/color`, value: 'OFF', section: 'Clear unused channels' })
      commands.push({ path: `/ch/${ch}/config/icon`, value: 1, section: 'Clear unused channels' })
      for (let send = 1; send <= SEND_COUNT; send++) {
        const bus = String(send).padStart(2, '0')
        commands.push({ path: `/ch/${ch}/mix/${bus}/on`, value: 0, section: 'Clear unused sends' })
        commands.push({ path: `/ch/${ch}/mix/${bus}/level`, value: 0, section: 'Clear unused sends' })
      }
    }
  }

  const existing = new Map()
  for (const channel of consoleState?.channels ?? []) {
    const ch = String(channel.number).padStart(2, '0')
    existing.set(`/ch/${ch}/config/name`, channel.name)
    existing.set(`/ch/${ch}/config/color`, channel.color)
    existing.set(`/ch/${ch}/config/icon`, channel.icon)
    existing.set(`/ch/${ch}/mix/fader`, channel.fader)
    if (channel.source !== undefined) existing.set(`/ch/${ch}/config/source`, channel.source)
  }
  for (const [slot, source] of Object.entries(consoleState?.userRouting ?? {})) existing.set(`/config/userrout/in/${slot}`, source)
  for (const [path, value] of Object.entries(consoleState?.parameters ?? {})) existing.set(path, value)
  const diff = commands.map(command => ({ ...command, before: existing.get(command.path), changed: existing.get(command.path) !== command.value }))
  return { inputs, sockets, outputSockets, outputs, commands: diff, warnings, changedCount: diff.filter(item => item.changed).length }
}
import { processingCommands, processingPreset } from './processing.js'
