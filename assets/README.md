# assets/

Every model the game draws. All of it is **CC0** — no attribution required,
commercial use fine — from two authors:

- [KayKit](https://kaylousberg.itch.io) (also on
  [GitHub](https://github.com/KayKit-Game-Assets)): the five skinned characters
  and the farm / camp / graveyard / furniture props.
- [Quaternius](https://quaternius.com): **Ultimate Stylized Nature** (textured
  trees, dead trees, bushes, rocks, grass and plants; textures downscaled into
  `tex/`), **Zombie Apocalypse Kit** (vehicles, streetlights, traffic lights,
  cones, barriers, containers, water tower, town sign, the real gun models, the
  fire axe, chests) and **Ultimate Space Kit** (dome, modules, ships, rovers,
  solar panels, radar, alien plants and rocks, the ammo / medkit pickups).

`LICENSE.txt` carries both CC0 notices. `dev/fetchpack.js` rebuilds this
folder from the packs' public downloads.

Nothing in here is required: every draw site keeps a procedural fallback, so a
missing or broken file costs you the nicer model and nothing else. `FN.assets()`
in the console lists what loaded, what failed and why.

## What is here

| Group | Files | Used for |
| --- | --- | --- |
| Characters | `char_knight` `char_barbarian` `char_mage` `char_rogue` `char_rogue_hooded` | Player (knight) and bots (random). Skinned, 24 animation clips each, ~1.3 MB. Trimmed from the 3.6 MB originals with `dev/strip.js`-style stripping: unused clips and the pack's own swords/shields removed. |
| Nature | `tree_a` `tree_b` `tree_pine_y` `tree_pine_o` `tree_dead` `tree_dead_m` `rock_c` `rock_d` `rock_e` `rock_space` `bush` `log_large` `log_medium` | Scatter props. Trees give wood, rocks give brick, logs give wood. Bushes are decoration only. |
| Vehicles | `car_sedan` `car_hatchback` `car_police` `car_taxi` `car_wagon` `spacetruck` | Metal props at towns / the space base. |
| Town | `streetlight` `bench` `dumpster` `hydrant` `trash_a` `trash_b` `trafficlight` `watertower` `box_a` `box_b` | Town POIs. |
| Farm / camp | `barrel` `barrel_large` `barrel_stack` `keg` `crate_big` `crate_small` `crates_stacked` `box_small` `lumber` `stone` `tent` `wheelbarrow` `pallet` `sack` `fence_wood` | Farm and camp POIs, plus `lumber` / `stone` as the wood / brick material drops. |
| Space base | `container_a` `container_b` `cargo` `lander` `turbine` `solar` `landingpad` | The space-base POIs. |
| Graveyard | `grave_a` `grave_b` `gravestone` `crypt` `fence_iron` `fence_gate` `arch_gate` `lantern` `post_lantern` `pumpkin` | The graveyard POIs. |
| Interiors | `bed` `table` `chair` `couch` `armchair` `cabinet` `shelf` `lamp` `rug` | Furniture inside every house. |
| Items | `chest` `chest_gold` `bottle_a` `bottle_b` | Loot chests; `bottle_a` tinted blue is the shield potion. |

Guns, the pickaxe, ammo boxes, medkits, the battle bus and the glider are
procedural (see `GUN_MODEL` in game.js and textures.js) — no CC0 gun set was
reachable, and building them from cubes and tubes keeps them on the game's own
rarity colours.

## Adding one

1. Put a `.glb` in here (self-contained: textures embedded). A `.gltf` with a
   `.bin` and a `.png` beside it also works.
2. Add a kind to `PROP_DEF` in world.js: model name(s), height in metres,
   footprint, material, hit points. The collider comes from the loaded model's
   real footprint, scaled to that height.
3. Place it from `buildPOI()` / the scatter loop with `scatterProp()`.

`MANIFEST` in game.js is built from `PROP_DEF`, so nothing else needs editing.

## Models must be served over http://

`fetch()` is blocked on `file://`, so opening `index.html` directly still works
but shows the built-in geometry. Run the server to see models:

```bash
node server.js      # → http://localhost:3500
```

## What the loader accepts

`models.js` handles GLB and `.gltf` + `.bin` + external images, the full node
hierarchy, interleaved accessors, normalized integer attributes, missing
normals, **skins** (one per file, up to 64 palette slots including rigid
attachments) and **animations** (LINEAR / STEP; CUBICSPLINE reduced to its
key values). It rejects Draco / meshopt / basisu compression with a message
saying so — re-export with compression off.

## Budget

One material = one draw call per frame, per model (per character for skinned
ones). The whole game runs ~150–250 draw calls at a busy POI, twice that with
the shadow pass counted. Keep props to a few hundred or a few thousand
triangles.
