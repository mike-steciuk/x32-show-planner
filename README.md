# The Ferndale Set - Production Desk

A local-first event, artist-advance, and Behringer X32 scene-planning application branded for The Ferndale Set.

## Run it

```powershell
pnpm install
pnpm dev
```

The admin app opens at `http://localhost:5173`. The API listens on all local network interfaces so band intake links can be opened by other devices on the same network. Replace `localhost` in an invite link with the production computer's LAN hostname or IP address when sharing locally.

For a production build:

```powershell
pnpm build
pnpm start
```

## Current features

- Persistent event calendar with dates, venues, load-in times, and X32 scene ranges
- Multiple ordered bands per event
- Private, unguessable intake URL for each band/event combination
- Reusable band library with historical event setups
- Quantity-based audio inventory for cables, microphones, DI boxes, stands, power, and custom gear
- Peak per-band gear-demand calculations with event shortage reporting
- Per-event gear allocation and physical setup checkoffs
- Generated setup, scene-recall, and changeover run-of-show checklist with custom swap steps
- Two-SD8 AES50-A patch planning
- Preferred vocal/instrument channel ordering and colors
- Instrument-aware HPF, four-band EQ, gate, and compressor starting points
- Safe startup mutes, with headamp gain and phantom power deliberately excluded
- One-click event sync that creates a consecutive X32 scene for every band
- X32 simulator, OSC bridge, scene-save support, and multi-channel EQ comparison

Runtime history is stored in `data/store.json` and is excluded from source control. Back up this file with the rest of your show data.

## Sharing intake links outside the venue network

The generated paths are ready for public hosting, but this project does not automatically expose your computer to the internet. Deploy the web/API service behind HTTPS or a trusted authenticated tunnel, and set appropriate network access controls. Never expose the X32's UDP port 10023 directly to the internet.

## Processing presets

Presets are intentionally conservative starting points, not automatic mixing decisions. They configure normalized X32 parameters for HPF, EQ, gate, and compression by source type. Every setting should be verified during line check and soundcheck. The app never guesses preamp gain or enables phantom power.
