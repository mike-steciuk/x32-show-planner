const clamp = value => Math.max(0, Math.min(1, value))
const round = value => Math.round(value * 1e6) / 1e6
const linear = (value, min, max) => round(clamp((value - min) / (max - min)))
const logarithmic = (value, min, max) => round(clamp(Math.log(value / min) / Math.log(max / min)))
const eqFrequency = value => logarithmic(value, 20, 20000)
const eqGain = value => linear(value, -15, 15)
const eqQ = value => logarithmic(value, 10, .3)

const neutralEq = (hpf, bands = []) => ({
  hpf,
  bands: [
    { type: 'LCut', f: hpf, g: 0, q: .7 },
    bands[0] ?? { type: 'PEQ', f: 250, g: 0, q: 1.2 },
    bands[1] ?? { type: 'PEQ', f: 2500, g: 0, q: 1.4 },
    bands[2] ?? { type: 'HShv', f: 10000, g: 0, q: .7 }
  ]
})

const PRESETS = {
  vocal: { eq: neutralEq(100, [{ type: 'PEQ', f: 250, g: -2, q: 1.2 }, { type: 'PEQ', f: 3200, g: 1.5, q: 1.3 }, { type: 'HShv', f: 10000, g: 1, q: .7 }]), gate: { on: false, threshold: -55, range: 10, attack: 5, hold: 80, release: 180 }, compressor: { on: true, threshold: -18, ratio: '3.0', attack: 10, hold: 20, release: 120, makeup: 0 } },
  guitar: { eq: neutralEq(80, [{ type: 'PEQ', f: 280, g: -1.5, q: 1.2 }, { type: 'PEQ', f: 2800, g: 1, q: 1.5 }, { type: 'HShv', f: 8500, g: -1, q: .7 }]), gate: { on: true, threshold: -50, range: 18, attack: 3, hold: 80, release: 180 }, compressor: { on: false, threshold: -16, ratio: '2.0', attack: 20, hold: 20, release: 140, makeup: 0 } },
  bass: { eq: neutralEq(45, [{ type: 'PEQ', f: 90, g: 1.5, q: 1 }, { type: 'PEQ', f: 350, g: -1.5, q: 1.2 }, { type: 'PEQ', f: 1800, g: 1, q: 1.5 }]), gate: { on: false, threshold: -55, range: 10, attack: 5, hold: 80, release: 180 }, compressor: { on: true, threshold: -20, ratio: '4.0', attack: 25, hold: 20, release: 160, makeup: 1 } },
  keys: { eq: neutralEq(45, [{ type: 'PEQ', f: 250, g: -1, q: 1.1 }, { type: 'PEQ', f: 2500, g: 0, q: 1.3 }, { type: 'HShv', f: 10000, g: .5, q: .7 }]), gate: { on: false, threshold: -60, range: 8, attack: 5, hold: 80, release: 180 }, compressor: { on: true, threshold: -14, ratio: '2.0', attack: 25, hold: 20, release: 160, makeup: 0 } },
  other: { eq: neutralEq(70), gate: { on: false, threshold: -55, range: 10, attack: 5, hold: 80, release: 180 }, compressor: { on: false, threshold: -18, ratio: '2.0', attack: 20, hold: 20, release: 150, makeup: 0 } }
}

const DRUMS = {
  kick: { eq: neutralEq(40, [{ type: 'PEQ', f: 70, g: 3, q: 1.1 }, { type: 'PEQ', f: 350, g: -4, q: 1.4 }, { type: 'PEQ', f: 3500, g: 3, q: 1.5 }]), gate: { on: true, threshold: -38, range: 30, attack: 1, hold: 80, release: 140 }, compressor: { on: true, threshold: -18, ratio: '4.0', attack: 20, hold: 10, release: 100, makeup: 0 } },
  snare: { eq: neutralEq(90, [{ type: 'PEQ', f: 180, g: 2, q: 1.1 }, { type: 'PEQ', f: 700, g: -3, q: 1.5 }, { type: 'PEQ', f: 5000, g: 2.5, q: 1.4 }]), gate: { on: true, threshold: -42, range: 22, attack: 1, hold: 100, release: 180 }, compressor: { on: true, threshold: -16, ratio: '4.0', attack: 12, hold: 10, release: 110, makeup: 0 } },
  tom: { eq: neutralEq(55, [{ type: 'PEQ', f: 120, g: 2, q: 1.1 }, { type: 'PEQ', f: 450, g: -3, q: 1.4 }, { type: 'PEQ', f: 4000, g: 2, q: 1.4 }]), gate: { on: true, threshold: -42, range: 25, attack: 2, hold: 120, release: 220 }, compressor: { on: true, threshold: -16, ratio: '3.0', attack: 18, hold: 10, release: 140, makeup: 0 } },
  overhead: { eq: neutralEq(140, [{ type: 'PEQ', f: 400, g: -2, q: 1.1 }, { type: 'PEQ', f: 3500, g: 0, q: 1.4 }, { type: 'HShv', f: 11000, g: 1.5, q: .7 }]), gate: { on: false, threshold: -60, range: 8, attack: 5, hold: 80, release: 250 }, compressor: { on: true, threshold: -12, ratio: '2.0', attack: 30, hold: 10, release: 200, makeup: 0 } }
}

export function processingPreset(input) {
  if (input.kind === 'drums') {
    if (/kick/i.test(input.label)) return structuredClone(DRUMS.kick)
    if (/snare/i.test(input.label)) return structuredClone(DRUMS.snare)
    if (/tom/i.test(input.label)) return structuredClone(DRUMS.tom)
    return structuredClone(DRUMS.overhead)
  }
  return structuredClone(PRESETS[input.kind] ?? PRESETS.other)
}

export function processingCommands(channel, preset) {
  const ch = String(channel).padStart(2, '0')
  const base = `/ch/${ch}`
  const commands = [
    { path: `${base}/preamp/hpon`, value: 1 },
    { path: `${base}/preamp/hpf`, value: logarithmic(preset.eq.hpf, 20, 400) },
    { path: `${base}/gate/on`, value: preset.gate.on ? 1 : 0 },
    { path: `${base}/gate/mode`, value: 'GATE' },
    { path: `${base}/gate/thr`, value: linear(preset.gate.threshold, -80, 0) },
    { path: `${base}/gate/range`, value: linear(preset.gate.range, 3, 60) },
    { path: `${base}/gate/attack`, value: linear(preset.gate.attack, 0, 120) },
    { path: `${base}/gate/hold`, value: logarithmic(preset.gate.hold, .02, 2000) },
    { path: `${base}/gate/release`, value: logarithmic(preset.gate.release, 5, 4000) },
    { path: `${base}/dyn/on`, value: preset.compressor.on ? 1 : 0 },
    { path: `${base}/dyn/mode`, value: 'COMP' },
    { path: `${base}/dyn/det`, value: 'RMS' },
    { path: `${base}/dyn/env`, value: 'LOG' },
    { path: `${base}/dyn/thr`, value: linear(preset.compressor.threshold, -80, 0) },
    { path: `${base}/dyn/ratio`, value: preset.compressor.ratio },
    { path: `${base}/dyn/knee`, value: linear(2, 0, 5) },
    { path: `${base}/dyn/mgain`, value: linear(preset.compressor.makeup, 0, 24) },
    { path: `${base}/dyn/attack`, value: linear(preset.compressor.attack, 0, 120) },
    { path: `${base}/dyn/hold`, value: logarithmic(preset.compressor.hold, .02, 2000) },
    { path: `${base}/dyn/release`, value: logarithmic(preset.compressor.release, 5, 4000) },
    { path: `${base}/dyn/pos`, value: 'POST' },
    { path: `${base}/eq/on`, value: 1 }
  ]
  preset.eq.bands.forEach((band, index) => {
    const prefix = `${base}/eq/${index + 1}`
    commands.push({ path: `${prefix}/type`, value: band.type }, { path: `${prefix}/f`, value: eqFrequency(band.f) }, { path: `${prefix}/g`, value: eqGain(band.g) }, { path: `${prefix}/q`, value: eqQ(band.q) })
  })
  return commands.map(command => ({ ...command, section: 'Starting processing' }))
}
