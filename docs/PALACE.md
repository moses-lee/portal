# Palace: the room behind Portal

Date: 2026-10-08. Status: **plan agreed with Moses on 2026-10-08; all five phases built on branch `background` by 2026-10-09 (section As built), not merged.** Still owed: the Safari timeline on an M1 and an iPhone 13. Research behind it: `docs/PALACE-RESEARCH.md`.

## Why

Portal's background is two AI-generated photos of a room, switched at 7am and 7pm, behind frosted-glass panels. It is pleasant and anonymous. The app is going to be renamed Palace, and the idea is that it should feel like an actual place of yours: one room that keeps your clock and your weather, has things living in it, and fills up with objects that each stand for something Portal did with you. Nothing in it is arbitrary and nothing in it ever decays.

This spec replaces the photos with a procedurally assembled, subtly animated 3D room rendered in the browser, lit by the real sun at your location, with the weather outside the window, and furnished from Portal's own data.

## Vocabulary

- **Room**: the one 3D scene behind every Portal view. There is one per install, not one per project or session.
- **Shell**: the fixed parts: floor, back wall with the window, left wall, rug. Authored once, never generated.
- **Anchor**: a named place on the shell where a piece of furniture sits (desk, shelf, sill, hearth, wall, floor).
- **Slot**: a numbered position on a piece of furniture that one object can occupy (a shelf row has book slots, the sill has plant slots).
- **Live object**: an object whose state follows what is happening now (robots, lamp, mail tray, hearth, kettle, window).
- **Accumulated object**: an object that stands for something that happened and stays (books, notes, plants, frames, keys, the tree).
- **Census**: the counts the server computes for the accumulated objects, with high-water marks so they never go down.
- **Milestone**: a census threshold at which the room gains furniture or grows.
- **Environment**: the location, sun and weather the server resolves for the room.
- **Frost**: the blurred, saturated copy of the room that shows through UI panels, rendered in WebGL (the CSS blur goes away for those panels).

## Decisions on record

| # | Topic | Decision |
|---|---|---|
| 1 | One room | One room for the whole app. Projects and sessions churn too fast to own rooms. Attachment needs one stable place. |
| 2 | Rendering | Real 3D in the browser: three.js through react-three-fiber on WebGL. No AI images, no splats, no WebGPU. |
| 3 | Look | Cozy in the Animal Crossing spirit, not a copy: rounded low-poly shapes, matte flat colours sharing one roughness, a warm key light and a cool fill, soft shadows, baked corner darkening, a low-contrast tone mapper (AgX) so pastels stay pastel. No outlines. |
| 4 | Motion | Subtle only: lighting drifts with the sun, plants sway, the lamp flickers, the hearth burns, robots move, weather falls. Frame rate capped at 24. Paused when the tab is hidden, under reduced motion, and under Low Power Mode. |
| 5 | Camera | Three-quarter diorama: looking slightly down into the room from the missing fourth wall, long lens, fixed, with a 1.5° drift over 60 s and a tiny pointer parallax. The scene centre shifts into whatever region the UI leaves uncovered. |
| 6 | Composition | Designed for the desktop margins beside the chat column plus the start page and Portal home, where most of the room shows, and the Palace page (decision 21), where all of it does. Phones get a 72 px room strip above the pane header framing the window and shelf tops; tapping it opens the Palace page. |
| 7 | Sun | Light angle and colour from the real sun (altitude and azimuth from location and time), not from the clock hour. Moon phase and stars at night. |
| 8 | Weather | Live conditions at the server's public-IP location, through the window: clear, clouds, overcast, rain, snow, fog, thunder, with day or night. From Open-Meteo, keyless, with its credit link in the window's hover card. |
| 9 | Location | Resolved on the server from its own public IP (clients on Tailscale arrive from private addresses), overridable by `PORTAL_LOCATION=lat,lon`. Never a browser location prompt. Zero-network fallback: latitude from the IANA time zone. |
| 10 | Objects | Twelve objects, each bound to one Portal fact (table below). Live ones change with the present; accumulated ones only ever add. |
| 11 | No decay | Nothing withers, dusts over, breaks, or is taken away. A removed watch's plant moves to the plant stand; purged sessions keep their books. |
| 12 | Counts | Literal up to a cap per object, then bucketed, so the room never becomes clutter. |
| 13 | Stability | Every object's look and slot comes from a hash of its id. Adding one item never reshuffles the others. The layout generator is versioned; an update never silently rearranges the room. |
| 14 | Growth | The room expands at milestones: more shelving, a ladder, a reading nook, a bigger window. Milestones are computed from high-water marks so they never reverse. Each one is logged to Activity so it shows in the log and the orchestrator can mention it. |
| 15 | Hover and click | Hovering any object shows a card naming it and what it stands for, with its numbers and where a click goes. Every object navigates on click (robot → its session, mail tray → Needs you, book → that session, plant → Watches, note → Memory, frame → the project, key → the approvals dialog, hearth → Activity, kettle → the jobs view, window → the card only). On phones, tap shows the card with a button that navigates. |
| 16 | Portal's presence | Portal is the room's owner, shown through the desk and lamp. No character of its own for now. |
| 17 | Glass | Frosted panels stay. The frost is rendered inside WebGL (scene to texture, quarter-resolution blur, panel rectangles composited in the same pass); the DOM panels carry only a tint. CSS `backdrop-filter` remains only on small transient dialogs, menus and sheets, and the scene slows to 6 fps while one is open. Solid panels only as the reduced-transparency fallback. |
| 18 | Lighting control | Removed. The room always follows the real sun. `RoomModeControl`, the `portal.room.mode` preference and their tests go. |
| 19 | Rename | Not in this work. "Rooms" for sessions and "foyer" for the attention card stay as they are. |
| 20 | Libraries | `three`, `@react-three/fiber`, a few pieces of `@react-three/drei`, `suncalc`. Blur passes written by hand (three small shaders), no postprocessing dependency. Assets from CC0 kits (KayKit Furniture Bits, Kenney Furniture Kit, Quaternius Ultimate House Interior) merged into one meshopt-compressed GLB; robots, books and plants built from primitives so they can be coloured per item. |
| 21 | Palace page | A new Portal view, `/palace`, with a sidebar entry "Palace" under the Portal heading. It shows nothing but the room: no header text, no status line, no tracked panel, no composer. The whole viewport is the room, with the sidebar still beside it on desktop. It is the place to look at the room and play with it: hover cards, clicks, and a look-around camera (section Palace page). |
| 22 | Active session | A robot exists for every session in state connecting, working, background, approval or hung. A finished session's robot walks out of the door and is gone; there is no sleeping state. |
| 23 | Milestones | The table in section Milestones, as written. |
| 24 | No-WebGL fallback | A CSS gradient sky and the dark veil. The two photos are deleted. |
| 25 | Settled | Every point raised during planning is answered above; the build follows this document without further questions. |

## The room

### Shell and anchors

Front-on view with the fourth wall missing. Back wall carries the window centre-left and the hearth on the right. Left wall carries the shelving. The desk sits under the window with the lamp and chair. The rug is centre floor, where robots walk. The door is on the right edge with the mail tray and key rack beside it. The sill is under the window. Wall slots for frames sit above the desk.

Anchors are an authored list, not generated. Furniture declares its own slots: rows, slots per row, accepted kind, pitch. Growth is an ordered fill: `slot = hash(itemId) mod capacity`, walking to the next free slot on collision. Gaps are fine.

### Camera

Perspective, vertical FOV about 30°, far from the room, yaw about 25°, pitch about 25°. `camera.setViewOffset` shifts the projection so the room's centre of interest lands in the uncovered region: computed from the live layout (sidebar width, GitHub inspector width, the chat column's left and right margins), updated on layout change only. Aspect breakpoints, not width: below an aspect of 0.8 the camera pulls back and rises, and the back wall becomes the hero. One room layout for every screen; phones crop, they do not re-layout.

A 1.5° sinusoidal drift over 60 s and a pointer parallax of at most 0.5°, both off under reduced motion.

### Lighting

- One `DirectionalLight` is the sun: direction from `suncalc` altitude and azimuth once a minute, colour from a Kelvin ramp on altitude (about 2200 K at the horizon to 5800 K high), intensity with `smoothstep` on altitude. Below the horizon it becomes the moon: dim, cool, from the moon's position.
- One `HemisphereLight` for sky and ground colours from the same ramp.
- One shadowless warm `PointLight` at the lamp and one at the hearth, intensities driven by their objects.
- Shadows: the sun casts one 1024 shadow map (512 on phones) with a tight frustum around the room; `shadowMap.autoUpdate` off, `needsUpdate` when the sun moves or a robot moves.
- Sky: a gradient dome from the ramp; a thousand stars toggled by visibility; a moon sprite shaded by phase. No scattering sky, no dynamic environment map.
- Tone mapping AgX, exposure about 1.1. Fog density rises on grey days.
- Everything that changes the shader cache key (lights, fog, maps) is mounted at start and driven by intensity or visibility, so crossfades never recompile.

### Weather through the window

Weather code → one of: clear, partly cloudy, overcast, fog, drizzle, rain, heavy rain, snow, thunderstorm; plus day or night. Rain and snow are 300 to 600 points in a box outside the glass, moved in the vertex shader. Clouds are four to six scrolled soft sprites tinted by the sky. Thunder flashes the sky colour briefly. Fog sets the dome and fog density. No wet-glass droplet effect.

### Objects

Live objects, from what is happening now. Data sources are the ones the page already holds.

| Object | Source | Behaviour |
|---|---|---|
| Toy robots | Session list (`useSessions`): every session in state connecting, working, background, approval or hung | One robot per session; body colour, head shape and antenna from a hash of the session id; a badge glyph for the agent kind. Working or background: at a tiny bench, arms moving. Waiting on you (approval): standing by the door, facing the camera, with a raised sign. Hung: tipped over with a spark. Connecting: walks in through the door with a boot blink. Finished or deleted: walks out of the door over 1.5 s and is gone. Tracked sessions wear a scarf. More than eight: the rest queue by the door with a count in the hover card. |
| Desk lamp and chair | Orchestrator status (`busy`) | Lamp on and papers shuffling during a chat turn; dim glow when idle; off at night only when idle for an hour. |
| Mail tray by the door | Status counts (`needsYou`, `approvals`) | One envelope per needs-you item, a sealed one per pending approval, stacked up to twelve then a pile with a number. |
| Hearth | Census `activityLastHour` | Cold under 3 entries, embers to 20, a full fire past that. |
| Kettle on the stove | Status `runs` with a background job | Steams while a job run is in progress. |
| Window | Environment | Sun, moon, stars, weather. |

Accumulated objects, from the census. Each is capped and then bucketed.

| Object | Source | Behaviour |
|---|---|---|
| Books | `sessionsEver` (high-water of sessions created) | One book per session on the shelves; spine colour from the session's project hash, neutral when the project is gone; height and thickness from the session id. Shelves fill a row of 24 at a time. |
| Corkboard | `memoryActive`, `memoryInbox` | One pinned note per active record (pinned records get a brighter pin); unreviewed inbox items lie loose on the desk until filed. Cap 60 notes then layered. |
| Plants on the sill | Watches: `active`, `finished`, `fires` | One plant per active watch on the sill (species from the id); each fire adds a bloom up to five; finished watches move to the plant stand by the hearth. Cap 6 on the sill, 8 on the stand, then a bucket count. |
| Framed pictures | Pinned projects (`useProjects`) | One frame per pin above the desk, colour and frame style from the project hash. Cap 6 then a gallery row. |
| Key rack | `grants` (standing approval grants) | One key per grant by the door. Cap 8. |
| Tree outside | `since` (first session, stored once) | Sapling to 30 days, young to 180, full at 365, big past 730; leaves follow the season at the location's hemisphere. |

### Milestones

Computed from high-water marks on the server, logged to Activity as `room.expanded` with a sentence ("The room gained a rolling ladder at 150 sessions"), and announced in the room with a short delivery animation (a crate slides in and opens). The table, all additive:

| Trigger | Expansion |
|---|---|
| 25 sessions | The small shelf becomes a tall bookcase. |
| 75 sessions | A second bookcase on the left wall. |
| 150 sessions | A rolling ladder on the bookcases. |
| 300 sessions | A reading nook in the corner: armchair, floor lamp, side table. |
| 600 sessions | The window becomes a bay window with a window seat. |
| 50 memory records | The corkboard becomes a wide pinboard. |
| 200 memory records | A map on the wall beside it. |
| 10 watches ever | A window box outside the sill. |
| 100 watch fires | A wind chime by the window. |
| 1 year since first session | A second rug and a cat asleep on the chair. |

The thresholds are a table in shared code so tuning is one edit and a layout version bump.

### Hover and click

The canvas sits behind the UI, so pointer events reach it only through see-through areas. The chat scroll container, the main area and the start page wrapper get `data-room-passthrough`. A document-level pointer listener checks `elementFromPoint` for a passthrough element and then raycasts the scene. Hovering an interactive object shows a DOM hover card beside the pointer: name, what it stands for, its numbers, and where a click goes. Clicks navigate: robot → its session (focus if open, else open), mail tray → `/attention`, book → that session (a purged session's book says so and goes nowhere), plant → `/watches`, note → `/memory`, frame → the project's picker entry, key → the approvals dialog, hearth → `/activity`, kettle → the jobs view, window → nothing but the card with the weather and its source. On phones a tap shows the card with a button that navigates. Keyboard: none in round one.

### Palace page

- Route `/palace`; `PortalView` gains `"palace"`, `viewMeta` gains `{ label: "Palace", title: "Palace", icon: Castle }`, listed after System in the sidebar's Portal nav. No badge.
- `PortalPage` renders the view with a transparent header holding only the sidebar toggle; no title, no status line, no tracked panel, no toggle for it, no composer. The room's view offset is zero apart from the sidebar, so the full composition shows.
- Look-around camera, on this page only: drag (or one-finger drag on touch) yaws the camera within ±20° and pitches within 10° to 40° of the default, with inertia; wheel or pinch zooms between 0.85× and 1.3×; double-click or double-tap an object flies the camera to frame it over 600 ms; Escape, or a click on empty floor, flies back to the default. Leaving the page resets the camera. Under reduced motion the flights are cuts.
- Robots on this page react to a click with a wave before the card shows; elsewhere the card shows at once.
- On phones the page is the full-room view; the room strip on panes navigates here on tap.
- Document title "Palace".

### Performance and fallbacks

- Capped 24 fps loop driven by rAF (`frameloop="never"` and `advance()`), 60 fps briefly during a scroll so the frost keeps up, 6 fps while a CSS-blurred dialog is open, 0 when hidden.
- `dpr` capped at 1.5, `antialias: false`, `powerPreference: 'low-power'`, textures at or under 2048, meshopt GLB, instancing for books, plants and robot parts.
- `prefers-reduced-motion`: one still frame, refreshed once a minute with the sun; no drift, no particles, no robot walking.
- `prefers-reduced-transparency`: solid panels, no frost mask.
- Low Power Mode (rAF cadence around 30): 12 fps.
- No WebGL or context lost: a CSS gradient sky (colours from the sun ramp, updated once a minute) and the existing dark veil; panels keep their tint. The photos are deleted.
- Budget: under 4 ms GPU per frame on an M1 before the frost, measured in Safari's timeline before the CSS blur is replaced app-wide.

## Model

### Contracts (`packages/contracts/src/room.ts`)

```ts
export type RoomWeather = {
  code: number;                 // WMO code from the provider
  condition: "clear" | "partly-cloudy" | "overcast" | "fog" | "drizzle" | "rain" | "heavy-rain" | "snow" | "thunderstorm";
  isDay: boolean;
  cloudCover: number;           // 0..100
  precipitation: number;        // mm in the last interval
  temperature: number;          // °C
  fetchedAt: number;
};
export type RoomEnvironment = {
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  source: "config" | "ip" | "none";
  weather: RoomWeather | null;  // null when unknown; the client shows clear
  fetchedAt: number;
};
export type RoomCensus = {
  sessionsEver: number;         // high-water
  memoryActive: number;
  memoryInbox: number;
  watches: { active: number; finished: number; fires: number; ever: number };
  grants: number;
  activityLastHour: number;
  since: number | null;         // epoch ms of the first session, stored once
};
export type RoomMilestone = { id: string; at: number; summary: string };
export type RoomState = { environment: RoomEnvironment; census: RoomCensus; milestones: RoomMilestone[]; layoutVersion: number };
```

### Shared (`packages/shared/src/room.ts`)

Pure, tested with `node:test`, used by both server and web: `weatherCondition(code)`, `sunRamp(altitude)` (colour temperature and intensities), `kelvinToRgb`, `hashId` (cyrb53) and `mulberry32`, `slotFor(itemId, capacity, taken)`, `bucket(count, cap)`, `MILESTONES` and `milestonesReached(census)`, `latitudeForTimeZone(zone)`, `LAYOUT_VERSION`.

## Server

### Environment service (`apps/server/src/room/environment.ts`)

- Location: `PORTAL_LOCATION=lat,lon` from config when set; otherwise the server's public IP via `https://api.ipify.org?format=json`, then `https://get.geojs.io/v1/ip/geo.json` (fallback `https://ipwho.is/`). Cached 24 hours; refreshed in the background; failures keep the last value; a log line at warn once per failure streak.
- Weather: `https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current=temperature_2m,is_day,weather_code,cloud_cover,precipitation&timezone=auto`. Cached 20 minutes; one in-flight request at a time; failures keep the last value.
- No fetch at boot on the request path: the first `GET /api/room` triggers the resolution and answers with `source: "none"` until it lands, then pushes.
- Tests inject a fake `fetch`.

### Census service (`apps/server/src/room/census.ts`)

- Computes the counts from the existing services and stores: sessions list, memory store, intents store, grants, activity log (count in the last hour), projects.
- High-water marks and `since` live in the `settings` table under key `room` (same store mechanism as the workspace key), updated whenever a count exceeds the stored one. `since` is set once from the oldest session's `createdAt` at first computation, or now when there are none.
- Milestones: `milestonesReached(census)` against the stored set; each new one is appended to the stored list with `at = now`, logged to Activity as `room.expanded` by actor `system`.
- Cached 60 seconds; recomputed on demand past that.

### Routes

| Method and path | Response |
|---|---|
| `GET /api/room` | `RoomState` |
| `GET /api/room/environment` | `RoomEnvironment` (for debugging and the hover card) |
| `POST /api/room/refresh` | Forces the environment and census to refresh; origin-checked. For the settings dialog's "Refresh location and weather". |

The portal stream gains `{ type: "room", state: RoomState }` on connect and whenever the census or environment changes, so open tabs do not poll. Without the orchestrator (tests, a stripped server) the routes still work; the stream event is skipped.

### Activity

One new kind, `room.expanded`, with `detail.milestone` and `detail.value`. Not logged for environment changes.

### Config

`PORTAL_LOCATION` (optional, `lat,lon`) in `config.ts`. `PORTAL_ROOM_OFFLINE=1` disables outbound lookups (tests and air-gapped use).

## Web

### Structure

```
apps/web/src/room/
  RoomBackground.tsx        // replaces components/RoomBackground.tsx; mounts the canvas lazily, owns the fallbacks
  RoomCanvas.tsx            // 'use client', next/dynamic with ssr: false; the R3F Canvas, loop, resize, DPR
  loop.ts                   // capped rAF loop, hidden/reduced-motion/low-power handling
  layout.ts                 // UI layout registry → setViewOffset; passthrough elements
  pointer.ts                // document pointer listener, raycast, hover and click dispatch
  RoomHoverCard.tsx         // the DOM card
  PalaceView.tsx            // the /palace view: look-around camera controls over the shared canvas
  useRoomState.ts           // GET /api/room + stream event, with the client-side sun clock
  scene/
    Shell.tsx Sun.tsx Sky.tsx Window.tsx Weather.tsx Lamp.tsx Hearth.tsx Kettle.tsx MailTray.tsx
    Robots.tsx Books.tsx Corkboard.tsx Plants.tsx Frames.tsx Keys.tsx Tree.tsx Milestones.tsx
    materials.ts (palette, shared materials) kit.ts (GLB loader, node map)
  frost/
    FrostPass.tsx           // scene RT → downsample → Kawase ×3 → mask composite
    registry.ts             // .frost elements → rects and radii, refreshed per frame
    shaders.ts
public/room/kit.glb, public/room/LICENSES.md
```

`RoomBackground` keeps its props (`activity`, `sessionId`) for the mount points in `WorkspaceView` and `PortalPage`; `sessionId` is no longer used for decor and is dropped once both callers are updated.

### Frost

- Panels that sit over the room (the sidebar, the composer, item and watch cards, the "thinking" spans, the GitHub inspector) change from `.glass` / `.glass-subtle` to `.frost` / `.frost-subtle`: the same background tint, border and shadow, no `backdrop-filter`.
- Dialogs, sheets, the search dialog, popovers and menus keep `.glass` with CSS blur; while one is open the loop drops to 6 fps.
- `frost/registry.ts` queries `.frost, .frost-subtle` once per frame, reads `getBoundingClientRect` and a cached `border-radius` per element (refreshed by a `ResizeObserver`), converts to canvas pixels, flips Y, and writes an instanced quad buffer. The mask pass draws rounded rects with an SDF into a half-resolution R8 target. The composite pass mixes the sharp scene and the blurred, saturated copy by the mask.
- Measured before the swap: the frost pass on an M1 and an iPhone 13 in Safari's timeline, recorded in the As built section.

### Data

- `useRoomState` loads `GET /api/room` once and then listens to the portal stream's `room` event (through `PortalLive` on the Portal page; on the workspace a light subscriber on the same hub). Session states come from `useSessions`; status, counts and runs from the portal stream's `status`; pinned projects from `useProjects`.
- The sun is computed client-side once a minute from the environment's coordinates and the client clock; no server clock.

### Settings

- `RoomModeControl` and the `portal.room.mode` preference are removed from the sidebar footer.
- The Settings dialog gains a Room section: location shown (lat/lon to two decimals, with its source), weather shown with the provider credit, a "Refresh" button that calls `POST /api/room/refresh`, and the layout version.

## Tests

- Shared: weather mapping, sun ramp monotonicity, hash and PRNG determinism, slot assignment stability (adding or removing an item never moves another; snapshot over 200 seeds), buckets, milestone evaluation, timezone latitude table.
- Server: environment service with a fake fetch (config override, IP path, provider failure keeps last, cache windows, offline flag); census high-water marks and `since` (a purge never lowers them); milestone detection logs once; routes; stream event.
- Web unit: layout registry maths (view offset from a layout), frost rect conversion, the robot state mapping from session states, bucket labels for hover cards, the Palace camera limits.
- Playwright (`tests/ui/room.spec.ts`): the canvas mounts and the scene attribute reports day or night from a fixed environment fixture; the panels have no `backdrop-filter` while dialogs still do; reduced motion renders a still; a session in approval state puts a robot at the door (via a `data-room` summary attribute the scene writes for tests); hover card content and click-through on a robot; the Palace page shows no header text and its drag moves the camera within limits; the mobile strip navigates to `/palace`. The existing room assertions in `portal.spec.ts` and `portal-mobile.spec.ts` are rewritten.
- Live check on a scratch instance with a cloned DB: real location and weather resolve, the census matches the pages, a milestone crossing logs to Activity and animates in.

## Implementation order

Each phase ends green and committed; each is visible on its own.

1. **Foundation.** Contracts and shared room logic with tests. Server environment service, config, `GET /api/room` (environment only, census stubbed), stream event. Web: canvas mount, loop, shell, camera and view offset, sun, sky, weather, fallbacks, the `/palace` route and sidebar entry as a plain full view, the lighting control removed. The photos go. Panels still use CSS blur at 24 fps as a stopgap for this phase only.
2. **Frost.** The WebGL frost pipeline, `.frost` migration, dialog slow-down, measurement on M1 and iPhone, reduced-transparency fallback.
3. **Live objects.** Robots, lamp, mail tray, hearth, kettle; pointer hit-testing, hover cards, click-through; the Palace page's look-around camera and robot wave.
4. **Growth.** Census, high-water marks, milestones and Activity on the server; books, corkboard, plants, frames, keys, tree; slot layout; milestone expansions with the delivery animation; Settings room section.
5. **Polish.** Kit assets replacing placeholder primitives where they look better, baked AO, phone strip and full-room sheet, Playwright suite, live check, `docs/PALACE.md` As built.

Merge to main waits for Moses. No migration: the `room` settings row is created on first use. The live instance needs a restart for the routes.

## Out of scope

- The rename to Palace and any vocabulary change.
- Per-project or per-session rooms.
- Manual decoration, furniture picking, or prompt-driven styling.
- Sound.
- A character for Portal.
- Keyboard navigation of room objects.
- Real-time clock sync with the server; the client clock is trusted.

## As built

### Foundation

Phase 1, 2026-10-08 (`5cb48ac`, `2ed8066`). Built as written, with these differences:

- **suncalc stays on 1.9** (`^1.9.0`): 2.x reports azimuth in degrees clockwise from north, where the room's direction maths (`sun.ts`, `directionFrom`) takes 1.9's radians from south towards west.
- **The canvas waits for the page's first idle moment** (`requestIdleCallback`, 1.5 s at most) before it mounts: its first frame compiles every shader, which should not compete with the app's first render and first clicks. Later mounts (another view) draw at once.
- **WebGL is off by default in the UI suite.** The fixtures refuse WebGL contexts unless a test passes `webgl: true`: headless Chromium rasterises WebGL in software, and a room redrawn 24 times a second in every test slowed the suite and skewed its timings. Without it the room is the gradient fallback, which carries the same attributes.
- **A lighter veil over the 3D room** than over the gradient (the veil keeps text readable): `.room-scene[data-renderer="webgl"]` has its own, lighter by night. Phase 5 retuned both (section Polish).
- **The moon and the clouds are pinned to the window's line of sight** (`WindowView`): a group set a fixed distance behind the glass along the line from the camera through the window, facing the camera, so they stay framed by the window from any pose (the drift, the parallax, the Palace page's look-around). Placed by azimuth on the dome instead, they left the window at the first turn.
- **`data-room-slow`** marks the CSS-blurred overlays (the shadcn dialog and sheet overlays, the search dialog's) for the loop's 6 fps check, beside `dialog[open].glass` and `[role=dialog].glass`.
- **`RoomStrip`** (`room/RoomStrip.tsx`) is new, not in the structure above: the phone's 72 px link above the pane header, reported to the camera as a `focus` cover so the room centres in it.
- **The sky's horizon sits low**: the camera looks down through the window, so the dome's horizon line is moved down (`uHorizonAt`) and the window shows sky, with a band of dark land under it.

### Frost

Phase 2, 2026-10-09. `apps/web/src/room/frost/`: `FrostPass.tsx` takes over the canvas's render (a `useFrame` at priority 1) and runs the scene into a full-size half-float target, a 4 × 4 box downsample to a quarter, three dual-Kawase passes (down to an eighth, down to a sixteenth, up to an eighth), the panel mask, and a composite to the screen that folds in the last Kawase upsample, applies AgX and the sRGB transfer to both copies, saturates the blurred one by 1.35 in display space (CSS `saturate()`'s Rec. 709 luma lerp), and mixes them by the mask. The mask is one instanced quad per panel, a rounded-rectangle SDF antialiased over one mask texel, MAX-blended into a half-size R8 target. `registry.ts` queries `.frost, .frost-subtle` on every rendered frame, skips invisible ones (`checkVisibility`), cuts each quad to its overflow-clipping ancestors (so a card scrolled under the header has a straight cut edge, not frost on empty room), and caches each panel's radius and clipping ancestors until a `ResizeObserver` or a class/style `MutationObserver` marks them stale. Frames with no frosted panel render the scene straight to the screen. Targets are resized only when the canvas's size changes. The canvas writes the last frame's panel count to `data-frost` for tests.

- **Blur size**: the taps' spread is 2.5 texels at a pixel ratio of 1.5, scaled with the ratio; side by side over the room with CSS `blur(28px) saturate(135%)` at ratios 1 and 2 the two are indistinguishable in width. `.frost-subtle` (the sidebar, the tracked panel, the GitHub inspector) gets the same blur and saturation as `.frost`; the old `.glass-subtle` was `blur(24px)` without saturation. One mask channel cannot tell them apart and the difference does not show under the tint.
- **Migrated to `.frost`**: the sidebar, the composer, item cards, watch cards, the empty-state icon tiles and the API-key card in conversations and Talk to Portal, the "Jump to latest" pill, the GitHub inspector, and the tracked panel (all three of its states). `.glass` remains on the search dialog and sheet; the shadcn dialog and sheet overlays keep their own `backdrop-blur`. The phone pane bar keeps its `backdrop-blur-sm` (not a panel over the room in the spec's list).
- **CSS blur was off in Chromium**: Lightning CSS collapsed `backdrop-filter` followed by `-webkit-backdrop-filter` into the prefixed declaration only, which Chromium ignores, so `.glass` never blurred in Chrome (Safari was fine). The prefixed declaration now comes first and both are emitted.
- **Not per-element opacity**: a panel's own `opacity` (a settled item card at 60 %) does not fade its frost; the tint fades, the blur under it stays.
- **Scroll**: the loop's existing capture-phase `scroll` listener on the document already catches the chat scroller and the sidebar (element scrolls do not bubble, but they do pass the capture phase), so both get 60 fps for 300 ms. The registry reads the panels' boxes in the same requestAnimationFrame as the render, so frost follows a scroll without a frame of lag.
- **Reduced transparency**: the panels are `var(--card)`, opaque; the room is the gradient fallback, so no canvas and no mask; the registry also returns no panels under the media query.

#### Measurement (headless Chromium on this Mac, not Safari)

**Owed: the Safari timeline on an M1 and on an iPhone 13.** What follows is Playwright's Chromium (headless, `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`) on this development Mac, whose GPU reports as an **Apple M4**, not an M1. The Portal chat page (sidebar, tracked panel and composer frosted), noon, clear sky, 1440 × 960 CSS px. 200 rendered frames each way, the same page with the frost classes stripped for the baseline. GPU time from `EXT_disjoint_timer_query_webgl2` around the whole rAF callback; CPU time is `performance.now()` around the same callback (the loop's `advance()`).

| Drawing buffer | GPU with frost (mean / p50 / p95 ms) | GPU without | Frost cost (GPU, mean) | CPU with / without (mean ms) |
|---|---|---|---|---|
| 1440 × 960 (DPR 1) | 2.10 / 2.13 / 2.26 | 1.22 / 1.23 / 1.33 | +0.88 ms | 1.61 / 1.32 |
| 2160 × 1440 (DPR 2, canvas capped at 1.5) | 3.68 / 3.93 / 4.41 | 2.55 / 2.60 / 2.69 | +1.14 ms | 1.63 / 1.20 |

The frost adds six draw calls (69 against 63). Forcing the GPU to finish with a 1-pixel `readPixels` after each frame gave wall times of 5.7 against 4.6 ms (DPR 1) and 7.3 against 5.7 ms (DPR 2), consistent with the timer queries plus the readback stall. Default headless Chromium (SwiftShader, CPU rasteriser) took 54 against 32 ms and 114 against 68 ms per frame; that is software rendering and says nothing about a real GPU, but it is why the UI suite only enables WebGL where a test asks. An M1's GPU is roughly half an M4's, so expect about 2 ms for the frost and about 5 ms for the whole frame at DPR 1.5; the scene alone is already over the spec's 4 ms M1 budget at that size by this estimate, which is the scene's budget to meet, not the frost's.

### Live objects

Phase 3, 2026-10-09 (`9bf962b`). Built as written, with these differences:

- **Robot parts are instanced with drei's `Merged`**, one draw call per part across every robot; books and plants (phase 4) are plain `InstancedMesh`es written in a `useFrame`. drei's `Instances` is not used.
- **Click targets the spec left open or named loosely**: the kettle opens `/watches` (the jobs live on the Watches page; there is no separate jobs view), and the lamp, which the spec gives no target, opens Portal's chat (`/`). A key opens the approvals dialog when an approval is pending; with none, the dialog would be empty, so it opens System, where the grants are listed.
- **On the Palace page a clicked robot waves, then its card shows pinned** with a button to its session; the click itself does not navigate. Elsewhere a click on a robot opens its session at once. Clicks on the Palace page wait out a possible double click first (the double click frames the object).
- **The window, the tree and a purged book pin their card** on click: they have no page of their own.

### Growth

Phase 4, 2026-10-09 (`3071f07`, `37bfa92`). Built as written, with these differences:

- **The memory milestones read a high-water mark** (`memoryActive` in the `room` row), as the session and watch ones do; the spec's census has no memory high-water. The census's own `memoryActive` stays the live count (the notes on the board).
- **When the census recounts**: cached 60 s as specified, plus a recount a few seconds after a new session, a change to watches, memory or grants (the orchestrator's events) or any Activity entry, and once a minute while a browser holds the stream open, so the hearth cools without a reload.
- **The memory inbox** is the `proposed` records.
- **Fresh milestones**: one whose `at` is under two minutes old when the page first sees it, or that arrives over the stream, comes in the crate, one crate at a time; the rest are simply there. On the live instance's first start every milestone it has already passed is reached at once (five on the cloned database), so a page open within two minutes gets five crates in a row, and their five `room.expanded` entries warm the hearth to embers for the hour.

### Polish

Phase 5, 2026-10-09. The first look at the room with human eyes, from screenshots at 1440 × 900 and 390 × 844 (Playwright's Chromium with `--use-angle=metal` on the M4; the UI fixtures with 40 sessions, three active robots, one waiting on approval and one hung, memory, watches with fires, two pins, two grants, two milestones; day, night, rain, snow, overcast; the Palace page, Portal home, a conversation; every milestone at once; close-ups of the desk, the door, the shelves and the rug).

What the shots showed, and what changed:

- **The room was muddy**: lit almost only by the hemisphere at its ramp's strength, then veiled, the cream walls came out mid-brown and the whole room read grey. The sky fill is now 5.2 × the ramp (was 3.2) and the sun 3.4 ×; by day the room is cream with a warm patch of sun from the window, by night a cool moonlit fill (`#8f9cc8`, at least 0.95) with the lamp and the hearth glowing and the moon's patch through the window on the floor. The moon is a key of its own (0.9, more at full moon) instead of the ramp's dim tail.
- **The veil**: none on the Palace page (no text over it: `.room-scene[data-view="palace"]`); elsewhere stronger than phase 1's (`#1517138a` by day, `#110f0c4d` by night) because the brighter room under the chat column made secondary text hard to read.
- **Sunlight where there should be shade**: the floor past the room's open sides lay outside the walls' shadows and outside the shadow camera, and the hallway beyond the door had no roof, so bright bands showed at the front and a sunlit parallelogram under the door. An invisible ceiling at the room's height now casts the sun's shadow (`colorWrite` off, so it draws nothing), the hallway casts shadows and has a roof, and the shadow camera covers ±10 m (was ±7.5), so daylight comes in through the window only.
- **Grey weather still threw sun patches**: `sunThrough` lets through 1 − 1.25 × the condition's grey (at least 5 %), so overcast, rain and snow leave little more than a trace.
- **The wall tops showed on phones** (the portrait camera sees over 6 m walls): the walls are 10 m tall. The phone room sat high with a third of the screen empty wall: the portrait pose pitches 35° and aims lower and nearer. Through the phone's steeper look the window showed mostly land: the dome's horizon moved down again.
- **The phone strip framed the desk**, not the window: with the strip reported, the portrait camera aims at the window (`cameraPose(aspect, strip)`), so the 72 px show sky, weather and the tree over the desk.
- **The desktop room sat a little right** and, with every milestone, the reading nook's floor lamp was behind the sidebar: the camera target moved 0.5 m left, and the nook's lamp and side table swapped corners so nothing stands at the front-left edge.
- **The cat was invisible**: it slept behind the chair's backrest. Portal's chair is pulled out from the desk and turned side-on to the room, with the cat on its seat.
- **Book spines** were saturated against the pastels: the ten spine colours are softened.
- **Baked corner darkening** (phase 1's shell shader, from world position) was convincing but faint; it now darkens corners by up to 50 % (was 40 %).
- Looked fine and left alone: the frost's edges against the sidebar, composer and tracked panel; the hover card over the room; the hung robot, the approval robot and its sign by the door; rain and snow through the glass; the crate (it opens on the floor between the rug and the door; with Playwright's fake clock installed it does not show, which is a test-clock artefact).

**Kit assets.** The Kenney Furniture Kit (kenney.nl) and KayKit Furniture Bits (KayKit's GitHub repository) both downloaded cleanly and are CC0; Quaternius was not tried. KayKit's pieces are coloured by a gradient texture in its own palette, so a piece here takes one room colour instead, which only works for pieces whose shape carries them. Tried in the room: KayKit's armchair read as a beanbag next to the primitive one with arms and a cushion, and stayed out; KayKit's wooden chair looked better than the primitive one, so `public/room/kit.glb` holds that one mesh (7.7 KB): glTF Transform stripped the texture and UVs, `gltfpack -cc -kn -noq` compressed it. `scene/kit.tsx` loads it with drei's `useGLTF` and the meshopt decoder inside a Suspense and an error boundary whose fallback is the primitive chair, asks for a frame and a shadow update when it lands (a still room draws only when asked), and colours it from the palette. Sources and licences: `public/room/LICENSES.md`.

**Tests.** The UI suite now also checks that under reduced motion the canvas draws one still frame (two screenshots of the canvas a second apart are identical) and draws again when the room changes (a session starting work gets its robot at once), and that the kit loads. Everything else the spec's Tests section lists was already covered by phases 1 to 4.

**Live check** on a scratch server against a clone of the live database (paths rewritten into `/tmp`, jobs paused, each guard verified in a separate select; outbound lookups on, no `PORTAL_LOCATION`; the orchestrator on, as the cloned keys allow):

- `GET /api/room` resolved the server's public IP to New York (40.73, −74.00, `source: "ip"`) and Open-Meteo's weather: clear, night, 12.6 °C, matching the time there.
- The `room` settings row did not exist before the first request and did after, holding `since`, the high-water marks and the milestones.
- The census matched the database and the pages: 274 sessions (274 rows; the Palace page drew 240 books on ten rows of the two bookcases and boxed 34), 12 active memory records (12 notes), no active watches and 100 finished (26 cancelled, 73 done, 1 expired; 8 on the stand, its cap), 202 fires (the intents' sum), 11 grants (8 keys, the rack's cap), `since` the oldest session's `createdAt`; the mail tray's two open envelopes matched the sidebar's "2 items need you".
- Five milestones were reached on the first count (tall and second bookcase, rolling ladder, window box, wind chime), each logged once to Activity as `room.expanded` by `system`.
- One stream connection received thirteen `room` events over the check (on connect, when the environment landed, on recounts and refreshes).
- A crossing: forty memory records inserted into the clone, then Refresh. The census crossed 50, logged "The corkboard became a wide pinboard at 50 memory records.", pushed it, and the open Palace page delivered the pinboard in a crate, after which it stayed.

The scratch server was stopped and the clone dropped afterwards.

**Still owed:**

- **The Safari timeline on an M1 and an iPhone 13** (section Frost, Measurement): the frost's cost and the scene's against the 4 ms budget, and the frost's look in WebKit. The headless Chromium estimate already puts the scene alone over 4 ms on an M1 at a pixel ratio of 1.5. Phase 5 added one draw call that colours nothing (the ceiling), replaced the six boxes of the chair with one mesh, and spread the shadow map over ±10 m (a little softer shadows from the same 1024 map).
- A look on a real phone: the strip and the Palace page were judged at 390 × 844 in Chromium only.

### Review fixes

2026-10-09, after two reviews of the web side (`4d1b1e3` to `92fde56`). Where these differ from the sections above, these hold.

- **Pointer.** A drag on the Palace page counted as a click on release (the press was forgotten on `pointerup`, so the click's slop check never ran) and flew the camera back or opened what it ended over; a mouse press is now kept for the click that follows. The room no longer shows through a whole `<main>`: `data-room-passthrough` is on the conversation's and Talk to Portal's viewports, the start page's wrapper, the Portal views' scrolling column (`ViewBody`, so their margins) and the Palace page. A `section`, `[role=tabpanel]`, `[role=separator]` or `[data-room-block]` (the terminal panel) stops it, so a click on a terminal or a resize handle over an object stays in the UI. Unit tests (`tests/room-pointer.test.mjs`, a minimal DOM stub) cover the passthrough, the slop, the double click and the tap; UI tests cover a drag keeping its look, a terminal over an object, and the sidebar's Palace entry being the current page.
- **One render path.** Frames without a frosted panel used to render straight to the screen (AgX, sRGB) and frames with one into the target (linear, no tone mapping), so every material had two programs and recompiled the first time the count crossed zero. Every frame now goes through the target; with no panel the blur and mask are skipped, the mask is cleared once, and the composite passes the scene through. The sky, moon, rain and snow shaders end with `tonemapping_fragment` and `colorspace_fragment` like three's own, no-ops into the target, so the composite encodes everything exactly once. A frame with no panel now costs the scene target and the composite, about a full-screen pass more than before.
- **Instanced materials.** Instanced meshes (books, notes, plants, frames, keys, mail, the lamp's papers) take `instancedMatte()`, not `matteMaterial`: the window box's white flower shared `matteMaterial("#ffffff")` with them, and three switched that material's program between instanced and plain every frame.
- **Failures.** Only WebGL 2 counts (three r186 creates nothing else); an error boundary around the canvas turns a throw (no context, a scene error) into the gradient for the visit. A lost context shows the gradient with the canvas mounted and hidden, nothing drawn; on `webglcontextrestored` the canvas remounts under a new key. The loop schedules its next frame before it renders, so one exception in a `useFrame` no longer stops the room.
- **Per-frame work.** The hotspots' screen points (`data-room`'s `points`) are projected only under automation (`navigator.webdriver`); the cadence check keeps a ring buffer and takes the median every 30 ticks, not a sort of 120 samples every frame; the frost registry reuses its set, map, clip box and quad and reads a panel's radius in pixels only when the panel changed.
- **One room in the shell.** `Chat` mounts `RoomBackground` once, above the page switch, so moving between a Portal page and a session keeps the canvas (each page used to mount its own). The workspace reports its focused pane's activity up; Portal pages use Portal's. Not on the terminal page, as before.
- **Cover registry.** The message columns registered through the scroller's ref merger, which dropped the callback ref's cleanup, so unmounted columns stayed in the registry; they register through `useRoomCover` (an effect on a ref) now.
- **Settings.** A failed `GET /api/room` left the Room section on "Loading…" for good; it says "Unavailable", a failed request is forgotten so the next subscriber asks again, and Refresh still fills it in.
- **Phone veil.** At 390 × 844 the chat's first lines sat over the bright hearth and stove under the desktop's veil (the phone rules lost to the WebGL ones on specificity). On phones outside the Palace page the veil is now a gradient from `#151713d9` at the top to `#151713b3` (night `#110f0cb3` to `#110f0c8a`), and the room strip's 72 px keep the desktop's veil (`:has([data-room-strip])`). Re-taken as in Polish: `/tmp/palace-shots/chat-day-clear-phone.png`.
- **Cleanup.** The unused `.glass-subtle` is gone.
