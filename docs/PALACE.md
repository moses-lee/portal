# Palace: the room behind Portal

Date: 2026-10-08. Status: **plan agreed with Moses on 2026-10-08; all five phases built on branch `background` by 2026-10-09 (section As built), not merged. Revision 2 (a camera the user cannot move, the sketch before the room) agreed in outline on 2026-10-09; its step 1, the camera, step 2, the sketch and the loading changes, and step 3, the snapshot, built on 2026-10-09 (As built, Revision 2, steps 1 to 3); the review's fixes (step 4) made on 2026-10-09 (As built, Revision 2, review fixes). Revision 3 (the camera fixed on desktop: no panel moves it) agreed and built on 2026-10-09 (section Revision 3; As built, Revision 3).** Still owed: the Safari timeline on an M1 and an iPhone 13. Research behind it: `docs/PALACE-RESEARCH.md`.

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
| 5 | Camera | Three-quarter diorama: looking slightly down into the room from the missing fourth wall, long lens, fixed. The scene centre shifts into whatever region the UI leaves uncovered. Revision 2: nothing the user does moves it, no drift, no parallax, no look-around; the pose is fitted by rule to a hero box for the viewport's aspect, the view offset alone follows the layout, and the phone strip aims at the window (section Camera). Revision 3: no panel moves it either; the landscape pose is aimed a little right of the fit, where it looked right beside the sidebar, and stays there with or without one; only the phone strip has a view offset. |
| 6 | Composition | Designed for the desktop margins beside the chat column plus the start page and Portal home, where most of the room shows, and the Palace page (decision 21), where all of it does. Phones get a 72 px room strip above the pane header framing the window (Revision 2: from its top to the sill); tapping it opens the Palace page. |
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
| 21 | Palace page | A new Portal view, `/palace`, with a sidebar entry "Palace" under the Portal heading. It shows nothing but the room: no header text, no status line, no tracked panel, no composer. The whole viewport is the room, with the sidebar still beside it on desktop. It is the place to look at the room and play with it: hover cards and clicks (section Palace page). Revision 2: no look-around camera; nothing the user does moves the camera on any page. Revision 3: the sidebar's coming and going leaves the room where it is. |
| 22 | Active session | A robot exists for every session in state connecting, working, background, approval or hung. A finished session's robot walks out of the door and is gone; there is no sleeping state. |
| 23 | Milestones | The table in section Milestones, as written. |
| 24 | No-WebGL fallback | A CSS gradient sky and the dark veil. The two photos are deleted. Revision 2: the sketch (section Before the room draws) replaces the gradient, under the same veil as the 3D room. |
| 25 | Settled | Every point raised during planning is answered above; the build follows this document without further questions. |

## The room

### Shell and anchors

Front-on view with the fourth wall missing. Back wall carries the window centre-left and the hearth on the right. Left wall carries the shelving. The desk sits under the window with the lamp and chair. The rug is centre floor, where robots walk. The door is on the right edge with the mail tray and key rack beside it. The sill is under the window. Wall slots for frames sit above the desk.

Anchors are an authored list, not generated. Furniture declares its own slots: rows, slots per row, accepted kind, pitch. Growth is an ordered fill: `slot = hash(itemId) mod capacity`, walking to the next free slot on collision. Gaps are fine.

### Camera

Revised on 2026-10-09 (Revision 2); the first version had hand-set poses, a 1.5° drift, a pointer parallax and a look-around on the Palace page.

Perspective, vertical FOV 30° (the Canvas's `CAMERA` in `RoomCanvas.tsx`, near 0.5, far 220). Two things set the view, and neither runs per frame: the pose, fitted to the room for the viewport's aspect and (Revision 3) aimed a little right of the fit in landscape, and `camera.setViewOffset`, which draws the room's window in the phone strip when one is shown and is zero otherwise. Revision 3 took the panels out of it: the sidebar, the GitHub inspector, the tracked-sessions panel and the chat column no longer move the room (section Revision 3; before it the offset moved the frame into the region they left open). Nothing the user does moves the camera: no drift, no parallax, no look-around, nothing the pointer, the wheel or a touch does. Reduced motion changes nothing here.

**The pose is fitted, not hand-set** (`framePose(aspect)` in `layout.ts`, pure). Two anchor poses, each with an axis-aligned hero box in room metres (floor at y 0, the back wall's face at z −3, the left wall's face at x −4):

| | Landscape, aspect ≥ 1.4 | Portrait, aspect ≤ 0.8 |
|---|---|---|
| Yaw, pitch | 25°, 25° | 14°, 30° |
| x | −4.0 to 3.9: the left wall's face, where the shelving stands, to the door casing's right edge (door 2.875 to 3.825, casing 0.08 each side) | −2.4 to 2.3: the inside sill's left end (the window is −2.25 to −0.15, the sill 0.15 wider each side) to the hearth's opening (the hearth is 1.55 to 3.05, the mantel to 2.4), so the fire is in frame and the mail tray (2.77), the plant stand (2.74) and the key rack sit at the right edge, past the pad |
| y | 0 to 3.15: the floor to the corkboard's top (2.44 to 3.12 on the left wall), which also clears the window's top (2.45), the bay's roof (about 2.6) and the gallery row of frames (to 2.91) | 0 to 2.6: the floor to just above the window's top and the bay's roof |
| z | −3 to 1.75: the back wall to the rug's front edge (the rug is centred at z 0.5 and 2.5 deep) | −3 to 1.0: the back wall to just in front of the robots' bench (its front edge at z 0.77) |

Furniture outside the boxes, accepted: in landscape only the reading nook's armchair and side table (z 2.0 to 2.9, in front of the rug), which land at the left edge of the box's outline on screen, the side table reaching up to 15 px into the pad. In portrait everything left of the sill (the shelving and both bookcases, the corkboard or pinboard, the ladder, the wall map, the frames beside the window, the reading nook), right of the key rack (the door, the queue of robots at x 3.8, the crate's way in) and the rug's front part; the sides crop most of it. The bay window and the window box stand behind the back wall (z −3.25 to −3.8) but are seen through the window, inside the box's outline on screen.

Between the two aspects, with t = (aspect − 0.8) / 0.6 clamped to 0..1, the yaw, the pitch and each of the six box edges are `portrait + t × (landscape − portrait)`, and the fit below runs on the blended values. Every step of the fit is continuous in its inputs (the distance is a maximum of continuous functions, the centring is the root of a strictly monotone one), so the pose is continuous in the aspect: a window resized across 0.8 or 1.4 never jumps. It has kinks, where the axis that sets the distance changes (at about 1.59 for the landscape box), but no steps.

**The fit.** Write θ for the yaw and φ for the pitch. With three's conventions as `scene/Camera.tsx` uses them, the camera stands at `target + d·f` and looks at `target` with y up, where:

- f = (sin θ·cos φ, sin φ, cos θ·cos φ) points from the target to the camera;
- r = (cos θ, 0, −sin θ) is the camera's right;
- u = (−sin φ·sin θ, cos φ, −sin φ·cos θ) is the camera's up (f × r).

For each of the box's eight corners Cᵢ, relative to the box's centre B: xᵢ = (Cᵢ − B)·r, yᵢ = (Cᵢ − B)·u, wᵢ = (Cᵢ − B)·f. With the target at B + a·r + b·u and the distance d, corner i lies at depth zᵢ = d − wᵢ in front of the camera (moving the target along r and u does not change any depth) and projects to normalised device coordinates Xᵢ = (xᵢ − a) / (zᵢ·tH) and Yᵢ = (yᵢ − b) / (zᵢ·tV), where tV = tan 15° and tH = tV × aspect. The pad is 6 % of the viewport on every side, so a corner is inside it when |Xᵢ| ≤ s and |Yᵢ| ≤ s, with s = 1 − 2 × 0.06 = 0.88.

1. **Distance.** Some a puts every corner inside the pad horizontally exactly when every pair of corners satisfies xᵢ − xⱼ ≤ s·tH·(zᵢ + zⱼ). So the smallest distance horizontally is dH = the largest, over the 64 ordered pairs (i, j), of (wᵢ + wⱼ) / 2 + (xᵢ − xⱼ) / (2·s·tH); dV is the same with y and tV; and d = max(dH, dV).
2. **Centring.** a is the root of g(a) = maxᵢ Xᵢ(a) + minᵢ Xᵢ(a), the projected box's right edge plus its left edge. g is continuous and strictly decreasing, with g ≥ 0 at a = minᵢ xᵢ and g ≤ 0 at a = maxᵢ xᵢ, so 50 halvings of that interval find it; b is found the same way with Yᵢ, and the target is B + a·r + b·u.
3. **One pass.** d does not depend on a or b, and the centred a and b always lie inside the range that keeps every corner in the pad, so nothing needs repeating: on the axis that set d the box touches the pad on both sides, on the other it has equal margins. A distance taken per corner with the target at B and centred afterwards is not the smallest, because a box seen obliquely is not symmetric about its centre on screen: at 1440 × 900 it gives 14.8 m where the pair rule gives 12.9 m.

**The aim** (Revision 3). After the centring, the target moves by `aim` metres along the camera's right axis r: a = (the centred a) + aim. The landscape anchor's aim is −1.08 m, the portrait's 0, blended like the angles; a negative aim draws the room to the right of the centred fit. The aim is a translation of the camera parallel to the image plane, so it changes no depth and nothing down the screen; across, each point moves by aim / (z·tH) in normalised coordinates, so a little more for the near corners than the far ones, and the box is no longer exactly centred or exactly in the pad: at 1440 × 900 its right edge is 52 px past the viewport's edge. The number is the composition Moses chose on the session page beside the 280 px sidebar, which Revision 2's offset gave by moving the frame 140 px right; at 12.9 m and tH = tan 15° × 1.6 that is 1.08 m, and the aim keeps it when the sidebar is closed, resized or absent.

**The view offset.** The fit uses the full viewport: the panels are glass over a room that runs on under them, and since Revision 3 the offset exists only to draw the window's centre in the phone strip. `viewOffset(width, height, point, anchor)` returns the arguments of `setViewOffset(width, height, anchor.x − point.x, anchor.y − point.y, width, height)`, a translation in pixels that draws the fitted frame's screen point `anchor` at the viewport's `point`. `point` is `interestPoint(layout)`, which since Revision 3 is the viewport's centre unless a `focus` cover (the phone strip) is visible, when it is the strip's centre; `anchor` is the frame's centre, which the fit made the projected box's centre, except under the strip, where it is the window's centre (`WINDOW_CENTRE`, −1.2, 1.7, −3.12) projected with the pose. So on every page but a phone pane the offset is zero. The exception is needed because the box's centre lies below the sill: at 390 × 844 the window spans 290 to 366 px down the screen and the frame's centre is at 422, so centring the frame in the 72 px strip would show the desk and the wall under the window. Aimed at the window, the strip shows it from its top to the sill with the back wall either side, from the same pose as the phone's Palace page, which has no strip.

The outcome. At 1440 × 900 the distance is 12.9 m against the first version's 15, the room is drawn a little larger (the window 210 px wide against 194) and the frame holds the whole room from the shelving to the door, with the corkboard. From aspect 1.59 up the height sets the distance, so 1440 × 900, 1280 × 720 and 844 × 390 all get this same pose. With the aim (Revision 3) the frame's centre is drawn 140.6 px right of the viewport's centre, the window's frame on the glass spans about x 752 to 974 (747 to 969 on the wall's face), and the door casing's top right corner (x 3.905, y 2.28 on the wall) lands 31 px past the viewport's right edge and is cropped; a 280 px sidebar's glass holds the shelving and moves nothing. At 390 × 844 the distance is 26.02 m and the band from the sill to the hearth's opening fills the width, from 278 to 566 px down the screen (the window 115 px wide, x 111 to 226), with wall above it and floor below; the bookcases and the door are cropped by the sides. The right edge at 2.3 is a trade: a box to the key rack (2.8) made the phone room smaller than the first version's (the window 106 px wide against 145), one that stops at the stove (1.0) would match it but crop the hearth; the opening keeps the fire and most of the first version's size, and the implementer records the measured window width. The number is Moses's to retune after a look on his phone.

The camera reports into `data-room` as `camera`, after each change of pose or view offset: `{ yaw, pitch, distance, offset, box }`, the angles in degrees to 0.1, the distance in metres to 0.01, `offset` the view offset's `[x, y]` in CSS pixels, and `box` the hero box's bounds on screen `[left, top, right, bottom]` in CSS pixels to 0.1, offset applied. `box` is projected through the live `PerspectiveCamera` (after `updateMatrixWorld`), not through the pure maths, so the UI test that reads it checks that the two agree. `look.ts` and the Palace page's pointer handlers go.

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
- `PortalPage` renders the view with a transparent header holding only the sidebar toggle; no title, no status line, no tracked panel, no toggle for it, no composer. The room's view offset is zero (Revision 3: the sidebar moves nothing either), so the full composition shows.
- ~~Look-around camera, on this page only: drag yaws and pitches within limits with inertia; wheel or pinch zooms; double-click flies to frame an object; Escape flies back.~~ Removed in Revision 2: the camera cannot be moved on any page. The page is the see-through area over the shared canvas, with the default cursor; a drag does nothing, a wheel scrolls nothing.
- Robots on this page react to a click with a wave before the card shows; elsewhere the card shows at once.
- On phones the page is the full-room view; the room strip on panes navigates here on tap.
- Document title "Palace".

### Performance and fallbacks

- Capped 24 fps loop driven by rAF (`frameloop="never"` and `advance()`), 60 fps briefly during a scroll so the frost keeps up, 6 fps while a CSS-blurred dialog is open, 0 when hidden.
- `dpr` capped at 1.5, `antialias: false`, `powerPreference: 'low-power'`, textures at or under 2048, meshopt GLB, instancing for books, plants and robot parts.
- `prefers-reduced-motion`: one still frame, refreshed once a minute with the sun; no drift, no particles, no robot walking.
- `prefers-reduced-transparency`: solid panels, no frost mask.
- Low Power Mode (rAF cadence around 30): 12 fps.
- No WebGL, a failed canvas or a lost context: ~~a CSS gradient sky (colours from the sun ramp, updated once a minute)~~ the sketch (Revision 2, section Before the room draws; drawn in once per page load, complete when it comes back after a lost context) under the same veil as the 3D room; panels keep their tint. The photos are deleted.
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
  layout.ts                 // the fitted pose (framePose), projectPoint, the view offset; UI layout registry → setViewOffset; the furniture sizes the scene and the sketch share
  pointer.ts                // document pointer listener, raycast, hover and click dispatch
  RoomHoverCard.tsx         // the DOM card
  PalaceView.tsx            // the /palace view: the see-through area over the shared canvas (Revision 2: no camera controls; look.ts is gone)
  sketch.ts                 // Revision 2: the room's edges as 3D polylines, projected with the camera's maths to SVG paths (imported as ./sketch.ts)
  Sketch.tsx                // Revision 2: the inline SVG shown before the room draws, after a lost context, and as the fallback (imported as ./Sketch.tsx)
  snapshot.ts               // Revision 2: the last drawn frame, kept in IndexedDB when the page is hidden, shown on the next visit until the room draws (imported as ./snapshot.ts)
  SnapshotImage.tsx         // Revision 2: the snapshot's <img data-room-snapshot>, shown once decoded, placed by the view offsets
  useRoomState.ts           // GET /api/room + stream event, with the client-side sun clock
  scene/
    Camera.tsx (the fitted pose and view offset, no per-frame work) Shell.tsx Sun.tsx Sky.tsx Window.tsx Weather.tsx Lamp.tsx Hearth.tsx Kettle.tsx MailTray.tsx
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
- Web unit: layout registry maths (view offset from a layout), frost rect conversion, the robot state mapping from session states, bucket labels for hover cards, ~~the Palace camera limits~~ Revision 2: the fitted pose at six viewports, the sketch's projection and draw-in order, the snapshot's eligibility and placement.
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

## Revision 2: a camera the user cannot move, and the sketch before the room

Agreed in outline with Moses on 2026-10-09 after he tried the dev instance: "I don't want the camera to move" (the user must not be able to move it; a shift with the layout is fine) and "it takes a while to load and the background is really ugly while it loads", with both placeholders wanted. Where this section differs from the sections above, this holds; the sections above were edited where the change is one line.

### What was measured

On the dev instance (`next dev`, so unminified JS; each page loaded twice so on-demand compiling is out of the numbers; headless Chromium on SwiftShader, which inflates shader work), from navigation start:

| Page | Canvas in the DOM | First frame drawn |
|---|---|---|
| `/palace`, 1280 × 800, cold | 1.8 s | 3.4 s |
| `/`, 1280 × 800, cold | 1.1 s | 2.5 s |
| `/palace`, 390 × 844, cold | 0.7 s | 2.0 s |

The room's chunk (three.js and the scene, about 4.4 MB unminified, 0.6 MB over the wire) downloads in under 60 ms but is requested only at the idle moment, which waits for hydration (up to 1.3 s on the desktop Palace page) plus 30 to 630 ms of idle wait. The first frame then compiles every shader on the main thread: 1.2 to 1.6 s on SwiftShader. `GET /api/room` is never on the path. All that time the page shows the gradient fallback, a flat blue sky over a flat brown band. The canvas's 600 ms `room-in` fade starts when it mounts and the canvas is transparent until it draws, so when the compile outlasts the fade the room appears with a cut. Script: `/tmp/palace-load/measure.mjs` (not in the repo; it takes `camera` appearing in `data-room` as the first frame, which Revision 2 reports before drawing, so the script must read `data-drawn` from now on); screenshots in `/tmp/palace-load/`.

### Camera

Section Camera above has the rule and the maths. In code (Revision 3 then took the panel covers out again, so the right panel's offset below is history):

- `layout.ts`: `cameraPose(aspect, strip)` becomes `framePose(aspect)`, returning a `CameraPose` (`yaw`, `pitch`, `distance`, `fov`, `target`) as now; `LANDSCAPE_ASPECT` (1.4) joins `PORTRAIT_ASPECT` (0.8), and the two anchor poses with their boxes are one table. New, pure and shared with the sketch: `projectPoint(pose, point, size, offset)`, the projection in section Camera, and `viewOffset(width, height, point, anchor)`, whose `anchor` defaults to the frame's centre. `driftYaw` and `parallax` go; `cameraPosition` stays without its offsets.
- `scene/Camera.tsx`: in a layout effect, sets the position and `lookAt` when the aspect changes and the view offset when the layout changes (under a `focus` cover the anchor is `projectPoint(pose, WINDOW_CENTRE, size)`); no `useFrame`. It reports `camera` after each change.
- Deleted: `look.ts`, the `look` state, `setPalaceHandlers`, the double-click and Escape handling in `pointer.ts`, and the drag, wheel and pinch handlers in `PalaceView.tsx`. `PalaceView` keeps `data-palace`, `data-room-passthrough` and its size; `cursor-grab` goes, so its cursor is the default, and the pointer over an object as on every page. The robot's wave on the Palace page stays (it is the object moving, not the camera).
- Tests that go: in `room-layout.test.mjs`, "the camera is a three-quarter view; portrait screens pull back, rise and face the back wall" and "the drift spans 1.5° over a minute and the parallax at most 0.5°"; in `room-live.test.mjs`, the four look tests ("the Palace camera yaws within 20° either way …", "dragging turns the camera …", "a released drag coasts …", "flights ease in and out …"); in `room-pointer.test.mjs`, "on the Palace page a drag released over empty floor does not fly the camera back" and "on the Palace page a double click frames the object …"; in `room.spec.ts`, "the Palace page's drag turns the camera within its limits …". "A press that moved past the click slop is a drag" stays: a drag is still not a click.
- Unit tests in `room-layout.test.mjs`, at six viewports (1440 × 900, the same with a 320 px right panel, 1280 × 720, 820 × 1180, 390 × 844, 844 × 390): every corner of the blended box projects inside the pad (to 1e-6 px), the projected box's centre is the frame's centre within 0.01 px, and on the axis that set the distance the box touches the pad on both sides within 0.01 px, so no smaller distance fits. The right panel changes the view offset (x 160) and not the pose; with a strip cover at 390 × 844 the pose is the plain one and `WINDOW_CENTRE` projects to the strip's centre (195, 36) within 0.01 px.
- More unit tests: the angles are the anchors' at and beyond 0.8 and 1.4; from aspect 0.45 to 2.5 in steps of 0.001 the distance and each target coordinate move less than 0.1 m per step (the pose is continuous); `projectPoint` agrees within 0.01 px with a three.js `PerspectiveCamera` placed as `Camera.tsx` places it (position, `lookAt`, `setViewOffset`) at the six viewports.
- Playwright (`room.spec.ts`): "a drag and a wheel on the Palace page leave the camera where it is" (`data-room.camera` unchanged). At 1440 × 900 and 390 × 844 on the Palace page, `camera.box`'s centre is the viewport's centre minus `camera.offset` within 2 px, its width and height are at most 88 % of the viewport's plus 2 px, and one of the two is within 2 px of that. The phone strip test adds that the window hotspot's point (`points["window:window"]`) is within 2 px of the strip's centre.
- Verification before the As built entry: screenshots at the six viewports on the dev instance, both pages, day and night; a look on a real phone by Moses.

### Before the room draws

Two placeholders, in order of preference: the snapshot, then the sketch. Both sit inside `.room-scene` under the canvas and under the same veil as the 3D room, so the handover changes the picture and nothing else (The veil, below).

**The snapshot.** The last frame this browser drew, shown at once on the next visit. `snapshot.ts`:

- When: when the document turns hidden (`visibilitychange`), and once 10 s after the first drawn frame, so a visit whose tab is killed still leaves one. `pagehide` also tries, best effort: mobile Safari fires it unreliably and may freeze the page before the asynchronous steps finish. At most once a minute, only while the canvas has drawn and its context is not lost.
- How: without `preserveDrawingBuffer` the drawing buffer is readable only until the task that rendered it ends, so the canvas's `Loop` defines a `capture()`, armed by `armSnapshots` once it has drawn, that does it all in one task: it tells the frost registry to report no panels, calls `advance` once at the clock's current time (so the loop's next frame never gets a negative delta), copies the canvas with `drawImage` onto a 2D canvas at most 1600 px on its long side, then lifts the flag and calls `advance` again so the screen never shows the unfrosted frame. Then, asynchronously, `toBlob` as JPEG at quality 0.72 (about 150 to 300 KB) and one IndexedDB `put`.
- Why without the frost: a baked blur belongs to the layout it was taken under. The panels' tint is 79 % (`.frost-subtle`) to 87 % (`.frost`) opaque, so an old blur would show faintly through panels that have moved, and fully where a panel no longer is (a snapshot taken in a conversation, shown on the Palace page). The veil is CSS and never in the canvas. While the snapshot shows, the panels are their tint over a sharp picture, as over the sketch; the blur arrives with the canvas.
- Storage: database `portal-room` (version 1), object store `snapshot`, one record under the key `"last"`: `{ layoutVersion, blob, width, height, aspect, offset, scene, latitude, longitude, at }`. `width` and `height` are the viewport in CSS pixels (the layout registry's, the `.room-scene` box the canvas fills), `offset` is the camera's view offset `{ x, y }` at the capture (`layoutOffset`, the strip's anchor included), `scene` is day or night, `latitude` and `longitude` are the coordinates the room's sun clock used at the capture, `at` is epoch ms. A record missing a field (an older shape) is ignored. Each capture overwrites it.
- Eligible when `layoutVersion` is the current `LAYOUT_VERSION` (`@portal/shared/room`), it is under 6 hours old, its `scene` is the scene now at its own `latitude` and `longitude` (not over the page's sun clock, which starts from the browser zone's coordinates until the room's state arrives, and so would guess wrong around dusk and dawn wherever the zone is not where the room is), and its aspect is within 5 % of the viewport's. Aspect, not an aspect class: the fitted pose depends on the aspect throughout (the fit's distance changes with it even where the angles do not), and at the same aspect the same pose gives the same picture at another scale. A record from another layout version is deleted; a stale, other-scene or other-aspect one is ignored until the next capture replaces it. Nothing is captured or shown without WebGL or under reduced transparency.
- Chosen once per page load: the read starts when `snapshot.ts` evaluates on the client (a module-level promise), so it has usually answered by hydration. `RoomBackground` chooses when the layout registry has its first measure (`readLayout().width > 0`) and the read has answered; if the read has not answered 150 ms after hydration, the sketch. A later answer is not used, so the sketch never swaps for a snapshot.
- Placed as an `<img data-room-snapshot>` from an object URL, shown only after `img.decode()`, absolutely positioned at the stored size times the current viewport height over the stored height (the vertical field of view is fixed, so at one aspect the room scales with the height), translated by the difference between the current view offset (`viewOffset`, with the strip's anchor) and the stored one, scaled, so what the snapshot shows lands where the camera will draw it, under the strip too. It follows layout changes as the camera's view offset does; edges that fall short show the ground. The object URL is revoked when the image unmounts.
- A start-of-visit picture only: a lost context brings back the sketch, never the snapshot.

**The sketch.** The room drawn in pencil, lined up with the 3D room: while the room loads when no snapshot is eligible, after a lost context, and for the visit without WebGL, after a canvas failure, or under reduced transparency. `sketch.ts` (pure) and `Sketch.tsx`:

- An authored list of 3D polylines in room metres (`SKETCH` in `sketch.ts`), each the edges a viewer sees from the fitted poses: the camera is always above the room and to the right of its axis (yaw 14° to 25°, pitch 25° to 30°), so tops, fronts and right-hand sides, with no hidden-line removal at run time. The 3D room's own geometry is not read: the list is written once against `ROOM`, `ANCHORS`, `FURNITURE` and the constants the scene exports (`CHAIR`, `STOVE`, `WINDOW_CENTRE`), and the few sizes that are local to a scene file today (the desk, the rug, the hearth's parts, the bench, the small shelf) move to `layout.ts` so both read the same numbers. About fifty strokes for the room as it starts:
  - The shell: the back wall's foot (y 0, z −3) from x −4 to 14, broken by the door's casing; the left wall's foot (x −4) from z −3 to 10; the corner between them from y 0 to 10. The walls run past the frame and so do these strokes; the SVG clips them.
  - The window: the frame's outline (x −2.25 to −0.15, y 0.95 to 2.45), the mullion (x −1.2), the transom (y 1.88), and the inside sill's front edge (x −2.4 to 0, y 0.96, z −2.75).
  - The door: the casing (x 2.795 to 3.905, up to 2.28), the opening (x 2.875 to 3.825, up to 2.2), and through it the foot of the hallway's back wall (z −4.45).
  - The desk: the top's outline (x −2.12 to −0.28, y 0.725 to 0.795, z −2.89 to −2.21), the four legs and the drawer block. The chair in front of it (`CHAIR`: seat, back and legs, turned −1.2 rad) and the desk lamp at its left end (base, stem and shade, x −1.82).
  - The stove (`STOVE`, x 0.32, z −2.7): the body, the top plate, the kettle's outline, and the pipe from the plate (y 0.51) up to its elbow (y 1.46) and back into the wall.
  - The hearth: the chimney breast's two front corners (x 0.8 and 2.3, z −2.55, y 0 to 10), the brick surround (x 0.93 to 2.17, up to 1.08), the firebox's opening (x 1.15 to 1.95, up to 0.78), the mantel shelf (x 0.7 to 2.4, y 1.10 to 1.18, z −2.62 to −2.32) and the hearthstone's front edge (z −2.0).
  - The furniture with slots, empty: the small shelf's two boards and brackets (z −2.05 to −0.55, y 1.65 and 2.15, 0.3 deep), the corkboard's frame (y 2.44 to 3.12, z −1.98 to −0.62), the plant stand (x 2.16 to 2.74, tiers at 0.46 and 0.86), the mail tray's shelf (x 2.33 to 2.77, y 1.0) and the key rack's board (x 2.30 to 2.80, y 1.45).
  - The floor: the rug's border and inner outline (centred at x 0.3, z 0.5; 3.7 by 2.5 and 3.3 by 2.1) and the robots' bench on it (x −1.15 to 1.75, z 0.43 to 0.77, top at 0.25, with its legs).
  - Milestones change the list only where they change the room's lines, and only when the room's state is known as the sketch mounts (`RoomBackground` holds it outside the chunk): the tall bookcase in place of the small shelf (z −2.10 to −0.59, 2.45 high, front at x −3.62, five shelf lines), the second bookcase (z −0.30 to 1.21), the wide pinboard in place of the corkboard (z −2.03 to 0.13) and the bay's outline beyond the window. The rest of the milestones, every live object (robots, envelopes, the fire) and every accumulated one (books, notes, plants, frames, keys, the tree) are left out.
  - `projectSketch(pose, offset, size)` maps each point P with `projectPoint` from `layout.ts`, the camera's own maths without three.js: v = P − `target`; x = v·r, y = v·u, z = d − v·f (f, r and u as in section Camera); then, in CSS pixels, sx = W/2 × (1 + x / (z·tH)) − offset.x and sy = H/2 × (1 − y / (z·tV)) − offset.y, with tV = tan 15° and tH = tV × W/H. `pose` is `framePose(W/H)` and `offset` the same `viewOffset` the camera gets (the strip's anchor included), so each stroke lands where its edge will. Every authored point lies beyond the near plane (z > 0.5) at every pose of the blend, so nothing needs clipping in 3D.
  - Checked twice: a unit test projects every point with `projectSketch` and with a three.js `PerspectiveCamera` set up as `Camera.tsx` sets it, and they agree within 0.01 px at the six viewports, all in front of the near plane. In the UI suite with WebGL, the sketch's projection of `WINDOW_CENTRE` is within 2 px of the window hotspot's reported point (`points["window:window"]`, the same point).
- Looks: a flat warm dark ground (`#241f1a`, also `.room-scene`'s own `background-color`, so the page's first paint before hydration is the ground), the wall region above the floor line a shade lighter (`#2c2621`), strokes in a pale pencil (`#e8dcc8` at 55 %, 1.25 px, round caps and joins), the window's panes filled with the sky's gradient (the `--room-sky-top` and `--room-sky-horizon` colours `RoomBackground` already sets from the sun, at 70 %), a soft radial glow at the lamp (`#ffb86b`) and in the hearth (`#ff7a3a`). No text, no spinner.
- Draw-in: each path has `pathLength="1"`, so `stroke-dasharray: 1` and a `stroke-dashoffset` animated from 1 to 0 draw it in at any size without measuring it; 900 ms, ease-out, with an `animation-delay` from the stroke's depth (back wall first, rug last, spread over 500 ms). It plays the first time the sketch shows in a page load (a module-level flag) and never again: not after a lost context, not when the Palace page opens later, not on a resize. Under reduced motion the paths have `animation: none`; the global reduced-motion rule shortens durations but keeps delays, which would still stagger the strokes.
- Projected again when the layout registry's measure changes (`useSyncExternalStore(subscribeLayout, readLayout)`, as `Camera.tsx` reads it), never per frame; nothing is drawn before the first measure.

**The handover.**

- The canvas sits above the placeholder at `opacity: 0` with `transition: opacity 600ms ease-out`; `.room-scene[data-drawn] canvas` is `opacity: 1`. The `room-in` keyframes and the canvas's animation go.
- The first drawn frame: the `Loop` in `RoomCanvas.tsx` calls `reportRoom("drawn", true)` after the first `advance` that ran with the context not lost (repeats are no-ops in `reportRoom`). The `webglcontextlost` listener in `onCreated` reports `drawn: false`, and `clearRoomReport` on unmount forgets it. `data-room` carries `drawn` with the rest of the report; `RoomBackground`'s report writer also keeps a `drawn` state, set only when the value flips, and renders `data-drawn` from it.
- The placeholder does not fade: it stays opaque under the canvas while the canvas, opaque once drawn, fades in over it, and unmounts 600 ms after `data-drawn` appears. Fading both at once would dip towards the ground halfway. Under reduced motion the global rule makes the transition instant.
- A lost context hides the canvas (`data-renderer="fallback"` keeps its `visibility: hidden`) and mounts the sketch, complete, fading in from the ground over 600 ms; on `webglcontextrestored` the canvas remounts under a new key and hands over again. A canvas failure (the `CanvasBoundary`) leaves the sketch for the visit.
- The gradient on `.room-scene` goes; `--room-sky-top` and `--room-sky-horizon` stay for the sketch's panes.

**The veil.** The veil rules stop reading `data-renderer`. `.room-scene::after` takes today's WebGL values (`#1517138a`, night `#110f0c4d`), `[data-view="palace"]` has none, and the phone block keeps its gradients and the strip's 72 px, all without `[data-renderer="webgl"]`. The fallback values (`#151713a3`, night `#110f0c70`; on phones `#151713ad`, `#110f0c8a`) are deleted: the sketch's dark ground is no brighter than the room, so the lighter veil keeps text at least as readable. Today the veil also changes at hydration, because `data-renderer` is `fallback` until the WebGL probe runs on the client; that goes with it. `data-renderer` keeps its meaning (`webgl` while the canvas is up or coming, `fallback` otherwise), and a new `data-placeholder` says what is under the canvas:

| State | `data-renderer` | `data-placeholder` | `data-drawn` |
|---|---|---|---|
| Before hydration | `fallback` (the probe's server value) | none: the ground | no |
| Hydrated, the placeholder being chosen (the read's answer or its 150 ms deadline, the layout registry's first measure; usually within a frame) | `webgl` | none: the ground | no |
| Loading, a snapshot eligible | `webgl` | `snapshot` | no |
| Loading, none eligible | `webgl` | `sketch` | no |
| Drawn | `webgl` | the placeholder for 600 ms, then none | yes |
| Context lost | `fallback` | `sketch` | no |
| No WebGL, canvas failed, reduced transparency | `fallback` | `sketch` | no |

The veil is the same in every row: only `data-scene` (`pending` before hydration, which takes the day values) and `data-view` change it. The Palace page shows its placeholder unveiled, as it shows the room.

**Less waiting.** Measured before and after with the same script, which also records when the placeholder first shows (`data-placeholder`) and takes `data-drawn` as the first frame:

- The chunk is requested when `RoomBackground` mounts, not at the idle moment. `RoomBackground.tsx` names the loader once, `const loadRoomCanvas = () => import("./RoomCanvas")`, passes it to `dynamic(loadRoomCanvas, { ssr: false })`, and calls it in an effect when the canvas will mount (WebGL, no reduced transparency). The app router's `next/dynamic` (Next 16.3.5, `next/dist/shared/lib/lazy-dynamic/loadable.js`) is `React.lazy` over the loader with no `preload()` of its own; the bundler's module cache makes the second `import()` the same request and the same module, evaluated once. The mount still waits for the idle moment, its timeout lowered from 1.5 s to 800 ms.
- Before its first `advance` the `Loop` awaits `gl.compileAsync(scene, camera)`. In three r186 it builds every program synchronously, then resolves when each program's `isReady()` holds, polled every 10 ms without blocking where `KHR_parallel_shader_compile` exists (Chromium has it; Safari is to be checked on the M1). Without the extension it resolves after 10 ms and the first frame waits on the driver, as now. A canvas unmounted during the wait starts no loop.
- The compile runs with the frost pass's scene target bound (`setRenderTarget`, put back to null once the synchronous part returns). A program differs between the screen (AgX, sRGB) and a target (no tone mapping, linear), and every frame renders the scene into the target, so a compile against the screen would build programs no frame uses. `FrostPass` makes its pipeline on demand for whichever comes first and exports `compileRoom(gl, scene, camera)`.
- What that compiles: every mesh, points, line and sprite material in the scene graph at the call, hidden ones included (the stars), so the sky's, moon's, rain's and snow's `ShaderMaterial`s too, against the lights mounted at start. What it does not: the shadow pass's depth material (made at the first shadow render), the frost pipeline's five passes (their own scenes; small fragment shaders), and whatever mounts later (the kit's chair, a robot walking in, a milestone's furniture). These compile on first use, as now.
- `scene/kit.tsx` calls `useGLTF.preload(KIT_URL, false, true)` at module level (drei 10.7.9 has it). The arguments must match `useKit`'s: R3F caches by loader and URL only, so the first call decides the meshopt decoder. The 7.7 KB kit is then fetched when the chunk evaluates, and the first frame usually has the kit's chair rather than its stand-in.
- The fade starts at the first drawn frame (The handover), so the room never appears with a cut.

### Tests

- Web unit (`apps/web/tests/`): `room-layout.test.mjs` (the fit at six viewports, the strip's offset); `room-sketch.test.mjs` (a projected point matches the camera maths, the stroke count, the draw-in order); `room-snapshot.test.mjs` (eligibility by layout version, age, scene and aspect, each at its edge; the size and translation for another viewport and view offset). IndexedDB and the capture are left to the UI suite.
- Playwright, `tests/ui/room.spec.ts`. Headless Chromium has a WebGL canvas only with `setupPortal(page, { webgl: true })`; without it the fixtures' `disableWebGL` refuses the context, which is the no-WebGL case. The suite runs a production build, whose chunks are named by content hash, so a test holds the room's chunk with `page.route("**/_next/static/chunks/*.js")`: `route.fetch()`, and if the body contains `"WebGLRenderer: "` (a three.js message string the minifier keeps; the implementer confirms it in the build) wait for the test's release before `route.fulfill({ response })`; every other chunk passes at once.
  - "a drag and a wheel on the Palace page leave the camera where it is": `data-room.camera` unchanged after both (replaces "the Palace page's drag turns the camera").
  - "the sketch shows while the room loads, and the canvas fades in over it": `webgl: true`, the chunk held. Then `data-renderer="webgl"`, `data-placeholder="sketch"`, more than 30 `svg[data-room-sketch] path`, no `.room-scene canvas`. Released: `data-drawn`, `data-room.drawn` true, no `[data-placeholder]` within a second, and the veil's `getComputedStyle(room, "::after").backgroundColor` the same as while held.
  - "a lost context brings the sketch back until it is restored": `webgl: true`, drawn; `WEBGL_lose_context.loseContext()` on the canvas's context through `page.evaluate`; `data-placeholder="sketch"`, no `data-drawn`; `restoreContext()`; `data-drawn` again.
  - "at night the scene says so, and without WebGL the sketch stands in" replaces the gradient test: night clock, no `webgl`, `data-renderer="fallback"`, `data-placeholder="sketch"`, the paths there, no canvas, `.room-scene`'s computed `backgroundImage` is `none`.
  - "without WebGL the frost panels keep their tint over the sketch": the frost tint test with its name and comment changed; the assertions stand.
  - "under reduced motion the sketch is drawn at once": `page.emulateMedia({ reducedMotion: "reduce" })`, no `webgl` (so the sketch stays); every path's computed `animationName` is `none` and `strokeDashoffset` is `0`.
  - "a second visit shows the last frame before the room draws": `webgl: true` and no `page.clock` (the record's age reads `Date.now()`). Once `data-drawn`, `page.evaluate` redefines `document.visibilityState` as `"hidden"` and `document.hidden` as `true` (`Object.defineProperty`) and dispatches `visibilitychange`; poll IndexedDB in the page until `portal-room`'s `"last"` record exists. Then hold the chunk and `page.reload()` (the context's IndexedDB and init scripts survive it): `img[data-room-snapshot]` visible, `data-placeholder="snapshot"`, no canvas. Released: `data-drawn`, the image gone.
  - "the phone strip shows the window band": the window hotspot's point inside the strip's rect.
- Elsewhere: "under reduced transparency the panels are solid and the room draws no frost" also expects `data-placeholder="sketch"`, its comment no longer saying gradient; `portal.spec.ts`'s "the room renders a still under reduced motion and sidebar search finds session titles" swaps its `linear-gradient` assertion for `[data-placeholder="sketch"]`. No assertion in `portal-mobile.spec.ts` reads the gradient.

### Order

Each agent ends with `pnpm test`, `pnpm lint`, `pnpm build` and `pnpm test:ui` green (the build with the dev-server variables unset), its screenshots in `/tmp/palace-shots/revision-2/`, and a commit.

1. **Camera** (one agent): the fit, the removals, the unit tests and the Palace drag test, screenshots at the six viewports on both pages, day and night.
2. **Placeholders** (one agent, after 1, since the sketch projects with the fitted pose): the sketch, the veil rules, the handover and `data-drawn`, the three loading changes, and the UI tests above but the snapshot's. Screenshots of the sketch alone (no WebGL) and of a held chunk at 1440 × 900 and 390 × 844, both pages, day and night. The timings before its first change and after its last, with `/tmp/palace-load/measure.mjs` taught `data-drawn` and `data-placeholder`; if the script is gone, an equivalent (Playwright's Chromium on SwiftShader, the same three pages cold, the same columns plus the placeholder's time). Both tables go in the As built entry.
3. **Snapshot** (one agent, after 2): capture with the frost off, storage, eligibility, placement, the unit test and the second-visit UI test. Screenshots of a second visit before and after the handover at both sizes, and the second visit's time to its first picture with the same script.
4. A fresh reviewer over the three; fixes; the As built entries; the dev instance restarted on the result.

## Revision 3: a camera fixed on desktop

Agreed with Moses on 2026-10-09 after Revision 2 ran on the dev instance. On the session page with the sidebar closed, "camera is focused on mostly empty space"; with it open he liked the view, and asked that "the background should not move when I open/close the sidebar". His answers to the questions: the page was the session page; the background should be fixed outright, the right panels and the chat column included, not only the sidebar; resizing the sidebar should not move it either, so the composition is a design value, not the sidebar's width; and the view to keep is the one beside the open sidebar. Where this section differs from the sections above, this holds; the sections above were edited where the change is one line.

### What was measured

On the dev instance (3200 against 3201), the session page at four viewports with the sidebar open (280 px) and closed, headless Chromium on SwiftShader, read from `data-room.camera` after `data-drawn`:

| Viewport | Sidebar open: offset x, window x | Sidebar closed: offset x, window x |
|---|---|---|
| 1440 × 900 | −140, 879 | 570, 169 |
| 1920 × 1080 | 480, 503 | 690, 293 |
| 1280 × 800 | −140, 797 | 530, 127 |
| 1024 × 768 | −140, 661 | 0, 521 |

With the sidebar open at 1440 × 900 the margins beside the conversation's column were under 220 px, so the frame centred in the open region (140 px right): the window and desk near the middle, the shelving under the sidebar's glass, the door casing cropped at the right. Closed, the left margin grew past 220 px and the column rule aimed the frame at that margin's centre, 570 px left: the door and the bare wall beside it in the middle of the screen, the window off the left edge. That jump, and not the sidebar's own 140 px, is what Moses saw. At 1920 × 1080 the margin rule fired with the sidebar open too, so the frame sat 480 px left there. Screenshots: `/tmp/palace-shots/rev3-session-<viewport>-<open|closed>.png`; script `/tmp/palace-shots/rev3-session.mjs`.

### The rule

- **The aim.** The composition Moses chose is Revision 2's fit moved 140 px right at 1440 × 900. It goes into the pose rather than the offset, as a translation of the camera in room metres along its right axis (`aim` in `ANCHOR_POSES`, section Camera): −1.08 m in landscape, which at 12.9 m and tH = tan 15° × 1.6 draws the frame's centre 140.6 px right of the viewport's centre; 0 in portrait, since the phone's Palace page is centred and the strip has its own anchor; blended between 0.8 and 1.4 like the angles, so the pose stays continuous in the aspect. In metres rather than pixels so the composition is the same room at every landscape size: at 1920 × 1080, the same pose, the frame's centre sits 168.7 px right (140 × 1080 / 900); at 1024 × 768 (in the blend) 94 px.
- **No panel offset.** `CoverKind` is `focus` alone. The sidebar, the GitHub inspector, the tracked-sessions panel (both widths) and the message columns of a conversation and of Talk to Portal no longer register with the layout registry; `useRoomCover.ts` goes with the last of them; `MIN_MARGIN` and the margin rule go from `interestPoint`, which is the viewport's centre unless a visible `focus` cover (the phone strip) says otherwise. `layoutOffset` is unchanged in form and zero everywhere but under the strip. The registry stays for the strip and the stage.
- **The snapshot.** A frame drawn under Revision 2's pose does not line up with Revision 3's (the aim changes the parallax between depths, not only a translation), so `layout.ts` exports `CAMERA_VERSION` (2), the record stores `cameraVersion` beside `layoutVersion`, `snapshotEligibility` refuses a record from another camera version as "layout", and the read deletes one, as it does for another layout version. `LAYOUT_VERSION` is not bumped: it seeds the objects' slots and nothing moved in the room.
- **Phones and tablets.** Nothing changes on a phone: the Palace page is the portrait fit, the strip aims the window. An 820 × 1180 tablet with the desktop sidebar now shows the room centred under it, the sidebar's glass over the bookcases and the window's left fifth (before: moved 140 px right, the hearth cut); the open region shows the window to the door.

### Tests

- `room-layout.test.mjs`: the fit test checks the box inside the pad, centred and touching the pad under the pose *before its aim* (the target moved back by the blended aim along r); a new test checks the frame's centre at 860 ± 1 px at 1440 × 900 and at 960 + 168 ± 1.2 px at 1920 × 1080 (the same pose), the portrait target unchanged by the aim, the aim 0 at 0.8 and half the landscape value at 1.1, and the offset zero without a strip; the three cover tests (sidebar and right panels, the column's margins, covers that leave no room) go, replaced by one for the strip and a hidden strip; the six viewports' second entry is the phone under the strip instead of the right panel; the registry tests register a `focus` cover.
- `room-snapshot.test.mjs`: the version test adds a camera-version case; the first placement test is 1440 × 900 to 1280 × 800 with no panels (the frame fills the viewport, x 0); the strip fixture has only the `focus` cover. `room-sketch.test.mjs`: the same two fixture changes.
- `room.spec.ts`: the fitted-frame check compares the reported box with the pure projection (`framePose`, `frameSpec`, `boxCorners`, `projectPoint` imported from `layout.ts`) within 2 px on every edge, keeps the vertical centring and pad, and expects a zero offset; new, "the sidebar coming and going leaves the room where it is" at 1440 × 900 on a session page: `camera` identical before and after the sidebar toggle, offset zero both times.

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

Phase 3, 2026-10-09 (`6880623`). Built as written, with these differences:

- **Robot parts are instanced with drei's `Merged`**, one draw call per part across every robot; books and plants (phase 4) are plain `InstancedMesh`es written in a `useFrame`. drei's `Instances` is not used.
- **Click targets the spec left open or named loosely**: the kettle opens `/watches` (the jobs live on the Watches page; there is no separate jobs view), and the lamp, which the spec gives no target, opens Portal's chat (`/`). A key opens the approvals dialog when an approval is pending; with none, the dialog would be empty, so it opens System, where the grants are listed.
- **On the Palace page a clicked robot waves, then its card shows pinned** with a button to its session; the click itself does not navigate. Elsewhere a click on a robot opens its session at once. Clicks on the Palace page wait out a possible double click first (the double click frames the object).
- **The window, the tree and a purged book pin their card** on click: they have no page of their own.

### Growth

Phase 4, 2026-10-09 (`3071f07`, `7fc100e`). Built as written, with these differences:

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

2026-10-09, after two reviews of the web side (`4344ca0` to `1854614`). Where these differ from the sections above, these hold.

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

Server side, from a third review (`5ec383b`):

- **Sessions counted once.** A new session reaches the census twice, in the list and as its "created" event, in either order; a recount landing between the two added it twice to the high-water `sessionsEver`. The census keeps the ids it has counted; only the first count after boot takes the list's size as a minimum.
- **Weather every 20 minutes.** The refresh timer saw the weather as still fresh at each tick (the stamp was taken when the fetch finished) and fetched only every other tick; the timer treats it as stale half an interval early.
- **Forced refresh.** A "Refresh" from Settings arriving during a background lookup was answered by that lookup; a forced one is now queued after it.
- **Stream.** A census failure no longer fails the portal stream's opening: the `room` opening event is left out and logged at warn.
- **Shutdown** waits for a running recount before the pool closes, so a milestone saved to the row always gets its Activity entry.

### Revision 2, step 1: camera

2026-10-09 (`e0f59fd`). Built as written in sections Camera and Revision 2, with these differences and calls:

- **The phone's numbers differ from the spec's prose, which was worked out on the box to the key rack.** The spec's 28.2 m at 390 × 844, the window at 299 to 369 px and the band at 288 to 556 px are what a portrait box to x 2.8 gives (the fit reproduces 28.24 m and a 106 px window for it). The table's box, to the hearth's opening at 2.3, is what was built: 26.02 m, the window 115 px wide (x 111 to 226, y 290 to 366), the box's band 278 to 566 px down the screen, the frame's centre at 422. The window is above the frame's centre, as the spec says, so the strip's anchor is needed all the same.
- **Measured window width** (the window frame's outer edges, x −2.25 and −0.15 on the glass, projected with the pose; the screenshots agree to within a few pixels read by eye): **210 px at 1440 × 900** (209.5; the first version's 194) and **115 px at 390 × 844** (114.9; the first version's 145). Moses's to retune after a look on his phone.
- **The other viewports**: 1280 × 720 and 844 × 390 take the 1440 × 900 pose (12.9 m, aspect past 1.59); 820 × 1180 takes the portrait anchor's angles and box (its aspect 0.69 is below 0.8, so not in the blend) at 17.52 m, yaw 14°, pitch 30°. Seen in the screenshots: at 820 × 1180 the desktop layout's 280 px sidebar covers a third of the window, so with the frame moved 140 px right the bookcases sit under the sidebar and the hearth is cut by the right edge. That is the rule (the fit uses the full window, not the open region) and is left for Moses's look.
- **Shared maths in `layout.ts`**: `ANCHOR_POSES` holds the two anchors with their boxes, `frameSpec(aspect)` the blended angles and box (Camera.tsx reports the box from it), `boxCorners`, `FRAME_PAD` (0.06), `FOV` (30) and `LANDSCAPE_ASPECT`. `layoutOffset(layout, pose)` picks the anchor (the window's centre under a `focus` cover, the frame's centre otherwise) and returns `viewOffset(...)`, so the sketch and the snapshot will take the camera's offset from the same function. `projectPoint` returns the depth `z` with `x` and `y`, for the sketch's near-plane check.
- **`WINDOW_CENTRE` moved to `layout.ts`** as a plain `[x, y, z]` (pure, for the fit and its tests); `scene/Window.tsx` builds its `Vector3` from it. `WindowView` still follows the camera in a `useFrame`: cheap, and correct for any pose.
- **The report**: `offset` is rounded to 0.1 px like `box`. Camera.tsx also sets `camera.aspect` itself before `setViewOffset`, rather than relying on R3F's resize having run first.
- **What went with the look-around beyond the spec's list**: `RoomHit` loses its `centre` and `radius` (only the framing flight used them), so `pickRoom` no longer computes a bounding sphere per pick; `CameraRig` loses its `reducedMotion` prop. Escape still puts a card away, and a click on the empty room still hides one, on every page. `PalaceView` keeps `select-none`; `touch-none` went with the gestures.
- **Tests.** Gone, as listed: two in `room-layout.test.mjs`, the four look tests in `room-live.test.mjs`, two in `room-pointer.test.mjs`, and the drag test in `room.spec.ts`. Added to `room-layout.test.mjs`: the fit at the six viewports (inside the pad to 1e-6 px, centred within 0.01 px, touching the pad on both sides of one axis within 0.01 px), the right panel's offset of 160 px with the pose unchanged and the strip's window at (195, 36) within 0.01 px, the anchors' angles at and beyond 0.8 and 1.4 with the blend's midpoint, the continuity sweep from 0.45 to 2.5, and the agreement with a three.js `PerspectiveCamera` within 0.01 px at the six viewports (box corners and the window's centre, all in front of the near plane); the view offset test gained an anchor case. Added to `room.spec.ts`: "a drag and a wheel on the Palace page leave the camera where it is" (also: the page's cursor is `auto`), the fitted frame on the Palace page at 1440 × 900 and 390 × 844 (two tests sharing one check), and the phone strip test now also checks that `points["window:window"]` is within 2 px of the strip's centre. Web unit tests 207, UI suite 172, all passing.
- **Screenshots** on the dev instance (3200 against 3201, the server's real location, New York, and weather, clear), taken 2026-10-09 around 13:10 EDT with headless Chromium on SwiftShader: day is the real clock, night the page's clock set to 23:00 EDT the same day. `/tmp/palace-shots/rev2-camera-<viewport>-<page>-<day|night>.png` for 1440x900, 1280x720, 820x1180, 390x844 and 844x390 on `palace` and `home`; `1440x900-right` is Portal home with the 320 px tracked panel open (the plain 1440x900 home shot has it collapsed; the Palace page has no right panel). The phone strip is from the UI fixtures (no pane is open on the dev instance at that size): `rev2-camera-390x844-strip-fixture-day.png`. Script: `/tmp/palace-shots/rev2-shots.mjs`.

### Revision 2, step 2: placeholders and loading

2026-10-09 (`04a425b`). Built as written in Revision 2's Before the room draws (the sketch, the handover, the veil, Less waiting), without the snapshot, with these differences and calls:

- **The strokes**: 68 for the room as it starts, 79 with the four milestones that change lines. Beyond the spec's list: the window's inner frame edge (the panes' outline), the corner where the chimney breast's right side meets the back wall, the desk top's front and right edge, the drawer's front, the lamp shade's rim, the stove body's corner, the kettle's spout and handle, the mantel's front edge, the sill as its top outline, the bookcases' right sides, the cork inside the board's frame and the mail tray's front lip. The back wall's foot is also broken at the chimney breast (the breast hides it), and the hallway's foot runs x 2.755 to 3.705, where it shows through the opening from the camera's side. Left out: the door's leaf (swung into the hallway), the hallway's sides, the stove's legs. Round things (the lamp's shade, the kettle) are outlined in the plane of the camera's right at a yaw of 20°, between the poses' 14° and 25°.
- **Sizes moved out of scene files**, so the pure `sketch.ts` (which the node test runner loads; it cannot load a `.tsx` scene file) reads the numbers the scene builds from: `DESK`, `DESK_LAMP`, `CHAIR` (from `Lamp.tsx`), `STOVE` (from `Kettle.tsx`), `HEARTH`, `RUG`, `BENCH` (`live.ts`'s `SPOTS.bench` reads it), `SMALL_SHELF`, `BOOKCASE`, `MAIL_SHELF` and `BAY` (from `Window.tsx`) to `layout.ts`; `CORKBOARD` and `PINBOARD` (from `Corkboard.tsx`) to `layout-slots.ts`, beside `ANCHORS`. Nothing moved in the room, so no `LAYOUT_VERSION` bump.
- **Draw-in order**: a stroke's depth is the mean room z of its points, clamped at the back wall; the shell's lines (which run to z 10 and y 10) count at the back wall. The delays are linear in that depth from 0 to 500 ms: the walls, the window, the door and the hallway at 0, the desk about 60, the left wall's shelf and board about 230, the rug 470 and the bench, which stands on it, last at 500.
- **Dash pattern**: `stroke-dasharray: 1 1.1`, the offset animated from 1.05 to 0, rather than `1` from 1: with round caps, a dash ending exactly at a path's start draws a dot there before the stroke draws in.
- **Near plane**: no authored point is behind it at any pose (unit-tested at the six viewports, with every milestone too), but `projectSketch` cuts a polyline where it crosses depth 0.5 and drops what lies behind, and the walls' fill polygon is clipped the same way (Sutherland-Hodgman against the one plane), so a later stroke cannot fold through the camera.
- **The SVG**: `svg[data-room-sketch]` carries `data-draw-in` while it is the page load's first sketch and `data-window`, `WINDOW_CENTRE` as projected, for the UI test. The wall shade (`#2c2621`) is one polygon over both walls above their floor lines. The glows are radial gradients, 0.9 m round the lamp's shade (32 % at the centre) and 1 m in the hearth (30 %), sized for their depth. The pane gradient's colours are CSS classes on its stops reading `--room-sky-top` and `--room-sky-horizon` at 70 %. Gradient ids come from `useId`.
- **When it shows**: from hydration (a `useSyncExternalStore` flag) until the canvas has drawn and 600 ms more. Its milestones are the room's as it mounts, kept for its life; on a cold load the room's state usually arrives after hydration, so the first sketch is the starting room's, as the spec says. A sketch mounting after the draw-in has played (a lost context, the background remounted) fades in from the ground over 600 ms (`room-sketch-in`); the first draws in instead. The module flag is set once the first sketch has had its first measure.
- **`drawn`**: the `Loop` reports it once per loop (a local flag), not by calling `reportRoom` every frame. `RoomBackground`'s report writer sets its `drawn` state from `report.drawn === true` on every write (React drops equal updates), so a cleared report, when the canvas unmounts, also brings the sketch back.
- **A restored context left the room hidden for good** (from the review fixes, found by the new UI test): R3F disposes an unmounted canvas's renderer with `forceContextLoss()`, so remounting under a new key fired `webglcontextlost` on the old canvas, which set the background's context-lost state again while the new canvas drew. The canvas's listeners now ignore events once it has unmounted.
- **Case-insensitive disks**: without extensions `sketch.ts` and `Sketch.tsx` are the same name to macOS, and `"./Sketch"` resolved to `sketch.ts` (tsc TS1149). Both imports name the extension.
- **The compile**: `FrostPass`'s pipeline lives in a module `WeakMap` by renderer, made by whichever comes first (`compileRoom` or the first frame) and disposed with the component. `compileRoom` binds the scene target, calls `compileAsync` (in three r186 its compile runs synchronously inside the call) and puts the previous target back in a `finally`. The promise is kept per renderer, so a loop restarted when reduced motion changes does not compile again. A throw in the synchronous part becomes a rejection; on a rejection the loop starts anyway, with a console warning.
- **The load event now waits on the room's chunk** (0.6 MB over the wire) when the chunk is requested before it fires, which it often is now that the request starts at hydration. Nothing in the app waits on the load event; the UI test that holds the chunk navigates with `waitUntil: "domcontentloaded"`.
- **Headless Chromium on SwiftShader has no `KHR_parallel_shader_compile`** (three warns so in the console): `compileAsync` then does the same synchronous work the first frame did, so the timings below cannot show what moving the compile buys. Chromium on a GPU has the extension; Safari is to be checked on the M1, as the spec says.

**Timings.** `/tmp/palace-load/measure.mjs`, rewritten: per page one warm-up load (so `next dev`'s on-demand compiling is out), then five cold loads, each in a fresh context with the cache cleared; the medians, from navigation start, on the dev instance (`next dev` on 3200, the server on 3201 with its real data) with headless Chromium on SwiftShader. In-page timestamps: a `MutationObserver` for the canvas, `data-placeholder` and `data-drawn`, and a hook on `WebGL2RenderingContext`'s draw calls for the first draw into the default framebuffer (the composite to the screen), which works on either revision, so the two tables compare like with like. (Polling `data-drawn` from outside read it up to 0.5 s late while the main thread was busy with the following frames.)

Before, at `2ac445f` (the gradient from the first paint until the canvas covered it):

| Page | Placeholder | Canvas in the DOM | First frame drawn |
|---|---|---|---|
| `/palace`, 1280 × 800, cold | the gradient, from the first paint | 0.73 s | 2.08 s |
| `/`, 1280 × 800, cold | the gradient, from the first paint | 0.76 s | 2.10 s |
| `/palace`, 390 × 844, cold | the gradient, from the first paint | 0.67 s | 1.99 s |

After (the ground from the first paint, the sketch from hydration):

| Page | Sketch (`data-placeholder`) | Canvas in the DOM | First frame drawn | `data-drawn` |
|---|---|---|---|---|
| `/palace`, 1280 × 800, cold | 0.21 s | 0.76 s | 2.09 s | 2.10 s |
| `/`, 1280 × 800, cold | 0.23 s | 0.83 s | 2.23 s | 2.23 s |
| `/palace`, 390 × 844, cold | 0.23 s | 0.41 s | 1.73 s | 1.73 s |

The page shows the room's lines at about 0.2 s instead of a flat sky, and the canvas fades in at its first frame instead of appearing with a cut. The first frame itself is no sooner on the desktop: the canvas mounts at the same moment (the page's idle moment came before the old 1.5 s timeout too), and on SwiftShader the compile costs what it did. On the phone it came 0.26 s sooner, with the canvas mounting 0.26 s sooner. Portal home was 0.13 s slower in the median, its five loads spread 2.19 to 2.58 s (two loads hydrated late, at 0.41 s, against 0.04 to 0.2 s variation before); the sketch's draw-in, a stroke-dashoffset animation the compositor cannot take, repaints its SVG on the main thread for 1.4 s while the room loads, which may account for part of it. Not measured further.

**Tests.** Web unit: `room-sketch.test.mjs`, five tests: every point of the starting room's strokes and of every milestone's, projected with `projectSketch`, within 0.01 px of a three.js `PerspectiveCamera` set up as `Camera.tsx` sets it at the six viewports, all in front of the near plane; the stroke count (45 to 75), unique ids, and the milestones changing only their own strokes; the draw-in order (the back wall at 0, the bench and rug past 400 ms, delays never decreasing with depth); the near-plane cut and drop; the window under the phone strip at (195, 36) within 0.01 px, the paths' syntax, the panes inside the window's opening. Web unit tests 212. UI (`room.spec.ts`): added "the sketch shows while the room loads, and the canvas fades in over it" (the chunk held by the `"WebGLRenderer: "` string, which one production chunk of 1.08 MB carries; it also checks the sketch's `data-window` within 2 px of `points["window:window"]`), "a lost context brings the sketch back until it is restored" (also: the sketch that returns does not draw in again) and "under reduced motion the sketch is drawn at once"; "at night the scene says so, and without WebGL the sketch stands in" replaces the gradient test; the frost tint test is renamed for the sketch; the reduced-transparency test expects `data-placeholder="sketch"`; `portal.spec.ts`'s still test swaps its gradient assertion for `data-placeholder="sketch"`. "A milestone that arrives over the stream is delivered in a crate" now waits for `data-drawn` before pushing: with three workers on SwiftShader the canvas could mount after the push, see the milestone in its first state, and the crate was gone before the 5 s poll looked (it failed once in four runs of the room and portal files). UI suite 175, all passing.

**Screenshots** on the dev instance, 2026-10-09 around 15:00 EDT (day the real clock, night the page's clock at 23:00 EDT), headless Chromium on SwiftShader, at 1440 × 900 and 390 × 844, Palace page and Portal home: `/tmp/palace-shots/rev2-sketch-<viewport>-<palace|home>-<day|night>-nowebgl.png` (the sketch alone), `-held.png` (the room's chunk held), `-drawn.png` (the same page after release), and `-overlay.png` (the held sketch at half opacity over the drawn room). In every pair the sketch's window lands within 0.3 px of the window hotspot's reported point, and the overlays show the desk, the chair, the lamp, the stove, the hearth, the rug, the bench, the door, the plant stand, the shelves and the board on the 3D room's edges; on the dev instance's room the bookcases are there and the sketch, mounted before the room's state arrived, draws the small shelf. Over the chat at night (the lightest veil, 30 %), the strokes show through between the lines of text, thin and readable; Moses's to judge. Scripts: `/tmp/palace-shots/rev2-sketch-shots.mjs`, `/tmp/palace-shots/overlay.mjs`.

### Revision 2, step 3: snapshot

2026-10-09. Built as written in Revision 2's The snapshot, with these differences and calls:

- **The record also stores `offset`**, the camera's view offset at the capture (`layoutOffset`'s `x` and `y`), beside the spec's fields (`interest` is stored too, unused). `interest` alone cannot say whether the strip's anchor was in use, so a frame taken under the phone strip and shown on the Palace page (or the other way) would have landed 100 px or more off. Same database, store, key and version; no migration needed (nothing was stored before).
- **The placement keeps the frames' centres lined up** (`snapshotPlacement`): the frame is drawn at its stored size times current height over stored height, its top left at s × (stored offset − stored centre) − (current offset − current centre). That is the spec's "difference of the view offsets, the stored one scaled" plus a centring term that is zero at the same aspect and makes it exact at a slightly different one whenever the pose is the same (every aspect from 1.59 up). In the blend the pose itself differs a little: at 820 → 860 × 1180 the window lands within 12 px.
- **Eligibility edges**: under 6 hours (exactly 6 h is too old); a record from the future (clock moved back) is ineligible; the aspect is compared as a ratio, |stored / current − 1| ≤ 5 %, the edge included. The age is taken when the read's answer reaches the background, not per render (React's purity rule). A record that is not a well-formed one (wrong types, no Blob) is ignored like an ineligible one; one from another `LAYOUT_VERSION` is deleted at the read.
- **Where the code sits**: `snapshot.ts` (pure maths, the IndexedDB read and write, `copyFrame`, and `armSnapshots`, the triggers); the canvas's `Loop` defines `capture()` and arms it after its first drawn frame, disarming on unmount; the frost registry has `suspendFrost(on)`, under which `collectFrost` reports no panels without touching its bookkeeping. `capture()` renders with `advance(performance.now() / 1000)`, copies, lifts the flag and renders again, and returns null when the context is lost or the loop is gone. The once-a-minute limit is per page load across canvases. The image is a new file, `SnapshotImage.tsx` (a `Snapshot.tsx` would clash with `snapshot.ts` on a case-insensitive disk, as the sketch's did).
- **The decode**: the object URL is decoded off the page (`new Image()`, `decode()`), and the `<img>` is rendered only then, with the same URL (the decoded image is reused). Decoding the rendered element instead needs a state set synchronously in an effect, which the lint rules refuse. A failed decode spends the snapshot and the sketch shows.
- **Choosing**: from hydration until the choice is made (the read's answer or its 150 ms deadline, the scene known, the layout registry's first measure, usually within a frame) `data-placeholder` is absent and the ground shows; before step 3 the sketch's SVG was mounted then but drew nothing until the same first measure, so nothing visible changed. The choice is module-level, so a background mounted later in the page load keeps it. The snapshot is spent, for the rest of the page load, when the handover finishes (600 ms after `data-drawn`), on a lost context, on a canvas failure and on a failed decode; after that every placeholder is the sketch. A snapshot under reduced transparency or without WebGL is never chosen to show (`data-renderer` is `fallback`, so the sketch), and `armSnapshots` does nothing under reduced transparency.
- **No veil change, no fade on the image**: it sits under the canvas, which fades in over it; it unmounts with the placeholder. CSS `.room-snapshot` in `globals.css` (absolute, `max-width: none` against the preflight).
- **Record size**: 62 KB at 1440 × 900 (DPR 2, buffer 2160 × 1350 stored at 1600 × 1000), 28 KB at 390 × 844 (DPR 3, buffer 585 × 1266 at the canvas's 1.5 cap, stored as is). The spec's 150 to 300 KB estimate was high: the room's flat colours compress well.

**Timings** (`/tmp/palace-load/measure.mjs`, taught a `snapshot` mark and `SECOND=1`: in one context a first load drawn, the document made hidden, the record polled for, the HTTP cache cleared, then the measured load; three runs, medians, dev instance, SwiftShader):

| Page | Placeholder (kind) | Snapshot on the page | Canvas in the DOM | First frame drawn | `data-drawn` |
|---|---|---|---|---|---|
| `/palace`, 1280 × 800, second visit | 0.30 s snapshot | 0.31 s | 0.76 s | 2.08 s | 2.08 s |
| `/`, 1280 × 800, second visit | 0.23 s snapshot | 0.26 s | 0.72 s | 2.03 s | 2.04 s |
| `/palace`, 390 × 844, second visit | 0.19 s snapshot | 0.19 s | 0.32 s | 1.59 s | 1.59 s |

A second visit shows the room itself at 0.2 to 0.3 s, where step 2 showed the sketch at about the same time and the room at about 2 s.

**Tests.** Web unit: `room-snapshot.test.mjs`, nine tests: eligible at the current version, age, scene and aspect; the layout version either way; 6 h minus a millisecond eligible, 6 h and a future record not; day and night each way; the aspect at 5 % either way eligible, 5.05 % and a portrait record not; the placement from 1440 × 900 with the tracked panel to 1280 × 800 with the sidebar (size, a translation of 160 × 8/9 + 140 px, and six room points within 0.01 px of `projectPoint` with the current pose and offset), from the phone's Palace page to the strip and back (the window at the strip's centre, 195, 36), and at a 4 % wider aspect (exact) and in the blend (within 12 px); `captureSize`. Web unit tests 221. UI: "a second visit shows the last frame before the room draws" as the spec writes it (the hidden state by `Object.defineProperty` on `visibilityState` and `hidden` and a dispatched `visibilitychange`; the record polled in IndexedDB; the reload with the chunk held shows a visible `img[data-room-snapshot]` over the whole viewport, `data-placeholder="snapshot"`, `data-renderer="webgl"`, no canvas and no sketch; released, `data-drawn`, the image gone and no placeholder). UI suite 176, all passing.

**Screenshots** on the dev instance, 2026-10-09 around 15:55 EDT (day), headless Chromium on SwiftShader, DPR 2 on the desktop and 3 on the phone: `/tmp/palace-shots/rev2-snapshot-<1440x900|390x844>-<palace|home>-<first|snapshot|handover|drawn|overlay>.png`: the first visit drawn, the second visit before the canvas draws (the chunk held), 250 ms into the fade, drawn, and the snapshot at half opacity over the drawn room. Also `rev2-snapshot-1440x900-palace-to-home-*.png`: taken on the Palace page (offset −140) and shown on Portal home (offset 20), placed at a translation of −160 px. In every overlay the room's edges are single, not doubled, the cross-layout one included: the snapshot lands where the room then draws, and the handover changes only the frost (the panels go from tint over a sharp picture to tint over the blur) and what moved meanwhile (the robots, the fire). Scripts: `/tmp/palace-shots/rev2-snapshot-shots.mjs`, `rev2-snapshot-cross.mjs`, `rev2-snapshot-overlay-phone.mjs`.

### Revision 2, review fixes

2026-10-09, after two reviews of steps 1 to 3 (`2ac445f` to `cd3a049`). Where these differ from the sections above, these hold.

- **No hover or click before the canvas has drawn.** The pointer listener and the hover card ran from the canvas's mount, while it was still transparent and before any frame had updated the objects' matrices for the raycast. They now wait for the first drawn frame too (`drawing` in `RoomBackground` is mounted, not lost, and `drawn`). UI: with the room's chunk held, the pointer over the sketch's window shows no card and no pointer cursor (with the chunk held there is no picker at all, so the assertion guards the gate's outcome rather than reproducing the race, which needs a mounted canvas still compiling).
- **The snapshot's scene is worked out where it was taken.** The choice compared the record's scene with the page's sun clock, which starts from the browser zone's coordinates (`latitudeForTimeZone`) until the room's state arrives; around dusk and dawn, wherever the zone is not where the room is, a good snapshot was refused or the other scene's shown. The record now stores `latitude` and `longitude` (the clock's, `SunClock.place`, new), and `snapshotEligibility` takes no scene: it compares the record's with `sceneAt(now, record's coordinates)` (new in `sun.ts`). The choice no longer waits for the page's scene. A record without the coordinates (taken before this) is ignored until the next capture. Unit tests: the day-to-night case reworked on real New York times, and a dusk test (eligible at 18:10 EDT, refused at 18:40 EDT, while Berlin is already dark at the first, and a Berlin night record eligible then).
- **`interest` dropped from the record**: stored but never read; `offset` does its work. The spec's Storage bullet lists the fields as built.
- **The background stops following the layout once the choice is made.** `useSnapshotChoice` subscribed to the layout registry for the whole page load, re-rendering `RoomBackground` on every layout change. It now reads only the aspect, and only while choosing: after that its `useSyncExternalStore` takes a no-op subscription and a constant.
- **A sketch after a snapshot appears complete.** `Sketch.tsx` exports `skipSketchDrawIn()`, called when a snapshot is chosen and whenever it is spent, so a sketch that follows (a lost context, a failed decode) fades in from the ground rather than playing the 900 ms draw-in.
- **No negative frame delta after a capture.** `capture()` advanced R3F's clock to `performance.now()`, which the loop's next rAF timestamp can precede (under `frameloop="never"` R3F takes the delta as timestamp minus the clock). Both of the capture's frames now render at the clock's current time (a delta of zero), and the loop passes `max(timestamp, clock)`.
- **A failed chunk preload is handled**: `loadRoomCanvas().catch(() => {})`; the lazy component's own failure still goes to the boundary and the sketch.
- **One viewport size.** The layout registry measured `window.innerWidth` and `innerHeight`, the camera R3F's measure of the canvas (the fixed `.room-scene` box); with a classic scrollbar or on iOS they differ, and the sketch's and the snapshot's pose and offset with them. `RoomBackground` registers its `.room-scene` element with the registry (`registerStage`, observed by the registry's `ResizeObserver`), and the registry's width and height are that element's box, the size R3F measures; before it registers, `document.documentElement.clientWidth` and `clientHeight`. `interestPoint` and `layoutOffset` take the registry's size, the covers' rects are in the same client coordinates, and the picker and the hotspots' points read the canvas's own rect, so nothing else assumed the window's inner size (the hover card still clamps to the window, which is what it is placed in). Unit test: with the root 1425 wide in a 1440 window, the registry reports 1425, then the stage's box, then the root's again once the stage goes.
- **UI tests.** The placeholder's removal after `data-drawn` waits up to 3 s (was 1 s, about 400 ms of slack on SwiftShader). The drag-and-wheel test and the fitted-frame tests read `camera` after `data-drawn`, so a late cover registration cannot change `offset` under them. The second-visit test now also checks that the screen is frosted again after the capture: a `MutationObserver` with `attributeOldValue` on the canvas's `data-frost` sees the capture's frame at 0 panels and the attribute back at the count before.
- **Stale text**: decision 21's look-around camera; the Camera section's phone numbers (26.02 m, the window 115 px wide at x 111 to 226 and 290 to 366 px down, the band 278 to 566 px; they were the box to the key rack's); step 1's 820 × 1180, which is past the portrait anchor (0.69 < 0.8), not in the blend; the veil table's choosing row; the Storage and How bullets (`capture()`, the fields); `globals.css`'s frost comment (the tint over the sketch, not the gradient) and the room block (the snapshot as a placeholder too).

**The phone's box, for Moses's look** (no change committed: the portrait box's right edge stays at x 2.3). The window's width at 390 × 844 on the Palace page (the frame's outer edges at the window's centre height, projected with the pose; the dev instance's reports agree with the fit's distances):

| Right edge | Distance | Window width (x) | Box band (y) | Screenshot |
|---|---|---|---|---|
| 2.3, the hearth's opening (as built) | 26.02 m | 114.9 px (111 to 226) | 278 to 566 px | `/tmp/palace-shots/rev2-phone-box-2.3.png` |
| 1.6, mid-way across the firebox's opening (1.15 to 1.95) | 22.90 m | 130.1 px (123 to 253) | 261 to 583 px | `/tmp/palace-shots/rev2-phone-box-1.6.png` |
| 1.2, at the opening's left edge | 21.12 m | 140.7 px (130 to 271) | 250 to 595 px | `/tmp/palace-shots/rev2-phone-box-1.2.png` |

The first version's window was 145 px. Seen in the shots: at 1.6 the firebox's opening is still whole, the brick surround cut by the right edge, and the mail tray, plant stand and key rack past it; at 1.2 the opening itself is cut, about half the fire showing. Taken on the dev instance (3200 against 3201) with headless Chromium on SwiftShader, DPR 3, by editing the number, waiting for `data-drawn`, and putting it back. Script: `/tmp/palace-shots/rev2-phone-box.mjs`.

**Tests.** Web unit 223 (the dusk test and the registry's stage test new), UI suite 176, all passing; the room file passed twice more with `--repeat-each=2`. One run of the room file alone failed once in "the Settings dialog's Room section shows the location and weather…": the Settings dialog did not open (the test dispatches `portal:open-settings` right after `goto`, which can precede the listener under load); it passed four times out of four alone and in the full suite. Untouched here.

### Revision 3: the camera fixed on desktop

2026-10-09 (`714a098`, the review's fixes in the commit after it). Built as section Revision 3 writes it, with these notes:

- **The aim is −1.08 m**, which draws the frame's centre 140.6 px right of the viewport's centre at 1440 × 900 (the measured Revision 2 offset was 140 px; 1.0757 m would reproduce it exactly, and the round number was kept). On the dev instance the session page now reports the same `camera` with the sidebar open and closed at 1440 × 900, 1920 × 1080, 1280 × 800 and 1024 × 768 (offset 0, the box at 244.7 to 1492.1 across and 54 to 846 down at 1440 × 900, the window's hotspot at x 858); before, the sidebar's closing moved the frame 570 px left on that page. Screenshots `/tmp/palace-shots/rev3-session-<viewport>-<open|closed>.png` (the "open" shots before the change are overwritten by the after ones; the before numbers are in the section's table), and `/tmp/palace-shots/rev3-<viewport>-<palace|home>.png` at 1440 × 900, 820 × 1180 and 390 × 844. Scripts `/tmp/palace-shots/rev3-session.mjs` and `rev3-shots.mjs`.
- **Seen in the shots.** At 1440 × 900 the sidebar's glass holds the shelving and the ladder, the open region shows the window to the door, and with the sidebar closed the bookcases simply show where it was. At 820 × 1180 (the portrait anchor, aim 0) the sidebar's glass now sits over the bookcases and the window's left fifth, the open region showing the rest of the window to the door; before, the frame was moved 140 px right and the hearth cut. Left for Moses's look, as the sidebar on a tablet was.
- **The snapshot's camera version** is stored as `cameraVersion` on the record, a number beside `layoutVersion`; a record without it (one taken before this change) fails `asRecord` and is deleted by the read as a version mismatch is. No layout version bump, so no object moved.
- **Review** (one fresh Opus reviewer, read-only): no correctness defects; six text and test findings, all fixed: the `roomCover` comment's example (`"left"`, which no longer typechecks); the fitted-frame UI test's title (it is no longer "centred in the open region"); the view-offset paragraph's opening sentence, which still described the panels as covers; the sidebar-toggle UI test's fixed 300 ms wait, now two animation frames, and it toggles the sidebar back and checks again; the aim test's portrait case, which now pins the phone's target to its numbers so an aim on any axis would show; and the Camera section's window and door numbers, now with the points they are measured at (the window's frame on the glass about 752 to 974 px, the door casing's corner 31 px past the edge).
- **Tests.** Web unit 220 (three cover tests replaced by one, the aim test new), the full UI suite 177 (the sidebar-toggle test new), typecheck and lint clean.
