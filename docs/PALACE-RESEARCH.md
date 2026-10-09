# Palace rooms: research notes (2026-10-08)

Survey done before designing generated, time-aware room backgrounds for Portal (to be renamed Palace). Nothing here is decided; see the questions at the end. Web-search budgets ran out in every agent, so items marked unverified were not confirmed on a primary page.

## What exists today

- `apps/web/public/rooms/{light,dark}-room.webp` (1672×941, AI-generated photoreal rooms with a blank centre wall), chosen by local clock at 7am/7pm (`lib/room-scene.ts`), overridable via `RoomModeControl` (light/dark/system).
- `RoomBackground` is one fixed div behind the workspace; `decorForSession` hashes the session id into one of four crops; `data-activity` (idle/working/waiting/connecting/error) is already on the div but unused by CSS.
- Panels use `.glass` with `backdrop-filter: blur(28px)` and a dark veil over the scene; `prefers-reduced-transparency` removes the image.
- Before the photos (commit 8e0d804, 2026-10-04) there was an `AuroraBackground` tinted by agent activity.

## The constraint that decides the technology

`backdrop-filter` re-filters its backdrop on every compositor frame in which the backdrop changed. A live WebGL canvas under the glass makes the blur run at frame rate across most of the viewport: ~3.5 ms GPU per frame measured on a mid-range phone for an 18px blur over one HUD panel (bot-crossing #74), and on macOS Chromium it disables overlay compositing (hercule #301). So whatever generates the room, **at rest the thing under the glass must be a static bitmap**. Live rendering is affordable only as a brief burst (render once, crossfade) or in a small unblurred region.

Other mobile caveats: iOS drops WebGL contexts on backgrounding, caps canvas memory, and lofi.cafe's animated GIF loops burned 40% CPU (its "low energy" mode dropped it to 10–15%).

## Technical options (from the survey)

| Approach | Quality | Personalisation | Effort | Cost at rest | Deterministic |
|---|---|---|---|---|---|
| A. Procedural R3F room, rendered on demand to a bitmap, crossfaded | Stylised | High (layout, palette, props, lamp/screen by agent state) | High | ~0 | Yes |
| B. AI image per room + 5–7 relit variants keyed to sun altitude, served as WebP | Photoreal (continues today's look) | High per room; lighting states fixed at generation | Medium | 0 (same as today) | No (store outputs by hash) |
| C. Gradient/light-field shader or CSS, rendered once per altitude step | Low | Low | Low | ~0 | Yes |
| D. Photo + depth parallax + normal relight | Photo + subtle motion | Medium | Medium | ~0 at rest | Partly |
| E. Gaussian splats (SHARP, Marble) | Photoreal in motion | Medium | Medium | Continuous; 10–30 MB per state | No |
| F. Spline / Unicorn / Rive | Hand-made | None | Low | Loops by default | No |

Recommendation from the survey: A or B as the primary, C as the reduced-motion floor. D only as a pointer flourish outside the glass. Skip E and F. Under 28px blur, parallax is invisible anyway.

Key facts for A: three ~120–185 KB gz; drei `Sky` is Preetham; math.gl just merged `getSunLight(altitude)` (Hosek-Wilkie); `AccumulativeShadows` suits render-once; R3F `frameloop="demand"`; render offscreen, `transferToImageBitmap`, drop the context. WFC is for tiling, not one room; a seeded rule placer over a CC0 kit (Kenney) or code-built primitives is the realistic generator. Version the generator or rooms silently change (Minecraft seed lesson).

Key facts for B: GPT-Image-1.5 $0.009/$0.034/$0.133 per 1024² (low/med/high); Nano Banana Pro $0.134 ≤2K; FLUX.2 pro $0.03/MP. A fixed seed with a changed prompt does not keep the room; use edit-with-reference ("same scene, 7pm, lamp on"), or generate a 2×2 "same room at four times" grid and crop. One base + 5 edits ≈ $0.2–0.8 per room, 30–60 s, so a default set is needed for first sessions. SynthID watermark on Gemini output.

Time of day: macOS Dynamic Desktop uses 16 frames in one HEIC keyed to **sun altitude and azimuth**, not clock hour, with crossfades between neighbours; GNOME uses a clock-based XML slideshow; KDE 6.4 is binary at sunrise/sunset. `suncalc` is 3.9 KB gz; latitude can be approximated from the IANA time zone without a geolocation prompt (cozy-room does this).

## Precedents that matter

- **Pixel Agents** (9.6k stars, 88k installs, MIT, Canvas 2D in a VS Code webview): one character per Claude Code terminal, typing/reading by tool, amber "…" bubble when waiting, Areas mapped to workspace folders, sub-agents as extra characters. Top complaint: the waiting bubble is too easy to miss (#286). Copies: agent-office (hand raised when waiting, empty chair when offline, coffee after 5 idle min), Cursouls, agent-town, pixtuoid (TUI; sun/moon across the skyline, pet sleeps near idle agents), Star-Office-UI for OpenClaw (sofa = idle, desk = working, bug zone = error).
- **agent-virtual-office**: pure SVG + React 19 + Tailwind 4, weather/mood derived from activity, respects `prefers-reduced-motion`. Closest architectural fit for Next.js.
- **Codex pets** (OpenAI, official): a floating companion showing Running / Needs input / Ready / Blocked, ordered needs input > blocked > ready > running. Debate ended at "marginally more productive and way more fun". Claude Code's `/buddy` (Apr 2026) was removed after 8 days and users revolted; attachment is real and fragile.
- **home-lofi + Lofi Cities**: code-drawn scene, per-weather variants, day version between sunrise and sunset, crossfade at matched timestamps, hardware video, "Light" mode. The asset pipeline model for a web app.
- **Focus Friend, Finch, Virtual Cottage, Spirit City**: something lives in the room and reacts to presence; effort accretes into furniture; nothing is taken away (Finch dropped storms/eagles; Forest guilt fades in weeks; GitHub removed streaks; Apple added rest days).
- **Rooms.xyz** (voxel 3D in browser, 1M+ rooms) and **Tiny Glade / Townscaper**: coarse choices by the user, generated detail by the system.
- **Flocus**: a different theme per mode (home/focus/ambient); ambient mode shrinks the UI so the scene matters.
- **Commercial agent tools** (Conductor, Devin, Claude Code agent view/Projects, Codex app, Cursor 3, Zed, Replit): all converge on needs input > ready for review > working > done/idle, ordered by need not time; yellow waiting, animation working, dim idle; unread is a separate dot. None gives a session a persistent place beyond a name and a colour.
- **Virtual offices** (Sococo, Roam, Gather, Tandem): walking avatars were mocked; the durable ideas are the Overview, the knock that leaves a record when it expires, and automatic status. Tandem's post-mortem: people mostly want to be left alone.
- **Vocabulary**: foyer, focus and hearth share one root (the warm room around the fire). Invented words cost trust (HEY's Imbox; Arc Spaces used by 5.5% of users; Discord shows "servers" though the API says guilds); names that say what happens there hold up (Screener, Triage, Logbook).
- **Auto-personalisation lessons**: identicons work because they use a few coarse traits and a curated palette; Linguist language colours lasted because they are stable; commit-count-as-height is gamed and meaningless (Skyline); decoration that carries no information gets called needy; the cozy-games report (Project Horseshoe 2017) says coziness breaks with threat, extrinsic rewards and "lost opportunity" notifications.

## Patterns that make a digital room feel like yours

1. The room keeps your clock (sun altitude, not a toggle) and ideally your weather.
2. Something lives there and reacts to you and to the agent.
3. State you already have drives the visuals; no new toggles.
4. Your effort accretes into the room; nothing decays.
5. Coarse choices by you, generated detail by the system.
6. Each project or session has a recognisable identity; one house style keeps it a single palace.
7. Keep the interesting elements (window, lamp, pet) outside the panel footprint; drive the glass tint from the scene's dominant colour; treat day/night as a slow tint shift so blurred panels never flicker.

## Open questions (asked 2026-10-08)

Look (photoreal vs stylised 3D), unit of identity (project vs session vs worktree), what varies and from what data, whether agent state is shown in the room, sun altitude and weather, lived-in accumulation, motion budget, manual overrides, generation backend and key storage, and whether the Palace rename and vocabulary are in scope now.

## Addendum: the memory-palace metaphor (late report)

- **The Palace (1995)**, Jim Bumgardner / Time Warner, was a graphical chat where every server was a "palace" and every room a backdrop with doors; avatars were dressed with props. PalaceChat is still maintained and a restoration lives at thepalace.app, so "Palace" is a living chat brand. Its rooms were social, not private.
- **Method of loci** needs a fixed, ordered route of familiar places; spatial recall degrades as items grow (Jones & Dumais 1986) and needs stable layouts (Scarr 2013). Sessions are numerous, short-lived and renamed, so Palace should promise a home, not memorisation. Keep names and search first-class (even Muse added them).
- A room's position works as a reminder that something is pending (Malone 1983; Barreau & Nardi 1995), which matches sessions waiting on you.
- Dev tools already using the metaphor: MemPalace (MCP memory server: wings = person/project, rooms = topic, halls, closets, drawers) and mind-palace (archived Feb 2026, "corridors" between projects). Both drop the ordered route.
- **Vocabulary proposal** from the report: Room = session (keep), Wing = project, Study or Hearth = orchestrator home, Foyer = needs-you (keep), Garden = watches, and plain Search and Archive. Fixed system places named by function, user-made containers named by subject; coined words get mocked (HEY's Imbox).

---

# Round 2 (2026-10-08, after Moses's answers)

Decisions from Moses: no AI-generated images; procedural real 3D, subtly animated, cozy like Animal Crossing but not a copy; one room for the whole app (projects and sessions churn too fast); lighting from location; the window shows live weather from IP; the room gains objects from Portal data (robots for active sessions is his example) and must visibly grow with the user; if blur is a problem investigate workarounds, solid panels are an acceptable last resort; rename and vocabulary not this session.

## Blur over a live canvas: verdict

Frosted glass **is viable** over a 24 fps three.js scene on a 2022+ laptop and an iPhone 13-class phone, but not with CSS `backdrop-filter` over the live canvas. Mechanism: Chromium re-reads and re-filters the whole panel pass whenever any damage touches it (`direct_renderer.cc` expands damage to the entire child pass), a WebGL canvas dirties its whole layer every presented frame, and on macOS any backdrop-filter rejects CALayer overlay promotion (`ca_layer_overlay.cc`), so Chromium composites the whole page itself (measured +400 MB GPU process). Safari's CABackdropLayer is the same pipeline as UIVisualEffectView and is invisible to Web Inspector. Blur radius barely matters in Skia (sigma > 4 is downsampled); area, layer count and update rate do. Keeping animation out from under panels does not help in Chromium.

Ranked options that keep the frost:
1. **Frost inside WebGL.** Render the scene to a render target, blur a 1/4–1/8-res copy (dual Kawase or mip `textureLod`), composite rounded panel rects in the same pass from `getBoundingClientRect` (times DPR, Y flipped, SDF corners), refreshed via ResizeObserver and during transitions. DOM panels carry only a tint, no filter. Est. < 0.5 ms laptop, < 1 ms A15 (unverified, measure). References: open-glass PR #6, webgl-apple-liquid-glass, pmndrs/postprocessing `KawaseBlurPass`, three.js transmission mip blur. Limitation: frost shows the scene only, not DOM beneath a dialog.
2. **Hybrid.** WebGL frost for sidebar and panes; CSS backdrop-filter only on small transient dialogs and menus, with the scene paused or at 6–12 fps while they are open.
3. **Snapshot frost.** Blurred low-res copy refreshed every 1–2 s or on state change; ~0 per frame; frost lags motion.
4. CSS backdrop-filter plus heavy throttling (12–15 fps, pause under modals): a stopgap only.
5. Fake frost (tint + noise + gradient) for reduced transparency, Low Power Mode (detect via rAF cadence), low-end GPUs.
6. Solid panels.

Power: WebGL shaders 200–2000 mW on an M1 (Torchbox powermetrics), cost tracks canvas pixels; 30 vs 60 fps roughly halves energy; `powerPreference: 'low-power'`; rAF stops when hidden; iOS caps rAF at 30 fps in Low Power Mode.

## Rendering recipe (from the sub-reports)

- Stay on `WebGLRenderer` (no WebGPU/TSL: Safari 26 only, bigger bundle, R3F v9 async init bugs). `frameloop="never"` with a rAF-driven 24 fps `advance()`, paused on `visibilitychange` and `prefers-reduced-motion`; `dpr={[1, 1.5]}`, `antialias: false`, `powerPreference: 'low-power'`; textures ≤ 2048; lazy-load the Canvas from a `'use client'` wrapper via `next/dynamic` with `ssr: false`.
- Lighting: `suncalc` (1.6 KB gz; note 1.9.0 returns radians, azimuth from south) once a minute; Kelvin→RGB (Tanner Helland) ramp on altitude; one sun `DirectionalLight` + `HemisphereLight`; gradient sky dome (hemisphere-example shader) + drei `Stars` (~1000, toggled by `visible`) + phase-shaded moon sprite; skip drei `Sky` and dynamic `Environment` (PMREM 4.6 ms+). Sun through the window: DirectionalLight shadow (512–1024, tight ortho frustum, `shadow.autoUpdate=false`, `needsUpdate` every 30–60 s) cast by the window frame; SpotLight cookie as an upgrade. Everything that changes the shader cache key (lights, fog, env, maps) mounted at startup and driven by intensity/visibility, so crossfades never recompile.
- Weather: one `Points` shader for rain/snow (300–600 particles behind the window), 4–6 scrolled cloud sprites, `FogExp2` density for grey days, optional low-res low-rate droplet render target for wet glass.
- Animation: plant sway via `onBeforeCompile` on `begin_vertex`, one `InstancedMesh` per plant type; lamp flicker as CPU noise; drei `Sparkles` for dust; hearth as a sprite-sheet flipbook on a quad; robots as 4–6 primitives (`CapsuleGeometry`, `RoundedBoxGeometry`) rendered with drei `Instances` and per-instance colour, hand-written waypoints with lerp (no pathfinding lib). Skip `@react-three/offscreen` (unmaintained, 2023, R3F 8 only).
- Bundle: three ~174 KB gz, R3F 57 KB, drei tree-shaken piecewise (watch for three-stdlib). Meshopt via `gltfpack -cc` (32 KB decoder) rather than Draco for a small kit; one GLB library with `gltf-transform palette` to unify colours; instantiate at runtime.
- Assets (CC0): KayKit Furniture Bits (books, 8 picture frames, rugs, shelves, lamps; best style fit), Kenney Furniture Kit (desk, window, potted plants, bookcases), Quaternius Ultimate House Interior (fireplace), Quin.GS Free Low-Poly Furniture (cozy curved, FBX only). Robots: Quaternius Animated Robot (CC0, 14 anims) or primitives.
- iOS: debounce resize (resize leaks), handle `webglcontextlost` by pausing and showing a still, StrictMode double-mount can lose the context in dev.

## Location and weather

- **Weather: Open-Meteo.** Keyless, HTTPS, CORS `*`, non-commercial < 10k/day; `current=temperature_2m,is_day,weather_code,cloud_cover,precipitation,rain,showers,snowfall&timezone=auto`; WMO codes (0 clear, 1–3 cloud, 45/48 fog, 51–57 drizzle, 61–67 rain, 71–77 snow, 80–86 showers, 95–99 thunder); CC BY 4.0, link "Weather data by Open-Meteo.com". No IP lookup. Fallback: MET Norway (keyless, forecast only, mandatory User-Agent, honour Expires, ≤4 decimals). wttr.in is single-maintainer with 2026 outages. OpenWeatherMap free refreshes only every 2 h.
- **Location: get.geojs.io** (`https://get.geojs.io/v1/ip/geo.json`, keyless, HTTPS, CORS, lat/lon as strings, timezone; hobby project, "no rate limits (yet)") with **ipwho.is** (1,000/day, commercial OK) and freeipapi.com as fallbacks. ip-api.com free is HTTP-only; ipinfo Lite is country-only now. Over Tailscale the client arrives from 100.x, so the **server** must look up its own public IP (api.ipify.org / icanhazip.com) and geolocate that; cache on the server and poll every 15–30 min so many tabs don't multiply calls. Zero-network fallback: latitude from the IANA time zone; opt-in precise: browser Geolocation.
- Moon phase from `suncalc.getMoonIllumination`.

## Look, procedural layout, composition (final rendering report)

- **What makes the ACNH read in three.js** is mostly not a toon shader: rounded low-poly geometry with bevels, matte flat-colour `MeshStandardMaterial` (roughness ~0.95, metalness 0, low variance across objects), one warm key plus a cool bright fill so nothing goes black, soft wide shadows, baked AO in corners, and a low-contrast tone mapper (**AgX** or Neutral, exposure ~1.1; ACES skews pastels). Outlines optional; most cozy-room examples skip them. Vertex colours or a 16×16 palette atlas let the kit share one material per instanced group. `MeshToonMaterial` needs a 3–5 step gradient with `NearestFilter` and bands shadows; use only for a cel look.
- Shadows: `PCFSoftShadowMap`, 1024 map (512 on phones), tight frustum, `shadowMap.autoUpdate=false` and `needsUpdate` on sun/robot moves. drei `SoftShadows` (PCSS) must mount at start (late mount recompiles everything). `AccumulativeShadows` is zero-cost once accumulated but re-bakes on any child change and is floor-only, so limit it to the static shell and give robots a blob-sprite shadow. AO: baked vertex AO over N8AO (~1 ms+). No bloom; fake the hearth glow with an emissive sprite + a shadowless `PointLight`. Fog is near-free. LUT grading via pmndrs/postprocessing `LUT3DEffect` costs a full-screen pass; alternatively bake the grade into the palette.
- Example projects: brunosimon/my-room-in-3d (4.5k, baked day/night/neutral lightmap blend), itsLucas02/3d-room (documents that blend shader), Hostlife22/sunday-space (R3F room built from primitives, MIT, reduced-motion), Aubrey-Li/cozy-room (sun by clock+location, moon phase, foliage wind, books sorted by colour), iivvaannxx/my-room, houssemlachtar/My-3D-Room, IsaLewent/Mia-RoomFolio, AndyLow14/Tiny-Room, magnuswahlstrand/demo-threejs-fiber-rooms (Kenney kit in R3F), mayacoda/toon-shader, jasonsturges/three-low-poly (parametric low-poly geometry, ISC), majidmanzarpour/threejs-procedural-dungeon (508, best reference for one seeded stream + InstancedMesh dressing). Nothing credibly reproduces ACNH interiors; sunday-space and cozy-room are the closest in spirit (both brand new, reference only).
- **Procedural assembly**: no JS library does slot-based interiors; hand-write ~200 lines. Fixed authored shell (floor, back wall with window, left wall, rug) → authored anchors (desk under window, shelf on left wall, sill, hearth back-right, wall slots, floor slots) → each furniture piece declares its own slots (rows × capacity × kind × pitch). Growth is an ordered fill, not a search: `slotIndex = hash(itemId) mod capacity`, walk to the next free slot on collision; gaps are fine. Per-item variation from `hash(layoutVersion, itemId)`, global layout from `hash(layoutVersion, roomId)`; never draw from a shared stream in arrival order or adding one book reshuffles the shelf. Persist seed + version, never resolved positions; keep old generators callable. PRNG: inline mulberry32 + cyrb53 (32-bit integer math only, deterministic across engines). Prior art: Tutenel et al. rule-based layout solving, FittingPlacer, Lidberg & Borgshammar hierarchical decoration.
- **Camera/composition**: ACNH interiors are front-on with the fourth wall missing, pitched ~25–35°, long lens, pan not orbit; the back wall carries most of the "stuff". Recommend a three-quarter diorama (yaw 20–30°, pitch ~25°, FOV 25–35°, camera far), fixed with an optional 1–2° slow drift and tiny mouse parallax (off under reduced motion). Window back-wall centre-left, shelf left wall, hearth back-right, desk under window, robots low-centre. Use `camera.setViewOffset` driven by the live UI layout (sidebar, right panel, chat column) to shift the scene centre into the uncovered region, re-called on layout change only; aspect breakpoints, not width. Portrait phones: crop, don't re-layout: pull back and raise the camera, make the back wall the hero, DPR 1.5, half shadow map.
- **Cost estimate** (M1, 1440×900 @ DPR 1.5, ~60 draw calls, ~80k tris, estimates not measurements): shadow pass 0.3–0.6 amortised ≈ 0; main pass 1.0–1.8; weather 0.1–0.3; hearth + dust 0.1; MSAA resolve 0.3–0.5; optional LUT 0.4–0.8 → **~2–3.5 ms** without post. iPhone 13 roughly 2× the main pass; DPR 1 and no post keeps it inside a 24 fps frame. Plus the WebGL frost pass from the blur report.
- **Five biggest risks**: (1) shader recompiles on data change (fixed light count, mount everything at start, `gl.compile()` pre-warm); (2) AccumulativeShadows re-baking as the room grows; (3) procedural AO without Blender bakes (vertex AO heuristics on the shell, baked AO in prop vertex colours); (4) layout drift from shared-stream seeding (per-item hash seeding, snapshot test over ~200 seeds); (5) UI occlusion and portrait framing (margins-first composition, `setViewOffset`, crop not re-layout). Secondary: reduced motion and hidden tabs must stop the capped loop, the weather particles and the shadow refresh.
