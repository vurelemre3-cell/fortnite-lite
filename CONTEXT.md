# fortnite-lite — CONTEXT

A stripped-down but playable Fortnite: battle bus drop, loot, grid building,
shrinking storm, 24 players, last one standing. Zero dependencies, custom WebGL2
renderer with shadows and skinned characters, CC0 KayKit models, ~5000 lines.

## Run

```bash
cd fortnite-lite && node server.js      # → http://localhost:3500
```

Models are fetched over http, so `file://` shows the procedural fallbacks only.
`server.js` resolves its root from `__dirname`; start it from the project folder.
Port 3500 stays clear of WGR-WEBAPP (3000), InvestmentTracker (3100),
nblc-invoicing (3200), louiE (3300), livesite (3400). `PORT=3501 node server.js`
runs a second copy (the dev harness uses one).

## File structure

| File | Contents |
| --- | --- |
| `index.html` | Canvas layers (`#gl` WebGL, `#hud` 2D), menu + end screens, control lists |
| `engine.js` | mat4 math, geometry builders, the WebGL2 renderer (sky, shadow map, instanced meshes, textured materials, glTF props, skinned characters, terrain), keyboard+mouse+gamepad input, WebAudio SFX |
| `models.js` | glTF 2.0 / GLB loader (static props and skinned characters with clips) + the `Assets` registry |
| `anim.js` | Skeletal animation: clip sampling, cross-fades, upper-body mask layer, joint palettes |
| `textures.js` | Procedural textures painted on canvases at boot: wood / brick / metal, grass / rock / dirt, noise, item skins |
| `world.js` | Absolute build grid + structural support, colliders + spatial hash, collision, raycasting, terrain + roads + splat map, themed POI generation, props, loot |
| `game.js` | Match flow, player, bots, combat, placement, character animation state, HUD, screenshot mode |
| `server.js` | Zero-dep static server with live reload |
| `assets/` | 80 CC0 KayKit `.glb` files — see `assets/README.md` |
| `dev/` | Headless test suite, GL smoke test, asset download / packing tools — see `dev/README.md` |

## Rendering

Every frame is drawn twice: once into a 2048² directional **shadow map**
(orthographic, 124 m box ahead of the camera, texel-snapped so edges don't
crawl, 3×3 PCF through a `sampler2DShadow`), then to the screen under a
**sky dome** (full-screen triangle: horizon→zenith gradient, sun disc + glow,
two layers of drifting fbm clouds from a tileable noise texture). One warm sun
with hemispheric ambient (sky above, ground bounce below), a small Blinn
highlight, and distance fog to the horizon colour.

Seven programs, all sharing one lit fragment shader (`FS_LIT_HEAD`):

- **Instanced procedural meshes** (cube, ramp deck, pyramid, cylinder, sphere,
  tube): a per-instance mat4 + rgba, one `drawArraysInstanced` per mesh entry
  per pass. `alpha < 1` routes an instance to the transparent bucket, drawn
  unlit after the opaque pass with depth writes off (storm, build ghost, beams).
- **Textured material entries** (`R.addTextured(base, tex, scale, spec)`): the
  same geometry wearing a tiled texture through *triplanar* world-space
  mapping, so bricks line up across neighbouring walls with no UV plumbing.
  Wood / brick / metal build pieces, ammo box, medkit, the bus.
- **glTF props** (`R.pushModel`): one part per material, instanced; base placed
  by footprint centre and height, per-instance tint multiplies the texture
  (`COL_FLASH_TEX` > 1 for the hit flash).
- **Skinned characters** (`R.pushSkinned(model, xf, joints, tint)`): one
  non-instanced draw per part, joint palette as a `mat4[64]` uniform.
- **Terrain**: one smooth-normal mesh; the shader blends grass (two tiling
  scales + macro hue noise + height tint), dirt from the per-match **splat map**
  (roads, plazas, bare patches) and rock on steep slopes.
- Depth-only variants of the instanced and skinned vertex shaders for the
  shadow pass.

`inView()` is the frustum cull every scene loop runs — a horizontal wedge from
the yaw and live FOV, pitch ignored on purpose. Instance buffers are sized once
and refilled with `bufferSubData`; the opaque buckets are uploaded once and drawn
by both passes. Face culling is off, so winding never matters — only normals do.
`push()` skips the trig when `rotY === rotX === 0`.

Draw calls: ~150–250 at a busy POI, plus the same again in the shadow pass.

## Loaded models

`models.js` parses `.glb` / `.gltf` into flat CPU buffers (`Assets.load`,
`Assets.get(name)` → model or `null` until it lands). A file with a skin becomes
a **character**: the node hierarchy is kept, every vertex is bound to palette
slots (the skin's joints plus one slot per rigid mesh such as a helmet parented
to the head), and each animation becomes a clip of `{node, path, times, vals}`
channels. `opts.skipNodes` drops subtrees (the pack's own swords and shields).
The rest of a file is baked into static parts merged by material.

`MANIFEST` in game.js lists everything (built from `PROP_DEF`); `FN.assets()`
reports what loaded, `FN.reload(name)` re-fetches one. Not supported: Draco /
meshopt / basisu compression (reported), sparse accessors, morph targets.

## Characters

Player = KayKit Knight; bots pick one of five skins. Drawn 2.05 m tall
(`CHAR_HEIGHT`; the collider stays `ENT_H` = 1.85). KayKit characters face +Z
and the game faces −Z, hence `CHAR_YAW = π`.

`updateAnim()` picks the base clip from what the entity is doing — Idle,
Walking_A / Walking_Backwards, Running_A, Running_Strafe_Left/Right, Jump_Start
/ Jump_Idle, Death_A (one-shot, held at the last frame), Cheer on a win — and
`drawChar()` layers the **upper body** on top through a node mask (the `spine`
subtree): the 2H / 1H `Ranged_Aiming` pose while a gun is held, or a one-shot
started with `playUpper()` — `Ranged_Shoot`, `Ranged_Reload`,
`1H_Melee_Attack_Chop` (pickaxe), `Use_Item`, `Interact` (build / chest),
`PickUp`, `Throw`, `Hit_A`. The chest and head are then bent toward the aim
pitch (`PITCH_K`). Cross-fades are 0.12 s.

The held weapon is anchored at the `handslot.r` node but **oriented by the
aim** (yaw + pitch) rather than the hand bone, because the pack's aiming poses
hold weapons angled across the body; `GUN_GRIP` says where the hand sits in gun
space. Guns are procedural assemblies of cubes and tubes (`GUN_MODEL`) with the
rarity colour on their accents — pistol, SMG, AR, pump, bolt sniper, pickaxe —
drawn the same way on the ground, in hand and in first person.

## Terrain

A heightfield (three summed sine ridges, ±~20 m) flattened toward each POI
**plateau** in `World.pads`; plateau heights snap to whole storeys so the build
grid is level where people fight. `terrainHeight(x, z)` is the ground everywhere;
`tileGround(gx, gz)` memoises the lowest/highest ground in a tile for the
support rule. `rayTerrain()` (coarse march + binary refine) is wired into
`rayWorld`, so hills block bullets, bot sight lines and the third-person camera.

`buildSplat()` paints a 512² map per match: roads (a ring through the outer
POIs plus spokes to the centre, each with a small bend), worn plazas at towns and
the space base, scattered bare patches. The minimap is painted from the same
heightfield and roads once per match.

## World model

- **Grid**: tile = `GRID` (4) on XZ, storey = `LEV` (4) on Y, map ±`HALF` (340).
  The grid is **absolute**: storey `gy` has its floor at exactly `gy*LEV`
  everywhere, so neighbouring pieces always line up — floors meet flush, a
  ramp's top edge lands on the storey above. On a hillside a ground piece sinks
  partway into the slope, as in Fortnite. `gy` may be negative (valleys).
- **Pieces**: `wall | floor | ramp | cone`, keyed by `pieceKey`. Walls are
  stored canonically (`normalizeWall` folds rot 1→3, 2→0 of the neighbour) so
  two players can't stack two walls on one edge. Cones are `CONE_H` (2.2 m)
  tall — about half a storey, like Fortnite's roof piece.
- **Structural support** (`pieceKeys`, `hasSupport`, `updateSupport`): every
  piece owns *contact keys* — the grid edges its corners run along, plus a face
  key for walls that a ramp can lean on. Two pieces sharing a key are connected.
  A piece is **grounded** when its base sits at or just above the highest
  ground in its tile, or partly buried in a slope (`grounded()`). Placement
  needs the piece grounded or touching an existing piece; after any removal a
  BFS from the grounded pieces runs once per frame and whatever it doesn't
  reach **collapses** (`World.collapsing`, drawn falling and shrinking for a
  second). Shoot out the bottom ramp and the tower comes down; knock one wall
  out of a house and the roof stays on the others.
- **Placement** (`buildPlan`, players and bots alike): Fortnite's rule. A wall
  goes on the first grid line in front of you — skipping one you are standing
  on — spanning your own tile; floor / ramp / cone go in the tile in front (or
  under you when looking almost straight down). The storey is the one whose
  floor is at or a step below your feet; on a ramp the next ramp continues from
  its top; looking up builds a storey higher, looking well down a storey lower;
  cones go a storey up when you look up. R / X turns the facing a quarter. If
  that storey has nothing to hold the piece the storeys either side are tried;
  an occupied cell is an honest red ghost so a held turbo button can't run a
  tower into the sky. Placement never intersects a player: `addPiece` calls
  `pushEntitiesOut`, which lifts anyone inside a new floor onto it and pushes
  anyone inside a wall to the nearest side (Fortnite's floor / cone push).
- **Colliders**: every piece/prop registers an AABB in `World.hash`, a 2D
  spatial hash with `CELL = 8`. Removal sets `col.dead`. Ramps and cones are
  `slope` colliders with a `surf(ref, x, z)` height function and a `deck`
  thickness.
- Houses (`buildHouse`) are made of the same destructible pieces the player
  places, furnished from `PROP_DEF`, with a chest inside.

## Collision (`moveEntity`)

1. `depenetrate()` — push out of anything already overlapped (a wall built
   through you, a floor placed under you, a ramp deck you ended up inside).
   Shortest way out wins, except a small lift onto a surface is preferred.
   This replaced the old "push in the direction you were moving" rule, which
   is what let you *lag through* a wall you overlapped: walking away from it
   teleported you to the far side.
2. Axis-separated AABB resolution (X, Z, then Y) in **sub-steps** of at most
   0.3 m, so a long frame can't tunnel through a 0.4 m wall or a 0.3 m floor.
   A ledge up to `STEP_UP` (0.85 m) is walked onto instead of blocking.
3. Ramp / cone surfaces act as walkable ground (`surf`); from below, a ramp
   deck and a cone body are solid ceilings.
4. Map bounds and the terrain clamp. `e.onRamp` records that the ramp support
   took over (placement uses it).

Skydiving lands on whatever `surfaceUnder()` finds — a roof or a floor as
readily as the ground. `dev/test.js` checks all of this at four frame rates.

## POIs and props

13 POIs on a ring with themes — `town`, `farm`, `spacebase`, `graveyard`,
`camp` — each with a Fortnite-style name shown under the compass. `buildPOI()`
places houses (`placeHouse`, kept off the road) and `scatterProp()`s the theme's
props: cars, streetlights, benches, dumpsters and a water tower in towns;
fences, barrels, crates, tents and lumber on farms; containers, landers, wind
turbines and solar panels at the space base; graves, dead trees, iron fences,
lanterns and a crypt in the graveyard. `PROP_DEF` maps each kind to its model
variants, height, footprint, material and hit points; solid props get a
collider from the loaded model's real footprint and are harvestable, decorative
ones (bushes, rugs, pallets, the landing pad) are just drawn. 1500 trees, 520
rocks, 700 bushes and 80 logs are scattered off the roads and POIs.

## Combat / loot

- `WEAPONS`: pickaxe, pistol, smg, ar, shotgun (9 pellets), sniper; 5 `RARITY`
  tiers ×1.00 → ×1.38. Hitscan from the **gun muzzle** (`gunPoint`), converging
  on the crosshair in third person (`playerAimDir`). Shots damage pieces
  (0.85×) and props (0.8×) and throw material chips; the pickaxe harvests.
- Time-to-kill constants: `TTK` 0.68, `BOT_DMG` 0.46, `HEAD_MUL` 1.6,
  `BOT_SHIELD` 60 — fights last, bots pause between bursts and heal.
- Loot is physical (falls, bounces, lands on builds). Guns on the ground are the
  same procedural models as in hand; ammo is a textured crate, medkits a
  white cross box, shields the KayKit bottle tinted blue, materials the KayKit
  lumber / stone piles. Every item has a rarity beacon, a ground disc and a
  name tag with an `[E]` / `[X]` prompt on the one you are pointing at
  (`lookedAtLoot`: scored by angle from the eye, not the camera).
- Materials and ammo are auto-collected; guns and heals are taken with E / X.

## Particles, bus, glider

`spawnParticles()` — cubes with gravity: impact sparks, material chips on
harvest and shots, build puffs, landing dust, chest bursts. The battle bus
(`drawBus`: textured body, tube wheels, balloon, burner) flies on ahead of the
last jumper along the drop line for the first 40 s. The glider is a flattened
sphere canopy with strings.

## HUD

Single 2D canvas in a virtual ~1400-wide space (`S = clamp(width/1400, …)`):
vignette (purple when in the storm), compass strip with the nearest POI name,
shield / health bars, hotbar with vector item icons and ammo, build bar with
piece glyphs, materials, minimap painted from the terrain + roads + POIs with
storm circles and the player arrow, kill feed, damage numbers, loot labels, and
the name + health of the piece or prop under the crosshair (`drawTargetInfo`).

## Match flow

`menu → drop → play → dead | win`. The menu shows a slow orbit of the central
POI (a world is generated at boot for it). `newMatch()` regenerates the world,
terrain mesh, splat map and minimap, spawns 24 entities spread along the bus
line at y≈150–172, and starts the storm. Freefall at 42 m/s, glider below 45 m
above ground. Bots keep their AI from before (acquire within 65 m with LOS,
rotate to the circle, strafe, burst, panic wall, loot real items, heal).

## Screenshot / debug mode

`?auto=…` on the URL (see `dev/README.md`) starts a match with no animation
loop, places the player, steps the simulation, renders one frame with a status
line, and blits the GL frame into the HUD canvas so headless Chrome can capture
it. `window.FN` exposes `start`, `god`, `give`, `mats`, `tp`, `assets`,
`reload`, `shadows(false)`, `aimAssist(false)`, `sens`, `fov`, `pad`.

## Input

Keyboard/mouse (pointer lock) and gamepad (Builder Pro) as before — see the
control lists in `index.html`. `Input.pollPad()` folds any standard or generic
pad into the keyboard map; aim assist (`padLook`) is a cone + slowdown +
magnetism measured from the eye. Mouse gets a lighter version (`mouseAssist`):
a small snap onto a nearby enemy the frame ADS starts, then gentle magnetism
while held, released whenever the mouse moves away. Sprint (Shift / L3) is a
toggle, not hold. `wrapAngle`/`angleDelta` keep yaw folded.

## Known simplifications

- No edit mode; no piece rotation preview beyond ramp facing.
- No water, no driveable vehicles, no swimming.
- No networking — bots only.
- Characters share one rig; the held weapon follows the hand position but is
  oriented by the aim, so during a reload clip it stays pointed forward.
- The chest lid does not hinge (the KayKit chest is one mesh).
- No crouch; B carries the build-mode toggle on a pad.
- One gamepad, no rumble, no remapping UI.

## Change log

- **v1.0–v1.4 (2026-08-17 … 2026-09-09)** — initial build, physical loot,
  controller support, real map with heightfield, aim-assist fix and frame-cost
  pass. (History in git-less detail: the earlier CONTEXT.md.)

- **v2.0 (2026-09-10)** — models for everything, a real renderer, and the
  building fixes.
  *Assets.* 80 CC0 KayKit models (`dev/fetchpack.js`): five skinned, animated
  characters (trimmed to 24 clips each with `dev/strip.js`), trees, rocks, cars,
  furniture, town / farm / space / graveyard props, chests, bottles. Guns, the
  pickaxe, ammo, medkits, bus and glider are procedural.
  *Renderer.* Shadow map, sky dome with clouds, hemispheric lighting, triplanar
  wood / brick / metal materials for build pieces, terrain shader with splat-map
  roads and slope rock, skinned character program, sphere + tube primitives,
  build-up animation on placed pieces, collapse animation, particles.
  *Building.* Absolute world grid (pieces always line up), contact-key
  structural support with collapse, Fortnite-style deterministic placement,
  push-out on placement, `STEP_UP` ledges, solid ramp undersides and cones,
  skydive landing on roofs, sub-stepped collision that cannot tunnel at any
  frame rate, de-penetration instead of direction-based push (the "lag through
  a wall" bug). Verified by `dev/test.js` (35 checks) and headless screenshots.
  *Game.* Character animation state machine with an upper-body layer, weapons
  in hand oriented by aim, first-person gun, themed POIs with names, roads,
  minimap from the terrain, compass, target health readout, hotbar icons,
  vignette, menu backdrop, battle bus, glider.
