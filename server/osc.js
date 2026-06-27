import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

const pad = length => (4 - (length % 4)) % 4
const oscString = value => {
  const bytes = Buffer.from(`${value}\0`)
  return Buffer.concat([bytes, Buffer.alloc(pad(bytes.length))])
}

const shouldEncodeFloat = path => /\/mix\/(?:fader|\d{2}\/level)$/.test(path)
  || /\/eq\/\d\/[fgq]$/.test(path)
  || /\/preamp\/hpf$/.test(path)
  || /\/(?:gate|dyn)\/(?:thr|range|attack|hold|release|knee|mgain)$/.test(path)

export function encodeMessage(path, value) {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value]
  const forceFloat = shouldEncodeFloat(path)
  const tags = values.map(item => typeof item === 'string' ? 's' : forceFloat && typeof item === 'number' ? 'f' : Number.isInteger(item) ? 'i' : 'f').join('')
  const chunks = [oscString(path), oscString(`,${tags}`)]
  for (const [index, item] of values.entries()) {
    if (typeof item === 'string') chunks.push(oscString(item))
    else if (tags[index] === 'i') { const number = Buffer.alloc(4); number.writeInt32BE(item); chunks.push(number) }
    else { const number = Buffer.alloc(4); number.writeFloatBE(item); chunks.push(number) }
  }
  return Buffer.concat(chunks)
}

const readString = (buffer, offset) => {
  const end = buffer.indexOf(0, offset)
  const value = buffer.toString('utf8', offset, end)
  return { value, next: end + 1 + pad(end - offset + 1) }
}

export function decodeMessage(buffer) {
  const address = readString(buffer, 0)
  const tags = readString(buffer, address.next)
  let offset = tags.next
  const args = []
  for (const tag of tags.value.slice(1)) {
    if (tag === 's') { const parsed = readString(buffer, offset); args.push(parsed.value); offset = parsed.next }
    if (tag === 'i') { args.push(buffer.readInt32BE(offset)); offset += 4 }
    if (tag === 'f') { args.push(buffer.readFloatBE(offset)); offset += 4 }
    if (tag === 'b') { const size = buffer.readInt32BE(offset); offset += 4; args.push(buffer.subarray(offset, offset + size)); offset += size + pad(size) }
  }
  return { address: address.value, args }
}

export class X32Bridge extends EventEmitter {
  constructor() {
    super()
    this.socket = null
    this.host = null
    this.port = 10023
    this.pending = new Map()
    this.remoteTimer = null
  }

  async connect(host) {
    this.close()
    this.host = host
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', message => this.onMessage(message))
    this.socket.on('error', error => this.emit('error', error))
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.bind(0, () => { this.socket.off('error', reject); resolve() })
    })
    const info = await this.request('/info', 1200)
    this.keepRemoteAlive()
    return { host, info: info.args }
  }

  onMessage(buffer) {
    let message
    try { message = decodeMessage(buffer) } catch { return }
    const queue = this.pending.get(message.address)
    if (queue?.length) queue.shift()(message)
    this.emit('message', message)
  }

  send(path, value) {
    if (!this.socket || !this.host) throw new Error('Mixer is not connected')
    const payload = encodeMessage(path, value)
    this.socket.send(payload, this.port, this.host)
  }

  request(path, timeout = 800, value, responsePath = path) {
    return new Promise((resolve, reject) => {
      const queue = this.pending.get(responsePath) ?? []
      let timer
      const finish = message => { clearTimeout(timer); resolve(message) }
      queue.push(finish); this.pending.set(responsePath, queue)
      timer = setTimeout(() => {
        const current = this.pending.get(responsePath) ?? []
        this.pending.set(responsePath, current.filter(item => item !== finish))
        reject(new Error(`No response from ${responsePath}`))
      }, timeout)
      this.send(path, value)
    })
  }

  collect(path, duration = 1500, value, responsePath = 'node') {
    return new Promise((resolve, reject) => {
      const messages = []
      const expected = Array.isArray(responsePath) ? responsePath : responsePath ? [responsePath] : null
      const listener = message => { if (!expected || expected.includes(message.address)) messages.push(message) }
      const cleanup = () => this.off('message', listener)
      this.on('message', listener)
      try { this.send(path, value) } catch (error) { cleanup(); reject(error); return }
      setTimeout(() => { cleanup(); resolve(messages) }, duration)
    })
  }

  keepRemoteAlive() {
    clearInterval(this.remoteTimer)
    const tick = () => { try { this.send('/xremote') } catch {} }
    tick(); this.remoteTimer = setInterval(tick, 8000)
  }

  close() {
    clearInterval(this.remoteTimer)
    this.socket?.close()
    this.socket = null
    this.host = null
  }
}
