# Glass shell: floating panels, liquid glass, Palace mode, warm accents

Date: 2026-10-15. Status: **built and merged to main 2026-10-15** (see As built at the end). Branch `glass-shell`.

Four changes to the shell around the workspace:

1. The left sidebar, the centre (tab strip and panes) and the GitHub inspector become **floating rounded panels** inset from the window, with the room showing in the gaps.
2. The sidebar and inspector get **liquid glass**: the room bent at their rims and a highlight lit from the room's sun, drawn inside the room's existing WebGL frost pass.
3. **Palace mode** replaces the Palace page. The logo, or Esc on desktop, slides both sidebars out and fades the centre away, leaving the room. The logo, pinned top left, or Esc again brings everything back. `/` opens the new-session start page instead of Palace.
4. The cool slate-indigo **user bubble** and every other indigo or violet accent move to the warm cream palette.

Research behind it: an online survey of web "liquid glass" techniques (2026-10-15, summarised under Liquid glass → Why in WebGL) and the existing Frost design in `docs/PALACE.md`.

## Decisions on record

| # | Topic | Decision | Whose call |
|---|---|---|---|
| 1 | Panel layout | Sidebar, centre and inspector float: inset from the window edges, rounded corners, a gap between them. | Moses |
| 2 | Right panel | The right panel is the GitHub inspector. | Moses |
| 3 | Phones and narrow screens | The sidebar sheet and the GitHub sheet float and are glass too. | Moses |
| 4 | Glass strength | Subtle: lensing at the rim and a highlight, not visible bending across the panel. | Moses |
| 5 | Tint | Lower the panel tint so more of the room shows; some contrast loss accepted. | Moses |
| 6 | Highlight | Lit from the room's sun (the moon at night), fixed otherwise. No pointer tracking. | Moses |
| 7 | Esc | Enters and leaves Palace mode on desktop only. It never fires from a dialog, menu, overlay or terminal, nor from a text field that has text in it. | Moses |
| 8 | Entering Palace mode | The logo button enters it. The Palace entry in the sidebar's Portal nav goes away. | Moses |
| 9 | Leaving Palace mode | The logo stays pinned top left while everything else leaves; clicking it, or Esc on desktop, comes back. | Moses |
| 10 | Phones | Tapping the logo in the sheet closes the sheet, then the workspace fades. Same animation, without the sidebar slide. | Moses |
| 11 | Home | `/` opens the new-session start page with no project and no worktree picked. | Moses |
| 12 | Sidebar collapse | The collapse button animates the sidebar out and in too. | Moses |
| 13 | Bubble colour | Warm cream tint at low opacity, from the `--primary` family. | Moses |
| 14 | Recolour scope | Every indigo, violet and cool-blue accent, not only the bubble. The status colours (green, amber, red, blue) stay. | Moses |
| 15 | Where the glass is drawn | Inside the room's WebGL frost pass, not with CSS `backdrop-filter` or SVG filters. | mine |
| 16 | Centre panel material | A rounded clip with a hairline border and no frost: the chat shows over the veiled room as it does today. | mine; **review** |
| 17 | Phone centre | On phones (under 768 px) the centre stays full-bleed; only the sheets float. | mine; **review** |
| 18 | State colours that are violet | The violet "background" session state and GitHub's purple "merged" badge keep their hue (they are status, not accent). | mine; **review** |

## 1. Floating panels

### Geometry (desktop and tablet, 768 px and up)

- `.portal-shell` gets `padding: 10px` and `gap: 10px`. The three panels sit in it as today's flex children.
- Each panel gets `border-radius: 18px` and a 1 px border, `#eee1ca1f`. The sidebar's `border-right` and the inspector's `border-l` go away.
- **Sidebar**: width as today (240–400 px, stored). It loses `.sidebar-shell`'s border. The resize handle stays on its right edge, inside the gap.
- **Centre**: `div.relative.flex-1` becomes the card. `overflow: hidden` clips the tab strip, panes and page overlays to the radius. Page overlays (`[data-page-overlay]`) fill the card, not the window, which is what they do already since they live in it.
- **Inspector**: 340 px as today; it moves out of `[data-workspace-layer]` to be the shell's third child, so it is its own floating panel instead of part of the centre. It still shows only at 1280 px and up.
- Corner and edge effects: panes, terminal panels and the tab strip already sit inside the centre. Nothing inside needs its own radius except the first and last tabs, which the clip handles.

### Centre material (decision 16, for review)

The centre is **not** frosted. If it were, the room would show only in the 10 px gaps and when Palace mode is on. The card keeps today's look inside: the chat over the veiled room, now bounded by a rounded border. Its tab strip keeps its `bg-black/25` tabs.

Alternative if you want the centre to read as a panel too: frost it with no lensing (blurred room behind the chat). That costs more of the room and one large mask rectangle.

### Phones (under 768 px)

- The centre stays full-bleed (decision 17): 10 px margins on a 390 px phone cost too much width for chat and terminals.
- **Sidebar sheet**: `SheetContent` inset 8 px from the top, left and bottom, `border-radius: 22px`, glass instead of `bg-popover`. Its overlay keeps the dim (`#0007`) and **drops the CSS blur**: the glass now does the blur inside WebGL, and a full-screen CSS blur over the canvas is what the frost was built to avoid.
- **GitHub sheet** (under 1280 px): the same, inset on the right.

### Sidebar collapse (decision 12)

Today the closed sidebar returns `null`. Instead it stays mounted while it animates.

- **Collapse**: a wrapper animates its width from the sidebar's width (plus the gap) to 0 over 220 ms (`cubic-bezier(.2,.8,.2,1)`). The sidebar inside slides left (`transform`) at the same time and fades. After `transitionend` it unmounts, which keeps inactive React work out of the tree as today.
- **Expand**: the reverse.
- The centre reflows during those 220 ms (it has to: it is getting wider). Terminals already fit on resize. Their resize is debounced to the end of the transition so the PTY isn't resized a dozen times.
- Reduced motion: no transition.

## 2. Liquid glass

### Why in WebGL (decision 15)

What the research found (October 2026):

- **CSS `backdrop-filter: blur()`** works everywhere but has no lensing. It re-blurs the area every frame when anything underneath moves, which is why the panels left it for the WebGL frost.
- **SVG displacement refraction** (`backdrop-filter: url(#filter)` with `feDisplacementMap`, the kube.io technique used by liquid-glass-react, shuding/liquid-glass, samasante/liquid-glass, liquid-glass-js) only renders in Chromium. WebKit drops it silently (bug 245510), and `@supports` reports support anyway.
- **Libraries that work everywhere** (liquidGL, @specy/liquid-glass) refract a snapshot of the page. The snapshot goes stale, and liquidGL documents Safari instability once glass covers more than half the viewport.

None of that is needed here. The floating panels sit beside the centre, not over it, so the only thing behind the sidebar and the inspector is the room. The room is already a WebGL frame, and the frost pass already blurs it under every `.frost` element each frame. Adding refraction there:
- works in Safari, Chrome and Firefox the same way;
- adds no CSS filter;
- follows a sliding panel, because the registry reads every panel's box each frame;
- costs one small extra draw and a few texture taps on rim pixels only.

### Which panels

A new class, `.liquid`, used alongside `.frost` or `.frost-subtle`, marks a panel as liquid glass:
- the desktop sidebar;
- the inspector;
- the two sheets;
- the Palace-mode logo button.

Other frosted elements (composer, cards, "thinking" spans) stay plain frost.

### Look

- **Bevel**: a band 18 CSS px wide inside each liquid panel's edge, shaped as a convex squircle (kube.io's profile). The room seen through it is pulled outward towards the edge by up to 8 CSS px at the very rim, falling to 0 at the inner edge of the band. That is the subtle setting (decision 4); one constant tunes it.
- **Fringe**: in the band only, the red and blue channels are offset ±1.5 px further along the same direction. It is just visible on bright window light, invisible on the wall.
- **Interior**: the frost as today, unchanged.
- **Highlight**: a thin rim light, about 1.5 CSS px, strongest on the edge that faces the sun and falling off as `max(0, dot(edgeNormal, sunDirection))^2`. It is warm white by day, a dim cool white from the moon, and scaled by the light's intensity and by the weather (`sunThrough`), so it nearly goes on an overcast night.
- **Tint** (decision 5): liquid panels drop from about 79% (`#25231fc9`) to about 50% (`#25231f80`), tuned live against text contrast. The sidebar's text keeps 4.5:1 against the darkest frame. If it doesn't, the tint goes back up; it doesn't get a text shadow.
- **DOM rim**: a 1 px gradient border (lighter at the top, `#ffffff1f` → `#ffffff08`) and the existing inset top highlight, so the edge reads even without WebGL.

### Sun direction on screen

`Sun.tsx` already works out the light's direction in room space (`directionFrom(altitude, azimuth)`, the moon below the horizon). The frost pass gets it each frame from a small shared ref that `Sun` writes; `Sun` doesn't render more often for it. The pass:
- projects it through the camera's view matrix to a 2D screen direction;
- passes that plus a strength (the key light's intensity, normalised) to the composite as uniforms.

The camera is fixed (Revisions 3 and 4), so the direction only changes with the sun, roughly once a minute.

### Pipeline changes (`room/frost/`)

- **registry.ts**:
  - `FROST_SELECTOR` stays.
  - Each panel's instance gets one more float, `liquid` (0 or 1), so `FLOATS_PER_PANEL` becomes 10. It is read with the radius and refreshed by the same observers; the class is already watched.
  - Liquid panels skip the clip cut: a sliding panel must keep its rim while partly off-screen, and the canvas cut still applies.
- **A lens target**: a half-size RGBA8 target written by a second instanced draw of the liquid panels only, with normal blending. Liquid panels don't overlap each other, and plain frost nested inside one (a card inside the sidebar) never writes it.
  - R/G: the outward displacement direction (the SDF gradient), encoded 0.5-centred.
  - B: the bevel's lens amount, 0..1.
  - A: rim highlight coverage.
  - It is cleared once and left empty when no liquid panel is on screen. Without a liquid panel the composite skips the lens taps.
- **The composite**:
  - Where B is above 0, it samples the blurred copy at `uv + direction × amount × maxShift`. Red and blue are sampled with the fringe offset, so the band adds three bilinear taps of the eighth-size texture instead of a full Kawase upsample.
  - It then adds `highlight × A × max(0, dot(direction, sun))²`.
  - Pixels outside any panel take today's early return.
- **Loop**:
  - `loop.ts` gains a motion boost like the scroll boost: 60 fps for as long as `[data-room-motion]` is on the page, plus 100 ms.
  - The sidebar, inspector and sheet animations set it on the shell while they run, so the glass under a sliding panel keeps up instead of stepping at 24 fps.

### Fallbacks

- **Without WebGL, after a lost context, or with the sketch**: the panels show the tint and the DOM rim over the sketch, as frost panels do today.
- **Reduced transparency**: solid `--card` panels and no frost or lens. The existing rule extends to `.liquid`. Safari doesn't support the media query; `docs/PALACE.md` already accepts that.
- **Reduced motion**: the room renders one still frame a minute. The glass is drawn in that frame like everything else.

### Budget

Measured the way the frost was, on this Mac in Chrome and Safari, and on a phone if one is to hand. The added cost should be under 0.3 ms GPU per frame at 1440 × 900. The recorded numbers go in As built. If the fringe taps blow the budget, the fringe goes first.

## 3. Palace mode

### State

- `PageSurface` loses `{ view: "palace" }`, and `PortalView` loses `"palace"`. `viewMeta.palace`, the entry in `sidebarViews`, the Castle icon import, `surfaceOverPalace` and the Palace header with its sidebar toggle all go.
- `ChatShell` gains `palace: boolean`. It isn't stored and isn't in the URL; a reload starts out of it.
- Entering closes the mobile sheet, the Agent and Search dialogs if open, and any page overlay. Leaving shows the workspace as it was. The workspace stays mounted the whole time, as it does under the Palace page today.
- `RoomBackground` still gets `palace`, so the veil goes and a clicked robot waves first. Room objects stay clickable; a click that navigates (a robot's session, a book) leaves Palace mode on the way.

### Entering and leaving

- **Logo button** (`Sidebar.tsx`, "Portal home"): toggles Palace mode. Its label becomes "Show the room". Because it slides out with the sidebar, a separate button takes its place (next item).
- **Pinned logo**: while Palace mode is on, a small liquid-glass button, `PortalMark` only (36 px, radius 12), sits fixed where the sidebar's logo was: top left, inside the shell padding. When the sidebar is collapsed or on a phone, it sits at the same corner.
  - It fades in over the last 120 ms of the exit animation and is the only focusable thing outside the room.
  - Its label is "Back to workspace".
  - Clicking it, or Esc, leaves.
  - Focus goes to it on entering, and back to whatever had it before on leaving.
- **Esc** (desktop, 768 px and up), one document `keydown` listener in the bubble phase, after every other handler. It ignores the event when:
  - `defaultPrevented` is set (the composer's slash menu, rename fields, Radix, drag cancel and the Approvals dialog already set it; the build audits each of them);
  - a dialog, alert dialog, menu, listbox or popover is open (`[data-state=open]` on those roles);
  - a page overlay is open; its own Esc closes it first, so a second Esc enters Palace mode;
  - the target is inside `.xterm` or `[data-terminal]`;
  - the target is an `input`, `textarea` or `contenteditable` holding any text; an empty composer counts as empty;
  - a modifier is held, or it is a key repeat.

  Otherwise it toggles Palace mode and calls `preventDefault`.
- On phones there is no Esc; the logo in the sheet enters and the pinned logo leaves.

### Animation

All of it uses `transform` and `opacity` on desktop, so nothing reflows and the centre keeps its layout under the fade. Durations:

| Element | Out (entering Palace) | In (leaving) |
|---|---|---|
| Sidebar | `translateX(calc(-100% - 10px))`, 320 ms, ease-in-out | reverse, 320 ms |
| Inspector | `translateX(calc(100% + 10px))`, 320 ms | reverse, 320 ms |
| Centre | `opacity` 1 → 0 and `scale(.985)`, 240 ms, starting 40 ms in | reverse, 240 ms, from 80 ms |
| Veil | fades out over 320 ms (a `transition` on the `::after` background) | fades in over 320 ms |
| Pinned logo | in over the last 120 ms | out over the first 80 ms |

- `[data-room-motion]` is on the shell from start to end, so the glass follows at 60 fps.
- After the out animation, the sidebar, inspector and centre get `inert` and `visibility: hidden`. The frost registry already skips invisible elements, so they cost the frame nothing.
- **Phones**: the sheet closes with its own slide, then the centre fades (240 ms), then the pinned logo fades in.
- **Reduced motion**: crossfades only, 120 ms, no transforms.

### Home (decision 11)

- `workspaceRoute("/")` returns `{ kind: "start" }`, so `/` shows the start page with no project or worktree picked. The URL stays `/`.
- Back and Forward no longer produce a Palace surface.
- Older stored Agent replies and item bodies can link to `/` or `/palace`; `isSurfaceLinkPath` accepts both. Those links now enter Palace mode, so they keep working.
- The route page's metadata title becomes "Portal".
- `docs/PALACE.md` gets a note at the top: the Palace page became Palace mode (this doc).

## 4. Warm accents

### Tokens

New `:root` tokens in `globals.css`, so the hex values stop being scattered:

| Token | Value | Use |
|---|---|---|
| `--bubble` | `#e8d7b917` (cream, ~9%) | user bubble background |
| `--bubble-border` | `#e8d7b91f` | user bubble border |
| `--accent-soft` | `#e8d7b90d` | active sidebar row, hover fills |
| `--accent-line` | `#dec49840` | focus rings, focused pane ring, separator hover, composer focus |
| `--link` | `#e6c792` | markdown links (underlined, so not colour alone) |

### Replacements (about 42 places)

- **User bubble**: `!bg-[#252b3e]/70 !border-white/5` → `--bubble` and `--bubble-border`, in `Conversation.tsx` and `PortalMessage.tsx`. Text stays `--foreground`.
- **Send button**: `#e4e8f5` / `#232a3f` → `--primary` / `--primary-foreground`.
- **Active sidebar row**: `#c3cfff0b` / `#c3cfff12` → `--accent-soft` / `--accent-line`.
- **Composer focus**: `#b1c0ff38` / `#b1c0ff04` → `--accent-line` / `--accent-soft`.
- **Working orb**: `#dfe4ff → #8f9cf0 → #6b6fd8`, glow `#9aa4f088`, ring `#a8b6f6` → `#fff4e0 → #e8c890 → #c6935a`, glow `#e8c89088`, ring `#ecd3a6`.
- **Markdown**: body `#d7dce7` → `#ece4d6`, links `#b8c7f5` → `--link`, blockquote border `#93a1ce55` → `#dec49855`.
- **Tailwind `indigo-*`**: rename inputs, Picker, split separator and focused-pane ring, terminal tabs and buttons (`bg-indigo-600` → `bg-primary text-primary-foreground`), the spinner, and the GitHub panel's accents. Each maps to `--accent-line`, `--accent-soft`, `--primary` or `text-primary`, whichever matches its role.
- **xterm cursor**: `#a5b4fc` → `#e8d7b9`.
- **Kept** (decision 18): the status colours (working green, waiting amber, error red, connecting blue, hung orange), the violet "background" state dot and badge, and GitHub's purple "merged" badge.

The `tinted` variant of `ui/bubble.tsx` already derives from `--primary` and is unchanged.

## Tests

- **Unit**:
  - `workspaceRoute("/")` returns the start route.
  - A stored `/` or `/palace` link enters Palace mode.
  - The Esc predicate as a pure function over a key event and the document's state: each skip rule, the empty composer, and desktop only.
  - Registry: the `liquid` float and the clip rule for liquid panels.
  - Loop: the motion boost's fps and its tail.
- **UI (Playwright, mocked API)**:
  - Panels float: the sidebar's box is 10 px from the window edges and it has a radius.
  - The logo enters Palace mode: the sidebar and centre become hidden and inert, and the pinned logo is focused. The pinned logo leaves and returns focus.
  - Esc enters and leaves. Esc in a terminal, in a composer with text, with a menu open, or with the Agent dialog open does not.
  - With a page overlay open, the first Esc closes it and a second enters.
  - The Palace entry is gone from the sidebar nav. `/` shows the start page.
  - Sidebar collapse and expand end in the right state, and reduced motion takes no time.
  - Phone viewport: the sheet is inset and rounded, the logo in the sheet enters Palace mode, and the pinned logo leaves.
  - The user bubble's computed background is the cream token, and no `rgb` value in the indigo range remains on the session page (a sweep over computed colours).
- **Existing tests touched**: the Palace page and Palace route tests (rewritten for Palace mode), and the frost count test (`data-frost` counts change because the inspector is now its own panel).
- **Live look**: screenshots by day and night (forced clocks) of the session page, Palace mode mid-animation, and the phone sheet; GPU timings in Chrome and Safari before and after.

## Implementation order

1. Warm accents: tokens and replacements. Independent and quick to review by eye.
2. Floating geometry: shell padding and gap, radii, the inspector moved out of the workspace layer, the phone sheets.
3. Sidebar collapse animation and the loop's motion boost.
4. Palace mode: state, pinned logo, Esc, animation, home route, Palace page removal, docs/PALACE.md note.
5. Liquid glass: registry flag, lens target and draw, composite, sun uniform, tint, DOM rim; then measure.
6. Tests throughout; a review pass by fresh agents; live look on a scratch instance.

Each step is its own commit on `glass-shell`.

## Out of scope

- A light theme.
- Pointer-driven highlights or tilt.
- Glass over DOM content. No liquid panel sits over the centre; transient dialogs keep `.glass`.
- Renaming Portal to Palace.

## For review

Decisions 16 (centre not frosted), 17 (phone centre full-bleed) and 18 (violet state colours kept) are my calls. All the other values (10 px gap, 18 px radius, 50% tint, 8 px lens, the durations, the warm hex values) are starting points to tune live.

## As built

Built 2026-10-15 by subagents in the order above, then reviewed by two fresh agents (WebGL pipeline; shell, Palace mode and accents) whose findings were all fixed (34dabef, 2f2536b). Deviations from the text above:

- **Glass**
  - The lens target is cleared with alpha 1. Its alpha holds the signed edge distance, because three premultiplies the clear colour.
  - The rim highlight is computed at full resolution in the composite, not in the lens target.
  - Displacement follows the squircle's slope: 8 px at the rim, about 3 px at 5 px in, 0 at 18 px. It is added to the blurred interior as a difference, so there is no seam.
  - Each panel carries an effective opacity (its own times its ancestors'), which scales the mask, lens and rim. A panel inside a fading centre therefore fades with it. The instance buffer holds 11 floats per panel.
  - The lens draw uses no blending plus a discard outside the shape. Liquid panels must not overlap.
  - Under reduced motion the still frame redraws when `data-room-motion` changes or when the panels move or fade (checked every 250 ms).
- **Motion**
  - `data-room-motion` is held on `<html>` through counted holds in `lib/room-motion.ts`. Each hold is released automatically after 2 s.
  - Radix sheet fades hold it too, and an `animationcancel` releases it.
- **Panels**
  - The phone sheets are tinted at about 85%, not 50%, because they sit over chat text.
  - Liquid panels draw their rim inside the edge instead of using a border.
  - The pinned logo only becomes liquid once the sidebar has gone.
- **Palace mode**
  - The shell attribute is `data-palace-mode`; `data-palace` was taken.
  - The Esc rule (`palaceEscapeToggles`, `lib/palace-mode.ts`) reads what was open at key-down. It also skips during a dnd-kit drag (`data-dragging`), during IME composition, and while a room hover card is shown. Only text-like inputs block it.
  - Focus returns to the control that entered Palace mode. Failing that, it goes to the sidebar's room button, then the focused pane's composer.
  - Changes to the sidebar before hydration are instant, so a stored-collapsed sidebar doesn't slide out on load.
- **Home**
  - `/` is a resolver path like `/new`. With tabs open it focuses or opens a start tab and rewrites the URL, rather than staying `/`.
  - The Agent main thread's internal link is now `/threads/main`, so `/` can mean Palace mode in stored links.
- **Accents**
  - The sky spinners and dots, the non-status violet badges (a new `warm` badge tone) and the navy code and tool backgrounds also went warm.
  - Status tones stay (the sky Running/Active badges, the violet Merged badge, the violet background state).
  - The focused-pane ring is `ring-ring/60`.
  - Keyboard focus rings use `ring-ring`.
  - The highlight.js theme is unchanged.
- **Not done**
  - GPU timings in Chrome and Safari.
  - A real-phone look.
  - The glass trails the DOM by about a frame during slides, visible in a still capture.
