const COLORS = {
  vocal: 'GN', guitar: 'CY', bass: 'WH', drums: 'YE', keys: 'RD',
  playback: 'MG', brass: 'BL', strings: 'BL', other: 'WH'
}

const PRIORITY = {
  vocal: 10, drums: 20, bass: 30, guitar: 40, keys: 50,
  brass: 60, strings: 65, playback: 70, other: 80
}

const ICONS = {
  vocal: 8, guitar: 23, bass: 25, drums: 18, keys: 31,
  playback: 42, brass: 37, strings: 35, other: 1
}

const SEND_COUNT = 16
const SEND_START_LEVEL = 0.32
const MAIN_START_LEVEL = 0.75
const MONITOR_START_LEVEL = 0.7

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
    label: `X32 Local · IN ${index + 1}`,
    group: 'X32 Local',
    physical: index + 1,
    source: index
  }))
  const aes50Inputs = Array.from({ length: 16 }, (_, index) => ({
    id: `A${index + 1}`,
    label: `SD8-${index < 8 ? 1 : 2} · IN ${index % 8 + 1}`,
    group: 'AES50-A / SD8',
    aes50: index + 1,
    headamp: 32 + index,
    source: index + 32
  }))
  return [...localInputs, ...aes50Inputs]
}

export function outputBuses(plan) {
  const monitors = []
  const seen = new Set()
  for (const member of plan.members ?? []) {
    if (!member.monitor || member.monitor === 'none' || seen.has(member.id)) continue
    seen.add(member.id)
    monitors.push({
      id: `mon-${member.id}`,
      memberId: member.id,
      bus: monitors.length + 1,
      name: short(`${member.name || 'Player'} ${member.monitor === 'iem' ? 'IEM' : 'Mon'}`),
      label: `${member.name || 'Player'} ${member.monitor === 'iem' ? 'IEM' : 'monitor'}`,
      kind: member.monitor
    })
  }
  return {
    mains: [{ id: 'main-lr', name: 'House PA', label: 'Main LR · House PA', path: '/main/st', kind: 'pa' }],
    monitors: monitors.slice(0, SEND_COUNT),
    warnings: monitors.length > SEND_COUNT ? [`${monitors.length - SEND_COUNT} monitor mixes exceed the 16 available X32 mix buses`] : []
  }
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
  const outputs = outputBuses(plan)
  const commands = []
  const warnings = [...outputs.warnings]

  for (const item of inputs) {
    const ch = String(item.channel).padStart(2, '0')
    commands.push({ path: `/ch/${ch}/config/name`, value: item.label, section: 'Identity' })
    commands.push({ path: `/ch/${ch}/config/color`, value: item.invert ? `${item.color}_INV` : item.color, section: 'Identity' })
    commands.push({ path: `/ch/${ch}/config/icon`, value: item.icon, section: 'Identity' })
    commands.push({ path: `/ch/${ch}/mix/on`, value: 0, section: 'Safe startup', note: 'Start muted for line check' })
    commands.push({ path: `/ch/${ch}/mix/fader`, value: 0, section: 'Safe startup', note: 'Start at -∞ for line check' })
    commands.push(...processingCommands(item.channel, item.processing))
    const socketId = plan.patches?.[item.id]
    if (socketId) {
      const socket = sockets.find(candidate => candidate.id === socketId)
      if (socket) {
        commands.push({ path: `/config/userrout/in/${ch}`, value: socket.source, section: 'Routing', note: `${socket.label} → CH ${ch}` })
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
    commands.push({ path: `/bus/${bus}/config/color`, value: output.kind === 'iem' ? 'CY' : 'YE', section: 'Monitor buses' })
    commands.push({ path: `/bus/${bus}/mix/on`, value: 1, section: 'Monitor buses' })
    commands.push({ path: `/bus/${bus}/mix/fader`, value: MONITOR_START_LEVEL, section: 'Monitor buses' })
    for (const item of inputs) {
      const ch = String(item.channel).padStart(2, '0')
      const isOwnMix = item.memberId === output.memberId
      commands.push({ path: `/ch/${ch}/mix/${bus}/on`, value: isOwnMix ? 1 : 0, section: 'Monitor sends', note: `${item.label} → ${output.label}` })
      commands.push({ path: `/ch/${ch}/mix/${bus}/level`, value: isOwnMix ? SEND_START_LEVEL : 0, section: 'Monitor sends' })
    }
  }

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
  return { inputs, sockets, outputs, commands: diff, warnings, changedCount: diff.filter(item => item.changed).length }
}
import { processingCommands, processingPreset } from './processing.js'
