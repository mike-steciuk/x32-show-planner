<script setup>
import { computed, onMounted, reactive, ref } from 'vue'

const request = async (path, options = {}) => {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options })
  const data = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(data?.error || 'Request failed')
  return data
}
const clientId = () => globalThis.crypto?.randomUUID?.() ?? 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
const notify = message => { toast.value = message; setTimeout(() => toast.value === message && (toast.value = ''), 2800) }
const source = () => ({ id: clientId(), label: '', instrument: 'guitar', connection: 'amp mic' })
const member = () => ({ id: clientId(), name: '', instrument: 'guitar', connection: 'amp mic', sources: [source()], monitor: 'wedge', vocal: false, notes: '' })
const monitor = (label = '') => ({ id: clientId(), label, kind: 'wedge', color: 'YE', output: '', order: 0 })
const normalizeMember = person => ({ ...person, sources: person.sources?.length ? person.sources : [{ id: clientId(), label: '', instrument: person.instrument || 'guitar', connection: person.connection || 'amp mic' }] })
const legacyMonitors = members => (members || []).filter(person => person.monitor && person.monitor !== 'none').map((person, index) => ({ id: 'mon-' + person.id, memberId: person.id, label: (person.name || 'Player') + (person.monitor === 'iem' ? ' IEM' : ' monitor'), kind: person.monitor, color: person.monitor === 'iem' ? 'CY' : 'YE', output: index + 3 <= 16 ? 'A' + (index + 3) : '', order: index }))
const token = location.pathname.match(/^\/intake\/([^/]+)/)?.[1]
const isIntake = Boolean(token)
const toast = ref('')

const intake = ref(null)
const intakeError = ref('')
const intakeSent = ref(false)
const intakeForm = reactive({ contactName: '', contactEmail: '', notes: '', members: [], monitors: [] })
const submitIntake = async () => {
  try { await request('/api/intake/' + token, { method: 'PUT', body: JSON.stringify(intakeForm) }); intakeSent.value = true; notify('Stage needs saved') }
  catch (error) { notify(error.message) }
}

const tabs = ['events', 'workspace', 'inventory', 'run of show', 'bands', 'console']
const tab = ref('events')
const events = ref([])
const bands = ref([])
const mixer = ref({ mode: 'simulator', connected: true, channels: [] })
const inventory = ref([])
const gearTypes = ref([])
const gearReport = ref({ requirements: [], allocations: [], shortageCount: 0, setupComplete: false })
const gearSelection = ref({})
const newGear = reactive({ name: '', type: 'xlr', quantity: 1, length: '', notes: '' })
const newHouseNeed = reactive({ type: 'pa-speaker', quantity: 1, label: '', notes: '' })
const newStep = reactive({ time: '', title: '', details: '' })
const editingStep = ref(null)
const editStepForm = reactive({ time: '', title: '', details: '' })
const currentEvent = ref(null)
const slotId = ref(null)
const compiled = ref({ inputs: [], sockets: [], outputSockets: [], outputs: { mains: [], monitors: [], warnings: [] }, warnings: [], commands: [] })
const creating = ref(false)
const newEvent = reactive({ name: '', date: new Date().toISOString().slice(0, 10), venue: '', loadIn: '', sceneStart: 0 })
const bandMode = ref('existing')
const bandId = ref('')
const bandName = ref('')
const syncing = ref(false)
const mixerHost = ref('192.168.1.255')
const selectedEq = ref([1, 2, 3, 4])
const draggedInputId = ref('')

const currentSlot = computed(() => currentEvent.value?.bands.find(slot => slot.id === slotId.value))
const today = new Date().toISOString().slice(0, 10)
const upcoming = computed(() => events.value.filter(event => event.date >= today))
const past = computed(() => events.value.filter(event => event.date < today))
const selectedChannels = computed(() => selectedEq.value.map(number => mixer.value.channels?.[number - 1]).filter(Boolean))
const pageTitle = computed(() => tab.value === 'workspace' && currentEvent.value ? currentEvent.value.name : tab.value)
const syncLabel = computed(() => syncing.value ? 'Syncing...' : 'Sync ' + (currentEvent.value?.bands.length || 0) + ' scenes to X32')
const fallbackOutputSockets = Array.from({ length: 16 }, (_, index) => ({ id: 'A' + (index + 1), label: `SD8-${index < 8 ? 1 : 2} \u00b7 OUT ${index % 8 + 1}`, group: 'AES50-A / SD8' }))
const socketGroups = computed(() => Object.entries((compiled.value.sockets ?? []).reduce((groups, socket) => {
  const group = socket.group || 'Inputs'
  ;(groups[group] ||= []).push(socket)
  return groups
}, {})).map(([label, sockets]) => ({ label, sockets })))
const outputSocketGroups = computed(() => Object.entries((compiled.value.outputSockets?.length ? compiled.value.outputSockets : fallbackOutputSockets).reduce((groups, socket) => {
  const group = socket.group || 'Outputs'
  ;(groups[group] ||= []).push(socket)
  return groups
}, {})).map(([label, sockets]) => ({ label, sockets })))
const dateText = date => new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const inviteUrl = slot => location.origin + '/intake/' + slot.intakeToken
const baseColor = code => String(code ?? 'OFF').replace(/_INV$/, '')
const color = code => ({ GN:'#45a36e',CY:'#369db0',WH:'#e6e3dc',YE:'#d8b33a',RD:'#d65343',MG:'#a45b9e',BL:'#527bb5',OFF:'#555' }[baseColor(code)] || '#777')
const colorOptions = [{code:'GN',label:'Green'}, {code:'CY',label:'Light blue'}, {code:'WH',label:'White'}, {code:'YE',label:'Yellow'}, {code:'RD',label:'Red'}, {code:'MG',label:'Magenta'}, {code:'BL',label:'Blue'}, {code:'OFF',label:'Off'}]
const gearLabel = type => gearTypes.value.find(item => item.id === type)?.label || type

const reload = async () => {
  [events.value, bands.value, mixer.value, inventory.value, gearTypes.value] = await Promise.all([request('/api/events'), request('/api/bands'), request('/api/console/state'), request('/api/inventory'), request('/api/inventory/types')])
  if (mixer.value.host || mixer.value.settings?.mixerHost) mixerHost.value = mixer.value.host || mixer.value.settings.mixerHost
}
const loadOperations = async () => {
  if (!currentEvent.value) return
  gearReport.value = await request('/api/events/' + currentEvent.value.id + '/gear')
  const selected = {}
  for (const item of inventory.value) selected[item.id] = { quantity: 0, setup: false, location: '' }
  for (const item of currentEvent.value.gear?.items ?? []) selected[item.inventoryId] = { quantity: item.quantity, setup: item.setup, location: item.location || '' }
  gearSelection.value = selected
}
const compile = async () => {
  if (!currentSlot.value) return compiled.value = { inputs: [], sockets: [], outputSockets: [], outputs: { mains: [], monitors: [], warnings: [] }, warnings: [], commands: [] }
  currentEvent.value.outputPatches ||= { mainL: 'A1', mainR: 'A2' }
  currentEvent.value.outputPatches.mainL ||= 'A1'
  currentEvent.value.outputPatches.mainR ||= 'A2'
  currentSlot.value.channelOverrides ||= {}
  currentSlot.value.monitorPatches ||= {}
  currentSlot.value.monitors ||= legacyMonitors(currentSlot.value.members)
  compiled.value = await request('/api/plan/compile', { method: 'POST', body: JSON.stringify({ members: currentSlot.value.members, monitors: currentSlot.value.monitors, patches: currentSlot.value.patches, channelOverrides: currentSlot.value.channelOverrides, monitorPatches: currentSlot.value.monitorPatches, outputPatches: currentEvent.value.outputPatches }) })
  compiled.value.inputs.forEach((input, index) => currentSlot.value.channelOverrides[input.id] ||= { label: input.label, color: input.color, invert: Boolean(input.invert), icon: input.icon, order: index })
  currentSlot.value.monitors.forEach((item, index) => { item.order ??= index; item.color ||= item.kind === 'iem' ? 'CY' : 'YE'; item.output ||= index + 3 <= 16 ? `A${index + 3}` : '' })
}
const openEvent = async event => { currentEvent.value = await request('/api/events/' + event.id); slotId.value = currentEvent.value.bands[0]?.id; tab.value = 'workspace'; await compile(); await loadOperations() }
const createEvent = async () => {
  try { const event = await request('/api/events', { method:'POST', body:JSON.stringify(newEvent) }); creating.value=false; newEvent.name=''; await reload(); await openEvent(event); notify('Event created') }
  catch (error) { notify(error.message) }
}
const saveEvent = async () => { currentEvent.value = await request('/api/events/' + currentEvent.value.id, { method:'PUT', body:JSON.stringify(currentEvent.value) }); await reload(); notify('Event saved') }
const addBand = async () => {
  const body = bandMode.value === 'existing' ? { bandId: bandId.value } : { name: bandName.value }
  try { const slot = await request('/api/events/' + currentEvent.value.id + '/bands', { method:'POST', body:JSON.stringify(body) }); currentEvent.value=await request('/api/events/'+currentEvent.value.id); slotId.value=slot.id; await reload(); await compile(); notify('Band added') }
  catch (error) { notify(error.message) }
}
const removeBand = async slot => { await request('/api/events/'+currentEvent.value.id+'/bands/'+slot.id,{method:'DELETE'}); currentEvent.value=await request('/api/events/'+currentEvent.value.id); slotId.value=currentEvent.value.bands[0]?.id; await compile() }
const saveSlot = async () => { await request('/api/events/'+currentEvent.value.id+'/bands/'+currentSlot.value.id,{method:'PUT',body:JSON.stringify(currentSlot.value)}); await compile() }
const saveSlotDetails = async () => { await saveSlot(); await reload(); notify('Band workspace details saved') }
const moveInput = async (input, direction) => {
  currentSlot.value.channelOverrides ||= {}
  compiled.value.inputs.forEach((item, index) => currentSlot.value.channelOverrides[item.id] ||= { label: item.label, color: item.color, invert: Boolean(item.invert), icon: item.icon, order: index })
  const index = compiled.value.inputs.findIndex(item => item.id === input.id)
  const swap = compiled.value.inputs[index + direction]
  if (!swap) return
  const currentOrder = currentSlot.value.channelOverrides[input.id].order
  currentSlot.value.channelOverrides[input.id].order = currentSlot.value.channelOverrides[swap.id].order
  currentSlot.value.channelOverrides[swap.id].order = currentOrder
  await saveSlot()
}
const startInputDrag = input => { draggedInputId.value = input.id }
const dropInput = async target => {
  const sourceId = draggedInputId.value
  draggedInputId.value = ''
  if (!sourceId || sourceId === target.id) return
  currentSlot.value.channelOverrides ||= {}
  compiled.value.inputs.forEach((item, index) => currentSlot.value.channelOverrides[item.id] ||= { label: item.label, color: item.color, invert: Boolean(item.invert), icon: item.icon, order: index })
  const ordered = compiled.value.inputs.map(item => item.id)
  const from = ordered.indexOf(sourceId)
  const to = ordered.indexOf(target.id)
  if (from < 0 || to < 0) return
  const [moved] = ordered.splice(from, 1)
  ordered.splice(to, 0, moved)
  ordered.forEach((id, order) => { currentSlot.value.channelOverrides[id].order = order })
  await saveSlot()
}
const addMonitor = async () => { currentSlot.value.monitors ||= []; currentSlot.value.monitors.push({ ...monitor('Monitor ' + (currentSlot.value.monitors.length + 1)), order: currentSlot.value.monitors.length, output: currentSlot.value.monitors.length + 3 <= 16 ? 'A' + (currentSlot.value.monitors.length + 3) : '' }); await saveSlot() }
const moveMonitor = async (index, direction) => { const monitors = currentSlot.value.monitors || []; const swap = monitors[index + direction]; if (!swap) return; [monitors[index], monitors[index + direction]] = [monitors[index + direction], monitors[index]]; monitors.forEach((item, order) => { item.order = order }); await saveSlot() }
const removeMonitor = async item => { currentSlot.value.monitors = (currentSlot.value.monitors || []).filter(candidate => candidate.id !== item.id); currentSlot.value.monitors.forEach((monitor, order) => { monitor.order = order }); await saveSlot() }
const autoPatch = async () => { const patches={}; compiled.value.inputs.slice(0,16).forEach((input,index)=>patches[input.id]='A'+(index+1)); currentSlot.value.patches=patches; await saveSlot(); notify('SD8 patch assigned') }
const copyInvite = async slot => { await navigator.clipboard.writeText(inviteUrl(slot)); notify('Invite link copied') }
const pollSyncJob = async job => {
  let current = job
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 1500))
    current = await request('/api/sync-jobs/' + current.id)
  }
  if (current.status === 'failed') throw new Error(current.error || 'Sync failed')
  return current.result
}
const syncEvent = async () => { syncing.value=true; try { const started=await request('/api/events/'+currentEvent.value.id+'/sync',{method:'POST'}); notify('Sync started: '+started.job.label); const result=await pollSyncJob(started.job); await reload(); currentEvent.value=await request('/api/events/'+currentEvent.value.id); notify(result.scenes.length+' X32 scenes created') } catch(error){ notify(error.message) } finally{ syncing.value=false } }
const syncArtistScene = async () => { if(!currentSlot.value)return; syncing.value=true; try { const started=await request('/api/events/'+currentEvent.value.id+'/bands/'+currentSlot.value.id+'/sync',{method:'POST',body:JSON.stringify({mode:'scene'})}); notify('Sync started: '+started.job.label); const result=await pollSyncJob(started.job); await reload(); currentEvent.value=await request('/api/events/'+currentEvent.value.id); notify('Scene '+result.result.sceneSlot+' synced for '+result.result.bandName) } catch(error){ notify(error.message) } finally{ syncing.value=false } }
const syncArtistChannels = async () => { if(!currentSlot.value)return; syncing.value=true; try { const started=await request('/api/events/'+currentEvent.value.id+'/bands/'+currentSlot.value.id+'/sync',{method:'POST',body:JSON.stringify({mode:'channels'})}); notify('Sync started: '+started.job.label); const result=await pollSyncJob(started.job); notify(result.result.commandCount+' channel commands applied for '+result.result.bandName) } catch(error){ notify(error.message) } finally{ syncing.value=false } }
const syncInputChannel = async input => { if(!currentSlot.value)return; syncing.value=true; try { const started=await request('/api/events/'+currentEvent.value.id+'/bands/'+currentSlot.value.id+'/inputs/'+input.id+'/sync',{method:'POST'}); notify('Sync started: '+started.job.label); const result=await pollSyncJob(started.job); notify('CH '+String(input.channel).padStart(2,'0')+' applied ('+result.result.commandCount+' commands)') } catch(error){ notify(error.message) } finally{ syncing.value=false } }
const useSimulator = async () => { mixer.value=await request('/api/console/mode',{method:'POST',body:JSON.stringify({mode:'simulator'})}); notify('Simulator connected') }
const connect = async () => { try { mixer.value=await request('/api/console/connect',{method:'POST',body:JSON.stringify({host:mixerHost.value})}); notify('X32 connected') } catch(error){ notify(error.message) } }
const addInventory = async () => { if(!newGear.name.trim())return notify('Name the inventory item'); await request('/api/inventory',{method:'POST',body:JSON.stringify(newGear)}); Object.assign(newGear,{name:'',type:'xlr',quantity:1,length:'',notes:''}); await reload(); notify('Inventory item added') }
const saveInventory = async item => { await request('/api/inventory/'+item.id,{method:'PUT',body:JSON.stringify(item)}); await reload(); notify('Inventory updated') }
const removeInventory = async item => { await request('/api/inventory/'+item.id,{method:'DELETE'}); await reload(); notify('Inventory item removed') }
const addHouseNeed = async () => {
  if (!currentEvent.value) return
  currentEvent.value.house ||= { requirements: [] }
  currentEvent.value.house.requirements.push({ id: clientId(), type: newHouseNeed.type, quantity: Math.max(1, Number(newHouseNeed.quantity || 1)), label: newHouseNeed.label || gearLabel(newHouseNeed.type), notes: newHouseNeed.notes || '' })
  Object.assign(newHouseNeed, { type: 'pa-speaker', quantity: 1, label: '', notes: '' })
  await saveEvent(); await loadOperations(); notify('House need added')
}
const removeHouseNeed = async need => { currentEvent.value.house.requirements = currentEvent.value.house.requirements.filter(item => item.id !== need.id); await saveEvent(); await loadOperations(); notify('House need removed') }
const saveGearPlan = async () => { const items=Object.entries(gearSelection.value).filter(([,value])=>Number(value.quantity)>0).map(([inventoryId,value])=>({inventoryId,quantity:Number(value.quantity),setup:Boolean(value.setup),location:value.location||''})); gearReport.value=await request('/api/events/'+currentEvent.value.id+'/gear',{method:'PUT',body:JSON.stringify({items})}); currentEvent.value=await request('/api/events/'+currentEvent.value.id); notify('Show gear plan saved') }
const normalizeRunOrder = () => currentEvent.value?.runOfShow?.forEach((step, index) => { step.order = index }) 
const generateRun = async () => { currentEvent.value.runOfShow=await request('/api/events/'+currentEvent.value.id+'/run-of-show/generate',{method:'POST'}); normalizeRunOrder(); notify('Run of show generated') }
const saveRun = async () => { normalizeRunOrder(); currentEvent.value.runOfShow=await request('/api/events/'+currentEvent.value.id+'/run-of-show',{method:'PUT',body:JSON.stringify({steps:currentEvent.value.runOfShow})}) }
const addRunStep = async () => { if(!newStep.title.trim())return notify('Describe the step'); currentEvent.value.runOfShow.push({id:clientId(),generated:false,completed:false,bandSlotId:null,order:currentEvent.value.runOfShow.length,type:'note',...newStep}); Object.assign(newStep,{time:'',title:'',details:''}); await saveRun(); notify('Run step added') }
const toggleStep = async step => { step.completed=!step.completed; await saveRun() }
const moveRunStep = async (index, direction) => {
  const steps = currentEvent.value.runOfShow
  const swap = index + direction
  if (!steps?.[index] || !steps?.[swap]) return
  ;[steps[index], steps[swap]] = [steps[swap], steps[index]]
  await saveRun()
}
const sortRunByTime = async () => {
  currentEvent.value.runOfShow.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || (a.order ?? 999) - (b.order ?? 999) || a.title.localeCompare(b.title))
  await saveRun()
  notify('Checklist sorted by time')
}
const removeRunStep = async step => { currentEvent.value.runOfShow = currentEvent.value.runOfShow.filter(item => item.id !== step.id); await saveRun(); notify('Checklist item removed') }
const openRunEditor = step => { editingStep.value = step; Object.assign(editStepForm, { time: step.time || '', title: step.title || '', details: step.details || '' }) }
const closeRunEditor = () => { editingStep.value = null; Object.assign(editStepForm, { time: '', title: '', details: '' }) }
const saveRunEditor = async () => { if(!editStepForm.title.trim())return notify('Describe the step'); Object.assign(editingStep.value, editStepForm); await saveRun(); closeRunEditor(); notify('Checklist item updated') }
const changeTab = async item => { tab.value=item; if(item==='run of show') await loadOperations() }
const presetText = input => input.processing.eq.hpf+' Hz HPF / '+(input.processing.gate.on?'gate':'gate off')+' / '+(input.processing.compressor.on?input.processing.compressor.ratio+':1 comp':'comp off')
const eqPath = channel => {
  if (!channel?.eq?.bands?.length) return ''
  const points=[]
  for(let x=0;x<=300;x+=3){const frequency=20*Math.pow(1000,x/300);let gain=0;for(const band of channel.eq.bands){const d=Math.log2(frequency/band.f);if(band.type==='PEQ')gain+=band.g*Math.exp(-d*d*band.q*1.7);if(band.type==='HShv')gain+=band.g/(1+Math.exp(-d*4));if(band.type==='LCut'&&frequency<band.f)gain-=Math.min(18,Math.abs(d)*12)}points.push(x+','+(45-gain*2.35))}
  return 'M'+points.join(' L')
}

onMounted(async () => {
  if (isIntake) {
    try { intake.value=await request('/api/intake/'+token); Object.assign(intakeForm,intake.value.band); intakeForm.members=(intakeForm.members.length?intakeForm.members:[member()]).map(normalizeMember); intakeForm.monitors=(intakeForm.monitors?.length?intakeForm.monitors:legacyMonitors(intakeForm.members)) }
    catch(error){ intakeError.value=error.message }
  } else await reload()
})
</script>

<template>
  <div v-if="isIntake" class="intake-shell">
    <header class="intake-header"><img src="/ferndale-set-logo.jpg" alt="The Ferndale Set"><div><span>ARTIST ADVANCE</span><b>THE FERNDALE SET</b></div></header>
    <main v-if="intakeError" class="center-state"><h1>Link unavailable</h1><p>{{ intakeError }}</p></main>
    <main v-else-if="intakeSent" class="center-state success"><i>OK</i><h1>You're on the set.</h1><p>Your stage needs are saved. We'll see you at load-in.</p></main>
    <main v-else-if="intake" class="intake-main">
      <section class="intake-hero"><div class="date-block"><b>{{ intake.event.date.slice(8) }}</b><span>{{ new Date(intake.event.date+'T12:00:00').toLocaleString('en-US',{month:'short'}).toUpperCase() }}</span></div><div><span>{{ dateText(intake.event.date) }} / {{ intake.event.venue || 'VENUE TBA' }}</span><h1>{{ intake.band.name }}</h1><p>Tell us who is playing and what needs a cable. We'll build your channel list, patch, and starting console scene.</p></div></section>
      <form @submit.prevent="submitIntake">
        <section class="form-section"><b>01</b><div><h2>Band contact</h2><div class="form-grid"><label>Your name<input v-model="intakeForm.contactName" required></label><label>Email<input v-model="intakeForm.contactEmail" type="email"></label></div></div></section>
        <section class="form-section"><b>02</b><div><header><div><h2>Players & inputs</h2><p>Add every instrument or guitar that needs its own mixer input.</p></div><button type="button" class="outline" @click="intakeForm.members.push(member())">+ Add player</button></header>
          <article v-for="(person,index) in intakeForm.members" :key="person.id" class="player multi-source-player">
            <strong>{{ String(index+1).padStart(2,'0') }}</strong>
            <div class="player-identity"><label>Player name<input v-model="person.name" required></label><label>Monitor<select v-model="person.monitor"><option value="wedge">Wedge</option><option value="iem">IEM</option><option value="none">None</option></select></label><label class="vocal"><input v-model="person.vocal" type="checkbox"> Also needs a vocal mic</label></div>
            <div class="source-list"><div class="source-list-head"><span>Individual input sources</span><button type="button" @click="person.sources.push(source())">+ Add instrument</button></div>
              <div v-for="(item,sourceIndex) in person.sources" :key="item.id" class="source-row"><b>{{ sourceIndex+1 }}</b><label>Label<input v-model="item.label" :placeholder="person.name ? person.name+' instrument' : 'e.g. Blue Tele'"></label><label>Instrument<select v-model="item.instrument"><option>guitar</option><option>bass</option><option>drums</option><option>keys</option><option>brass</option><option>strings</option><option>playback</option><option>other</option></select></label><label>Connection<select v-model="item.connection"><option>microphone</option><option>condenser microphone</option><option>amp mic</option><option>DI</option><option>stereo DI</option><option>kit</option><option>line</option></select></label><button type="button" class="x" :disabled="person.sources.length===1" @click="person.sources=person.sources.filter(sourceItem=>sourceItem.id!==item.id)">Remove</button></div>
            </div>
            <button type="button" class="x player-remove" @click="intakeForm.members=intakeForm.members.filter(item=>item.id!==person.id)">Remove player</button>
          </article>
        </div></section>
        <section class="form-section"><b>03</b><div><header><div><h2>Monitor mixes</h2><p>Add the monitor outputs the band expects. You can refine bus order and physical outputs later.</p></div><button type="button" class="outline" @click="intakeForm.monitors.push({...monitor('Monitor '+(intakeForm.monitors.length+1)),order:intakeForm.monitors.length})">+ Add monitor</button></header><article v-for="(mix,index) in intakeForm.monitors" :key="mix.id" class="monitor-intake-row"><b>{{ index+1 }}</b><label>Mix name<input v-model="mix.label" placeholder="Zach monitor"></label><label>Type<select v-model="mix.kind"><option value="wedge">Wedge</option><option value="iem">IEM</option></select></label><button type="button" class="x" @click="intakeForm.monitors=intakeForm.monitors.filter(item=>item.id!==mix.id)">Remove</button></article></div></section><section class="form-section"><b>04</b><div><h2>Stage notes</h2><label>Anything unusual?<textarea v-model="intakeForm.notes" rows="4"></textarea></label></div></section>
        <footer class="submit-bar"><p>Your answers become a reusable setup for future Ferndale Set events.</p><button class="solid">Send stage needs</button></footer>
      </form>
    </main>
  </div>

  <div v-else class="admin-shell">
    <aside><div class="brand"><img src="/ferndale-set-logo.jpg" alt=""><div><b>THE FERNDALE SET</b><span>Production desk</span></div></div><nav><button v-for="(item,index) in tabs" :key="item" :class="{active:tab===item}" @click="changeTab(item)"><i>0{{ index+1 }}</i>{{ item }}</button></nav><div class="mixer"><i :class="{on:mixer.connected}"></i><span><b>{{ mixer.model || 'Mixer offline' }}</b><small>{{ mixer.mode }}</small></span></div><small class="motto">MUSIC / COMMUNITY / FERNDALE</small></aside>
    <main><header class="top"><div><span>THE FERNDALE SET / PRODUCTION</span><h1>{{ pageTitle }}</h1></div><button v-if="tab==='events'" class="solid" @click="creating=!creating">+ New event</button><button v-if="tab==='workspace'&&currentEvent" class="solid" :disabled="syncing||!currentEvent.bands.length" @click="syncEvent">{{ syncLabel }}</button></header>

      <section v-if="tab==='events'" class="page">
        <form v-if="creating" class="new-event" @submit.prevent="createEvent"><div><span>NEW PRODUCTION</span><h2>Create an event</h2></div><label>Name<input v-model="newEvent.name" required></label><label>Date<input v-model="newEvent.date" type="date"></label><label>Venue<input v-model="newEvent.venue"></label><label>Load-in<input v-model="newEvent.loadIn" type="time"></label><label>First scene<input v-model.number="newEvent.sceneStart" type="number" min="0" max="99"></label><button class="solid">Create</button></form>
        <div class="intro"><div><span>CALENDAR</span><h2>Upcoming sets</h2></div><p>Every event contains its lineup, artist links, stage patches, and X32 scenes.</p></div><div class="event-grid"><button v-for="event in upcoming" :key="event.id" class="event-card" @click="openEvent(event)"><div class="event-date"><b>{{ event.date.slice(8) }}</b><span>{{ new Date(event.date+'T12:00:00').toLocaleString('en-US',{month:'short'}).toUpperCase() }}</span></div><div><span>{{ event.venue||'VENUE TBA' }}</span><h3>{{ event.name }}</h3><p>{{ event.bands.length }} bands / scenes {{ event.sceneStart }}-{{ Math.max(event.sceneStart,event.sceneStart+event.bands.length-1) }}</p></div><i>{{ event.status }}</i></button><button v-if="!upcoming.length" class="empty-event" @click="creating=true">+ Schedule the first event</button></div>
        <div v-if="past.length" class="past"><div class="intro"><div><span>ARCHIVE</span><h2>Past events</h2></div></div><button v-for="event in past" :key="event.id" @click="openEvent(event)"><span>{{ dateText(event.date) }}</span><b>{{ event.name }}</b><span>{{ event.venue }}</span><em>{{ event.bands.length }} bands</em><i>Open</i></button></div>
      </section>

      <section v-else-if="tab==='workspace'" class="page">
        <div v-if="!currentEvent" class="center-state"><h2>Choose an event first.</h2><button class="solid" @click="tab='events'">Browse events</button></div>
        <template v-else><div class="event-meta"><label>Date<input v-model="currentEvent.date" type="date"></label><label>Venue<input v-model="currentEvent.venue"></label><label>Load-in<input v-model="currentEvent.loadIn" type="time"></label><label>First scene<input v-model.number="currentEvent.sceneStart" type="number"></label><button class="outline" @click="saveEvent">Save details</button></div><section class="house-panel"><div><span>HOUSE NEEDS</span><h3>Venue & production extras</h3><p>Add gear that is not tied to a specific band, like PA speakers, spare microphones, power, or anything special for the room.</p></div><form @submit.prevent="addHouseNeed"><label>Gear type<select v-model="newHouseNeed.type"><option v-for="type in gearTypes" :key="type.id" :value="type.id">{{ type.label }}</option></select></label><label>Qty<input v-model.number="newHouseNeed.quantity" type="number" min="1"></label><label>Label<input v-model="newHouseNeed.label" :placeholder="gearLabel(newHouseNeed.type)"></label><label>Notes<input v-model="newHouseNeed.notes" placeholder="House L/R, spare announcement mic..."></label><button class="solid">Add</button></form><div class="house-list"><button v-for="need in currentEvent.house?.requirements || []" :key="need.id" @click="removeHouseNeed(need)"><b>{{ need.quantity }} x {{ need.label || gearLabel(need.type) }}</b><small>{{ need.notes || gearLabel(need.type) }}</small><em>Remove</em></button><p v-if="!currentEvent.house?.requirements?.length">No house extras yet.</p></div></section><div class="workspace"><aside class="lineup"><header><span>RUNNING ORDER</span><b>{{ currentEvent.bands.length }}</b></header><button v-for="slot in currentEvent.bands" :key="slot.id" :class="{active:slot.id===slotId}" @click="slotId=slot.id;compile()"><i>{{ String(slot.sceneSlot).padStart(2,'0') }}</i><span><b>{{ slot.bandName }}</b><small>{{ slot.intakeStatus }}</small></span><em>{{ slot.intakeStatus==='submitted'?'OK':'-' }}</em></button><div class="add-band"><div><button :class="{active:bandMode==='existing'}" @click="bandMode='existing'">Library</button><button :class="{active:bandMode==='new'}" @click="bandMode='new'">New</button></div><select v-if="bandMode==='existing'" v-model="bandId"><option value="">Choose saved band...</option><option v-for="band in bands" :key="band.id" :value="band.id">{{ band.name }}</option></select><input v-else v-model="bandName" placeholder="Band name"><button class="solid" @click="addBand">+ Add band</button></div></aside><div v-if="currentSlot" class="slot"><header class="slot-head"><div><span>SCENE {{ currentSlot.sceneSlot }}</span><h2>{{ currentSlot.bandName }}</h2><p>{{ currentSlot.members.length?currentSlot.members.length+' players / '+compiled.inputs.length+' inputs':'Waiting for artist advance' }}</p></div><div class="slot-actions"><button class="outline" :disabled="syncing" @click="syncArtistChannels">Apply channels</button><button class="solid" :disabled="syncing" @click="syncArtistScene">Sync artist scene</button><button @click="removeBand(currentSlot)">Remove</button></div></header><div class="band-editor"><label>Band display name<input v-model="currentSlot.bandName" @change="saveSlotDetails"></label><label>Set time<input v-model="currentSlot.setTime" type="time" @change="saveSlotDetails"></label><label>Band / scene notes<input v-model="currentSlot.notes" @change="saveSlotDetails" placeholder="Anything to remember at line check"></label><button class="outline" @click="saveSlotDetails">Save band</button></div><div class="invite"><div><span>DEDICATED ARTIST LINK</span><code>{{ inviteUrl(currentSlot) }}</code></div><button class="outline" @click="copyInvite(currentSlot)">Copy link</button><a :href="inviteUrl(currentSlot)" target="_blank">Open</a></div><div v-if="!currentSlot.members.length" class="waiting"><h3>Waiting on the band</h3><p>Send their private link. The submission will populate this scene and the reusable band library.</p></div><template v-else><div class="section-title"><div><span>INPUT PLAN</span><h3>Channels & starting processing</h3></div><div class="sync-actions"><button class="outline" @click="autoPatch">Auto-patch SD8s</button><button class="outline" :disabled="syncing" @click="syncArtistChannels">Apply artist channels only</button></div></div><div class="input-table"><div class="input-heading"><span>CH</span><span>CHANNEL</span><span>STARTING POINT</span><span>PHYSICAL INPUT</span></div><div v-for="input in compiled.inputs" :key="input.id" class="input-row editable-input" draggable="true" @dragstart="startInputDrag(input)" @dragover.prevent @drop="dropInput(input)"><b class="drag-channel"><span class="drag-handle">Drag</span>{{ String(input.channel).padStart(2,'0') }}</b><span class="input-name"><i :style="{background:color(currentSlot.channelOverrides[input.id]?.color || input.color)}"></i><label>Name<input v-model="currentSlot.channelOverrides[input.id].label" @change="saveSlot"></label><label>Color<select v-model="currentSlot.channelOverrides[input.id].color" @change="saveSlot"><option v-for="option in colorOptions" :key="option.code" :value="option.code">{{ option.label }}</option></select></label><label class="invert-strip"><input v-model="currentSlot.channelOverrides[input.id].invert" type="checkbox" @change="saveSlot"> Invert strip</label><small>{{ input.memberName }} / {{ input.connection }}</small></span><span class="preset"><b>{{ presetText(input) }}</b><small>Verify at soundcheck</small><button class="outline mini-action" :disabled="syncing" @click="syncInputChannel(input)">Apply this channel</button></span><select v-model="currentSlot.patches[input.id]" @change="saveSlot"><option value="">Unassigned</option><optgroup v-for="group in socketGroups" :key="group.label" :label="group.label"><option v-for="socket in group.sockets" :key="socket.id" :value="socket.id">{{ socket.label }}</option></optgroup></select></div></div><div class="output-map"><div class="section-title"><div><span>OUTPUT PLAN</span><h3>PA & monitor buses</h3></div></div><div class="main-output-patch"><label>Main L output<select v-model="currentEvent.outputPatches.mainL" @change="saveEvent"><optgroup v-for="group in outputSocketGroups" :key="group.label" :label="group.label"><option v-for="socket in group.sockets" :key="socket.id" :value="socket.id">{{ socket.label }}</option></optgroup></select></label><label>Main R output<select v-model="currentEvent.outputPatches.mainR" @change="saveEvent"><optgroup v-for="group in outputSocketGroups" :key="group.label" :label="group.label"><option v-for="socket in group.sockets" :key="socket.id" :value="socket.id">{{ socket.label }}</option></optgroup></select></label></div><div class="output-grid"><article v-for="main in compiled.outputs?.mains || []" :key="main.id"><span>MAIN</span><b>{{ main.label }}</b><small>Named {{ main.name }} ? starts on</small></article></div><div class="monitor-editor"><div class="monitor-editor-head"><span>MONITOR OUTPUTS</span><button class="outline" @click="addMonitor">+ Add monitor</button></div><article v-for="(mix,index) in currentSlot.monitors || []" :key="mix.id" class="monitor-edit-row"><b><button class="nudge" @click="moveMonitor(index,-1)">Up</button>BUS {{ String(index+1).padStart(2,'0') }}<button class="nudge" @click="moveMonitor(index,1)">Down</button></b><label>Name<input v-model="mix.label" @change="saveSlot"></label><label>Color<select v-model="mix.color" @change="saveSlot"><option v-for="option in colorOptions" :key="option.code" :value="option.code">{{ option.label }}</option></select></label><label>Output<select v-model="mix.output" @change="saveSlot"><optgroup v-for="group in outputSocketGroups" :key="group.label" :label="group.label"><option value="">Unassigned</option><option v-for="socket in group.sockets" :key="socket.id" :value="socket.id">{{ socket.label }}</option></optgroup></select></label><button class="remove-step" @click="removeMonitor(mix)">Remove</button></article></div><p v-if="compiled.outputs?.warnings?.length" class="plan-warning">{{ compiled.outputs.warnings.join('; ') }}</p></div></template></div></div></template>
      </section>

      <section v-else-if="tab==='inventory'" class="page"><div class="intro"><div><span>GEAR CAGE</span><h2>Audio inventory</h2></div><p>Track owned quantities so each event can expose shortages before load-in.</p></div>
        <form class="inventory-add" @submit.prevent="addInventory"><label>Item name<input v-model="newGear.name" placeholder="25 ft XLR"></label><label>Gear type<select v-model="newGear.type"><option v-for="type in gearTypes" :key="type.id" :value="type.id">{{ type.label }}</option></select></label><label>Quantity<input v-model.number="newGear.quantity" type="number" min="0"></label><label>Length / variant<input v-model="newGear.length" placeholder="25 ft, SM58..."></label><label>Notes<input v-model="newGear.notes"></label><button class="solid">Add item</button></form>
        <div v-if="!inventory.length" class="waiting"><h3>No gear recorded yet</h3><p>Start with XLR cables, vocal microphones, instrument microphones, DI boxes, and stands.</p></div><div class="inventory-grid"><article v-for="item in inventory" :key="item.id"><span>{{ gearTypes.find(type=>type.id===item.type)?.label || item.type }}</span><input v-model="item.name"><div><label>Owned<input v-model.number="item.quantity" type="number" min="0"></label><label>Variant<input v-model="item.length"></label></div><textarea v-model="item.notes" rows="2" placeholder="Condition, case, location..."></textarea><footer><button class="outline" @click="saveInventory(item)">Save</button><button @click="removeInventory(item)">Remove</button></footer></article></div>
      </section>

      <section v-else-if="tab==='run of show'" class="page"><div v-if="!currentEvent" class="center-state"><h2>Choose an event first.</h2><button class="solid" @click="tab='events'">Browse events</button></div><template v-else><div class="intro"><div><span>SHOW OPERATIONS</span><h2>{{ currentEvent.name }}</h2></div><p>Allocate the gear traveling to this show, mark setup progress, and work through changeovers in order.</p></div>
        <div class="gear-summary"><article><span>Calculated demand</span><b>{{ gearReport.requirements.reduce((sum,item)=>sum+item.required,0) }}</b><small>Peak across all bands</small></article><article :class="{alert:gearReport.shortageCount}"><span>Missing items</span><b>{{ gearReport.shortageCount }}</b><small>{{ gearReport.shortageCount?'Additional gear needed':'Inventory covers the plan' }}</small></article><article><span>Setup status</span><b>{{ gearReport.allocations.filter(item=>item.setup).length }}/{{ gearReport.allocations.length }}</b><small>Allocated groups ready</small></article></div>
        <div class="ops-grid"><section><div class="section-title"><div><span>GEAR PLAN</span><h3>Demand & setup</h3></div><button class="solid" @click="saveGearPlan">Save gear plan</button></div><div class="requirement-list"><div v-for="requirement in gearReport.requirements" :key="requirement.type" :class="{short:requirement.shortage}"><b>{{ requirement.label }}</b><span>{{ requirement.allocated }} allocated / {{ requirement.required }} needed</span><em v-if="requirement.shortage">Need {{ requirement.shortage }} more</em></div></div><div class="allocation-table"><div class="allocation-head"><span>SETUP</span><span>INVENTORY ITEM</span><span>BRING</span><span>LOCATION / NOTES</span></div><div v-for="item in inventory" :key="item.id" class="allocation-row"><input v-model="gearSelection[item.id].setup" type="checkbox" :disabled="!gearSelection[item.id].quantity"><span><b>{{ item.name }}</b><small>{{ item.quantity }} owned</small></span><input v-model.number="gearSelection[item.id].quantity" type="number" min="0" :max="item.quantity"><input v-model="gearSelection[item.id].location" placeholder="Stage left, case A..."></div></div></section>
          <section><div class="section-title"><div><span>RUN OF SHOW</span><h3>Live checklist</h3></div><div class="run-actions"><button class="outline" @click="sortRunByTime">Sort by time</button><button class="outline" @click="generateRun">Generate standard steps</button></div></div><form class="step-add simple-step-add" @submit.prevent="addRunStep"><input v-model="newStep.time" type="time"><input v-model="newStep.title" placeholder="Add checklist item"><input v-model="newStep.details" placeholder="Details"><button class="solid">Add</button></form><div class="run-list compact-run-list"><article v-for="(step,index) in currentEvent.runOfShow" :key="step.id" :class="{done:step.completed}"><button class="check" @click="toggleStep(step)">{{ step.completed?'OK':'' }}</button><div class="run-order"><button @click="moveRunStep(index,-1)">Up</button><button @click="moveRunStep(index,1)">Down</button></div><time>{{ step.time||'--:--' }}</time><span><b>{{ step.title }}</b><small>{{ step.details }}</small></span><em>{{ step.generated?'AUTO':'CUSTOM' }}</em><button class="icon-step" title="Edit" @click="openRunEditor(step)">Edit</button><button class="remove-step" @click="removeRunStep(step)">Remove</button></article><p v-if="!currentEvent.runOfShow.length">Allocate gear, then generate the standard setup and scene cues. Add your own swap steps anywhere.</p></div></section></div></template>
      </section>

      <section v-else-if="tab==='bands'" class="page"><div class="intro"><div><span>ARTIST MEMORY</span><h2>Band library</h2></div><p>Current requirements plus every historical console setup.</p></div><div class="band-grid"><article v-for="band in bands" :key="band.id"><div class="monogram">{{ band.name.split(/\s+/).map(word=>word[0]).join('').slice(0,3) }}</div><span>SAVED ARTIST</span><h3>{{ band.name }}</h3><p>{{ band.members.length }} players / {{ band.setups?.length||0 }} historical setups</p><details><summary>Setup history</summary><em v-if="!band.setups?.length">No synced scenes yet.</em><div v-for="setup in [...(band.setups||[])].reverse()" :key="setup.id" class="history"><span>{{ dateText(setup.date) }}</span><b>{{ setup.eventName }}</b><small>Scene {{ setup.sceneSlot }} / {{ setup.inputs.length }} inputs</small></div></details></article></div></section>

      <section v-else class="page"><div class="console-bar"><div><i></i><span><b>{{ mixer.model }}</b><small>{{ mixer.mode }} / firmware {{ mixer.firmware }}</small></span></div><label>Console IP<input v-model="mixerHost"></label><button class="solid" @click="connect">Connect X32</button><button class="outline" @click="useSimulator">Simulator</button></div><div class="intro"><div><span>LIVE LENS</span><h2>Compare channel EQ</h2></div><p>Select up to four channels.</p></div><div class="channel-picker"><button v-for="channel in mixer.channels?.slice(0,32)" :key="channel.number" :class="{active:selectedEq.includes(channel.number)}" @click="selectedEq.includes(channel.number)?selectedEq=selectedEq.filter(n=>n!==channel.number):selectedEq.length<4&&selectedEq.push(channel.number)"><i :style="{background:color(channel.color)}"></i>{{ String(channel.number).padStart(2,'0') }}</button></div><div class="eq-grid"><article v-for="channel in selectedChannels" :key="channel.number"><header><span>CH {{ String(channel.number).padStart(2,'0') }}</span><h3>{{ channel.name }}</h3><b>{{ channel.eq.on?'ON':'OFF' }}</b></header><svg viewBox="0 0 300 90" preserveAspectRatio="none"><path class="gridline" d="M0 15H300M0 45H300M0 75H300M75 0V90M150 0V90M225 0V90"/><path class="curve" :style="{stroke:color(channel.color)}" :d="eqPath(channel)"/></svg><footer><span v-for="band in channel.eq.bands" :key="band.f"><b>{{ band.type }}</b>{{ Math.round(band.f) }} Hz / {{ band.g.toFixed(1) }} dB</span></footer></article></div></section>
    </main>
  </div>
  <div v-if="editingStep" class="modal-backdrop" @click.self="closeRunEditor">
    <form class="modal-card" @submit.prevent="saveRunEditor">
      <header><div><span>CHECKLIST ITEM</span><h2>Edit run step</h2></div><button type="button" @click="closeRunEditor">Close</button></header>
      <label>Time<input v-model="editStepForm.time" type="time"></label>
      <label>Title<input v-model="editStepForm.title" required></label>
      <label>Details<textarea v-model="editStepForm.details" rows="4"></textarea></label>
      <footer><button type="button" class="outline" @click="closeRunEditor">Cancel</button><button class="solid">Save item</button></footer>
    </form>
  </div>
  <transition name="toast"><div v-if="toast" class="toast">{{ toast }}</div></transition>
</template>
