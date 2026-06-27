import { EventEmitter } from 'node:events'

const colors = ['GN', 'GN', 'YE', 'YE', 'WH', 'CY', 'CY', 'RD']
const names = ['Amy Vox', 'Chris Vox', 'Kick', 'Snare', 'Jordan Bass', 'Chris Gtr', 'Spare Gtr', 'Riley Key L']

export class MixerSimulator extends EventEmitter {
  constructor() {
    super()
    this.channels = Array.from({ length: 32 }, (_, index) => ({
      number: index + 1,
      name: names[index] ?? `Channel ${index + 1}`,
      color: colors[index] ?? 'OFF',
      icon: 1,
      source: undefined,
      fader: 0,
      on: 1,
      level: index < 8 ? 0.25 + Math.random() * 0.55 : 0,
      eq: {
        on: index < 8,
        bands: [
          { type: 'LCut', f: 70 + index * 4, g: 0, q: 0.7 },
          { type: 'PEQ', f: 220 + index * 22, g: index % 3 - 2, q: 1.2 },
          { type: 'PEQ', f: 2100 + index * 90, g: (index % 4) - 1, q: 1.6 },
          { type: 'HShv', f: 9000, g: index % 2 ? 1.5 : 0, q: 0.7 }
        ]
      }
    }))
    this.buses = Array.from({ length: 16 }, (_, index) => ({ number: index + 1, name: `Bus ${index + 1}`, color: 'OFF', on: 0, fader: 0 }))
    this.main = { name: 'House PA', color: 'WH', on: 1, fader: 0.75 }
    this.userRouting = {}
    this.parameters = {}
    this.scenes = []
    this.timer = setInterval(() => {
      for (const channel of this.channels.slice(0, 12)) channel.level = Math.max(0, Math.min(1, channel.level + (Math.random() - .5) * .12))
      this.emit('state', this.state())
    }, 650)
  }

  state() { return { mode: 'simulator', connected: true, model: 'X32 Simulator', firmware: '4.06', channels: structuredClone(this.channels), buses: structuredClone(this.buses), main: structuredClone(this.main), userRouting: structuredClone(this.userRouting), parameters: structuredClone(this.parameters), scenes: structuredClone(this.scenes) } }

  apply(commands) {
    for (const command of commands.filter(item => item.changed)) {
      this.parameters[command.path] = command.value
      const match = command.path.match(/^\/ch\/(\d+)\/config\/(name|color|icon)$/)
      if (match) this.channels[Number(match[1]) - 1][match[2]] = command.value
      const sourceMatch = command.path.match(/^\/ch\/(\d+)\/config\/source$/)
      if (sourceMatch) this.channels[Number(sourceMatch[1]) - 1].source = command.value
      const channelMixMatch = command.path.match(/^\/ch\/(\d+)\/mix\/(on|fader)$/)
      if (channelMixMatch) this.channels[Number(channelMixMatch[1]) - 1][channelMixMatch[2]] = command.value
      const routeMatch = command.path.match(/^\/config\/userrout\/in\/(\d+)$/)
      if (routeMatch) this.userRouting[routeMatch[1]] = command.value
      const busConfigMatch = command.path.match(/^\/bus\/(\d+)\/config\/(name|color)$/)
      if (busConfigMatch) this.buses[Number(busConfigMatch[1]) - 1][busConfigMatch[2]] = command.value
      const busMixMatch = command.path.match(/^\/bus\/(\d+)\/mix\/(on|fader)$/)
      if (busMixMatch) this.buses[Number(busMixMatch[1]) - 1][busMixMatch[2]] = command.value
      const mainConfigMatch = command.path.match(/^\/main\/st\/config\/(name|color)$/)
      if (mainConfigMatch) this.main[mainConfigMatch[1]] = command.value
      const mainMixMatch = command.path.match(/^\/main\/st\/mix\/(on|fader)$/)
      if (mainMixMatch) this.main[mainMixMatch[1]] = command.value
    }
    this.emit('state', this.state())
    return this.state()
  }

  saveScene(slot, name, note, bandId) {
    this.scenes = this.scenes.filter(scene => scene.slot !== slot)
    this.scenes.push({ slot, name, note, bandId, savedAt: new Date().toISOString(), parameters: structuredClone(this.parameters) })
    this.scenes.sort((a, b) => a.slot - b.slot)
    return this.state()
  }
}
