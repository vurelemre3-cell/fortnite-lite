// fetchpack.js <outDir> <dlDir> [onlyPrefix]
// Rebuilds assets/ from the public sources: downloads every model the game uses
// (KayKit from GitHub raw, Quaternius Ultimate Stylized Nature from a GitHub
// mirror of the CC0 pack, Quaternius Zombie Apocalypse Kit + Ultimate Space Kit
// straight from the packs' public Google Drive folders) and packs each one into
// one assets/<name>.glb with pack.js. Nature textures are downscaled with
// imgtool.js into assets/tex/ and shared by every tree that uses them.
// Files already in <outDir> are skipped, so a re-run only fetches what is missing.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const RAW = 'https://raw.githubusercontent.com/KayKit-Game-Assets/';
const P = {
  hex: 'KayKit-Medieval-Hexagon-Pack-1.0/main/addons/kaykit_medieval_hexagon_pack/Assets/gltf/',
  city: 'KayKit-City-Builder-Bits-1.0/main/addons/kaykit_city_builder_bits/Assets/gltf/',
  dun: 'KayKit-Dungeon-Remastered-1.0/main/addons/kaykit_dungeon_remastered/Assets/gltf/',
  fur: 'KayKit-Furniture-Bits-1.0/main/addons/kaykit_furniture_bits/Assets/gltf/',
  hal: 'KayKit-Halloween-Bits-1.0/main/addons/kaykit_halloween_bits/Assets/gltf/',
  spc: 'KayKit-Space-Base-Bits-1.0/main/addons/kaykit_space_base_bits/Assets/gltf/',
  chr: 'KayKit-Character-Pack-Adventures-1.0/main/addons/kaykit_character_pack_adventures/Characters/gltf/',
};
// Quaternius "Ultimate Stylized Nature" (CC0): the .gltf files (buffers embedded)
// from a public GitHub mirror of the pack, textures from the pack's own Drive folder.
const NATURE = 'https://raw.githubusercontent.com/luisfpatrocinio/MinimonsArena/main/Ultimate%20Stylized%20Nature%20-%20May%202022/glTF/';
// Quaternius texture files: [file, Google Drive id, max size]
const NATURE_TEX = [
  ['BirchTree_Bark.jpg', '1puC8NuyemENIPB40TOsKdqzp0EmUJe1g', 512], ['BirchTree_Leaves.png', '1RPfkjEuuEwFno9gh3U0zQndzcB8DOr_S', 512],
  ['MapleTree_Bark.jpg', '1ooEfm7ZxVwm1bal3qnY7E9ydqZ28k18P', 512], ['MapleTree_Leaves.png', '1GX7-YPXDd9S3-VQre1S4kASWQoHmasA1', 512],
  ['NormalTree_Bark.jpg', '190KWIyJT7qkxtZ3LHlkoqluz6b1HWyAa', 512], ['NormalTree_Leaves.png', '1V4IePGK9IFayrRXTZo2SqiEMEB10c1MG', 512],
  ['PineTree_Bark.jpg', '1D-Z4lyMQZSHoLpQYANNNiq4C8c_m4HPl', 512], ['PineTree_Leaves.png', '10iiCzOtzshoLo-0LNQ6XrRfHaiIIKWIn', 512],
  ['Bush_Leaves.png', '19xOyTuSATvkHhQd8zC6PW-y6RX761yGA', 512], ['Flowers.png', '1__uvRQhRXZcOQ_lsvkrZfDr9Alr8ru6U', 512],
  ['Grass.png', '1NjDwDFwQDQ9W4rOl9Wo-eaP12W-tO_Ve', 512], ['Rocks.jpg', '1HTHi0x3Ii16e1S3zXO2aDM_hMrSnnCYO', 512],
];

const M = [ // [out, source, ref, pack options]  — source: kaykit pack key | 'nature' | 'gd' (Google Drive id)
  // KayKit Adventurers characters (skinned; run dev/strip.js on these afterwards)
  ['char_knight', 'chr', 'Knight.glb'], ['char_barbarian', 'chr', 'Barbarian.glb'], ['char_mage', 'chr', 'Mage.glb'], ['char_rogue', 'chr', 'Rogue.glb'], ['char_rogue_hooded', 'chr', 'Rogue_Hooded.glb'],
  // KayKit props still in use
  ['barrel', 'hex', 'decoration/props/barrel.gltf'], ['crate_big', 'hex', 'decoration/props/crate_A_big.gltf'], ['crate_small', 'hex', 'decoration/props/crate_B_small.gltf'],
  ['lumber', 'hex', 'decoration/props/resource_lumber.gltf'], ['stone', 'hex', 'decoration/props/resource_stone.gltf'], ['tent', 'hex', 'decoration/props/tent.gltf'],
  ['wheelbarrow', 'hex', 'decoration/props/wheelbarrow.gltf'], ['pallet', 'hex', 'decoration/props/pallet.gltf'], ['fence_wood', 'hex', 'buildings/neutral/fence_wood_straight.gltf'], ['sack', 'hex', 'decoration/props/sack.gltf'],
  ['bench', 'city', 'bench.gltf'], ['box_a', 'city', 'box_A.gltf'], ['box_b', 'city', 'box_B.gltf'], ['dumpster', 'city', 'dumpster.gltf'], ['trash_a', 'city', 'trash_A.gltf'], ['trash_b', 'city', 'trash_B.gltf'],
  ['barrel_large', 'dun', 'barrel_large.gltf.glb'], ['barrel_stack', 'dun', 'barrel_small_stack.gltf.glb'], ['box_small', 'dun', 'box_small.gltf.glb'], ['crates_stacked', 'dun', 'crates_stacked.gltf.glb'], ['keg', 'dun', 'keg.gltf.glb'],
  ['bottle_a', 'dun', 'bottle_A_green.gltf.glb'], ['log_large', 'dun', 'trunk_large_A.gltf.glb'], ['log_medium', 'dun', 'trunk_medium_A.gltf.glb'],
  ['bed', 'fur', 'bed_single_A.gltf'], ['table', 'fur', 'table_medium.gltf'], ['chair', 'fur', 'chair_A.gltf'], ['couch', 'fur', 'couch.gltf'], ['cabinet', 'fur', 'cabinet_medium.gltf'], ['shelf', 'fur', 'shelf_A_big.gltf'], ['lamp', 'fur', 'lamp_standing.gltf'], ['armchair', 'fur', 'armchair.gltf'], ['rug', 'fur', 'rug_rectangle_A.gltf'],
  ['grave_a', 'hal', 'grave_A.gltf'], ['grave_b', 'hal', 'grave_B.gltf'], ['gravestone', 'hal', 'gravestone.gltf'], ['fence_iron', 'hal', 'fence.gltf'], ['fence_gate', 'hal', 'fence_gate.gltf'], ['arch_gate', 'hal', 'arch_gate.gltf'], ['crypt', 'hal', 'crypt.gltf'], ['lantern', 'hal', 'lantern_standing.gltf'], ['pumpkin', 'hal', 'pumpkin_orange.gltf'], ['post_lantern', 'hal', 'post_lantern.gltf'],
  ['container_a', 'spc', 'containers_A.gltf'], ['container_b', 'spc', 'containers_B.gltf'], ['cargo', 'spc', 'cargo_A_stacked.gltf'], ['turbine', 'spc', 'windturbine_tall.gltf'], ['landingpad', 'spc', 'landingpad_small.gltf'],

  // Quaternius Ultimate Stylized Nature — trees, dead trees, bushes, rocks, ground cover
  ['tree_birch_1', 'nature', 'BirchTree_1.gltf'], ['tree_birch_4', 'nature', 'BirchTree_4.gltf'], ['tree_birch_5', 'nature', 'BirchTree_5.gltf'],
  ['tree_maple_1', 'nature', 'MapleTree_1.gltf'], ['tree_maple_4', 'nature', 'MapleTree_4.gltf'], ['tree_maple_5', 'nature', 'MapleTree_5.gltf'],
  ['tree_oak_3', 'nature', 'NormalTree_3.gltf'], ['tree_oak_5', 'nature', 'NormalTree_5.gltf'],
  ['tree_pine_1', 'nature', 'PineTree_1.gltf'], ['tree_pine_2', 'nature', 'PineTree_2.gltf'], ['tree_pine_4', 'nature', 'PineTree_4.gltf'], ['tree_pine_5', 'nature', 'PineTree_5.gltf'],
  ['tree_dead_1', 'nature', 'DeadTree_1.gltf'], ['tree_dead_3', 'nature', 'DeadTree_3.gltf'], ['tree_dead_5', 'nature', 'DeadTree_5.gltf'], ['tree_dead_9', 'nature', 'DeadTree_9.gltf'],
  ['bush_1', 'nature', 'Bush.gltf'], ['bush_2', 'nature', 'Bush_Large.gltf'], ['bush_3', 'nature', 'Bush_Small.gltf'], ['bush_4', 'nature', 'Bush_Flowers.gltf'], ['bush_5', 'nature', 'Bush_Large_Flowers.gltf'],
  ['rock_1', 'nature', 'Rock_1.gltf', ['--tex', 'Rock=Rocks.jpg']], ['rock_2', 'nature', 'Rock_2.gltf', ['--tex', 'Rock=Rocks.jpg']], ['rock_3', 'nature', 'Rock_3.gltf', ['--tex', 'Rock=Rocks.jpg']], ['rock_4', 'nature', 'Rock_4.gltf', ['--tex', 'Rock=Rocks.jpg']], ['rock_5', 'nature', 'Rock_5.gltf', ['--tex', 'Rock=Rocks.jpg']],
  ['grass_1', 'nature', 'Grass_Large_Extruded.gltf'], ['grass_2', 'nature', 'Grass_Small.gltf'], ['plant_1', 'nature', 'Plant_1.gltf'], ['plant_2', 'nature', 'Plant_2.gltf'], ['plant_3', 'nature', 'Plant_Flowers.gltf'],

  // Quaternius Zombie Apocalypse Kit — town props, vehicles, weapons, loot chest
  ['car_pickup', 'gd', '1j61AAiVS0PbbDE_JCW58rhr43p4sVOLS:zombie/Vehicle_Pickup.gltf'], ['car_pickup_armored', 'gd', '1Vj0LYG7osEColDl4BxVV6EC2mOBW-1ND:zombie/Vehicle_Pickup_Armored.gltf'],
  ['car_sports', 'gd', '1mRasAWSbbCUo74tBi_mxrNmTS74tdLr9:zombie/Vehicle_Sports.gltf'], ['car_sports_armored', 'gd', '1xpTt-twV7IhdH7oLcUSMdW4cszYq2S88:zombie/Vehicle_Sports_Armored.gltf'],
  ['car_truck', 'gd', '1Z-oz5wLLVso3NSs8jTIkVm8ysA4Lx7h1:zombie/Vehicle_Truck.gltf'], ['car_truck_armored', 'gd', '1F8wXYSc1-Je0ylBvonbQ3PQEKBZgEuut:zombie/Vehicle_Truck_Armored.gltf'],
  ['gun_pistol', 'gd', '1Fwuz1p1hreHAe8y8w99G1fJz5AefWLOR:zombie/Pistol.gltf'], ['gun_rifle', 'gd', '1UDLXhSl5RY3f-SvuRrsH8RxdpQcC_6Ig:zombie/Rifle.gltf'],
  ['gun_shotgun', 'gd', '1eMnIgvbLG6CFCuzYxjwFhWt2J72oc3a_:zombie/Shotgun.gltf'], ['gun_smg', 'gd', '1SiFuiHneAJQeI01z7J-c22MGEZuKM-1x:zombie/SMG.gltf'], ['gun_axe', 'gd', '1COcFTVL5-gUNVpuPXK8k8TWYJEyl27uU:zombie/Axe.gltf'],
  ['chest_z', 'gd', '1yEC_pV6-U8Tt56fwhXgfuN2iRYwQoA_M:zombie/Chest.gltf'], ['chest_special', 'gd', '1uDqLcg1JP3FHWM3IIpF4DYDnxZInCIeD:zombie/Chest_Special.gltf'],
  ['streetlight_z', 'gd', '1kIQHIMErEozis98TX8Dyca3uWXOKtfkq:zombie/StreetLights.gltf'], ['trafficlight_1', 'gd', '1FfZb08XIdv9gzHCVJ9JRIoLmqcgf87Q9:zombie/TrafficLight_1.gltf'], ['trafficlight_2', 'gd', '1HFAunoFXWQge8wLn9OkXgks-OvcEWQM3:zombie/TrafficLight_2.gltf'],
  ['hydrant_z', 'gd', '12eTSrvHAa4D5Sr-_oFnMEHWYY65jwDGo:zombie/FireHydrant.gltf'], ['cone_1', 'gd', '1_WR8Kywq-OWR-MZUt-gHM-raRSRRXYHn:zombie/TrafficCone_1.gltf'], ['cone_2', 'gd', '1MUg2w1zfjk015CRtyV-oM9vMSCD6x6lj:zombie/TrafficCone_2.gltf'],
  ['barrier_1', 'gd', '1AtADK-CW_7EfMiBeMGL95Iu4FnolBCBq:zombie/TrafficBarrier_1.gltf'], ['barrier_2', 'gd', '1bnXoYPgYw6eX8pyN0G5B1BMiNy17P8MW:zombie/TrafficBarrier_2.gltf'], ['barrier_plastic', 'gd', '19Qff0L9UtY_pumPT1jdbfFYLMRMWl9X7:zombie/PlasticBarrier.gltf'],
  ['container_green', 'gd', '1lX57FkFymKSZRjOhwrbOP7CjvQVaFdQM:zombie/Container_Green.gltf'], ['container_red', 'gd', '10SC_m23U-_UGPRlUdQwW1iqi0-QAtpzq:zombie/Container_Red.gltf'],
  ['cinderblock', 'gd', '1bmCa_mWLpiJHr2fH8CxjxQXdCsUIM3oA:zombie/CinderBlock.gltf'], ['barrel_z', 'gd', '114k_vH2gWjaumPc39bKfGRdRvkB8Ym4Q:zombie/Barrel.gltf'],
  ['pallet_z', 'gd', '1qI0DJkGfnOG85-7W1uE1ceZni1A4JKBS:zombie/Pallet.gltf'], ['pallet_broken', 'gd', '1hZFumQsNw-1cjYBpUPS-PsdSLRwEktq-:zombie/Pallet_Broken.gltf'],
  ['couch_z', 'gd', '1rgX-QENR7yW1WsXK0xvxem_odfaefLEk:zombie/Couch.gltf'], ['watertower_z', 'gd', '1RSQt1S8iHFOfnQOegpX0p41VHw3W0g6X:zombie/WaterTower.gltf'],
  ['wheels_stack', 'gd', '1Oa4cOiUt9PpNeLi5xFhHhwnAix3bor-w:zombie/Wheels_Stack.gltf'], ['townsign', 'gd', '1RardVh99rHg6BUVCokWSzyin66nFCgHZ:zombie/TownSign.gltf'],
  ['trashbag_1', 'gd', '1FuihhOhGyhKCycJPTYtPHnBBWbGHEpMF:zombie/TrashBag_1.gltf'], ['trashbag_2', 'gd', '1A4AfNM4-4XtSLkLr-_SC40fThLguleNb:zombie/TrashBag_2.gltf'], ['pipes', 'gd', '1hxT5Xnm77y6gXOKwriNSXonaxf4W-wdY:zombie/Pipes.gltf'],

  // Quaternius Ultimate Space Kit — the space base, plus the ammo / medkit pickups
  ['dome', 'gd', '1Zx9ncJcGTFIOhhSUEZrxPoHfF6qwH3kI:space/GeodesicDome.gltf'], ['house_single', 'gd', '15MH7HmfMKllJoUT0UyXOMVACmkzHeKYS:space/House_Single.gltf'],
  ['house_long', 'gd', '116b1arCf8gG7OzTFhOz31lgycRMbts07:space/House_Long.gltf'], ['house_cylinder', 'gd', '1sLdfgnUgzJH14VvpQ1PzgDgkgH1aAMo8:space/House_Cylinder.gltf'],
  ['base_large', 'gd', '1oxNBLOzQyt4-xxfDkKTSkNmgP3wVTHg4:space/Base_Large.gltf'], ['metal_support', 'gd', '1gjr0dLovQ6HTKRVQzAvrGEOtG02aAJWk:space/MetalSupport.gltf'],
  ['rover_1', 'gd', '1oQqZiRr61zqPOKzKNBvIx4huQ5_xby_o:space/Rover_1.gltf'], ['rover_2', 'gd', '1e_ea0x-FhTJYvrfMe-tV3XggwXdTOgnd:space/Rover_2.gltf'], ['rover_round', 'gd', '1BgVJWTe89P5Uvgr8D_v36-uC1Ty9vQGF:space/Rover_Round.gltf'],
  ['ship_bee', 'gd', '1Lb1FAQABvdnyCXybIA-EoFhT6gJen0GL:space/Spaceship_BarbaraTheBee.gltf'], ['ship_frog', 'gd', '1YKAanEXyE_9ukxozfoXEUNr2T8ZDX6ZE:space/Spaceship_FinnTheFrog.gltf'], ['ship_panda', 'gd', '1kwNFEu26AAQfPl3f2PSNVYxLBsGlvsDG:space/Spaceship_RaeTheRedPanda.gltf'],
  ['solar_ground', 'gd', '1XRId8Bbfi5QfBm1lw7SMGQeTfY6RF3-p:space/SolarPanel_Ground.gltf'], ['solar_structure', 'gd', '19nFEinf4URAB9DWy-3pyLQWcMols0qR6:space/SolarPanel_Structure.gltf'], ['radar', 'gd', '1MneYKK3nLkVc5UJF53gKvJMkt4NpDyOb:space/Roof_Radar.gltf'],
  ['srock_1', 'gd', '1axt_9eZWW0KIh7vn-rlTbED5q1orYPWa:space/Rock_1.gltf'], ['srock_2', 'gd', '1apGL51ItWhNHkCG8q1EwD0tjOhZfjJBn:space/Rock_2.gltf'],
  ['srock_large_1', 'gd', '1ZLlJjBo_KCzMw0SLHsvSEfWjS8ogfOz5:space/Rock_Large_1.gltf'], ['srock_large_2', 'gd', '13GrjRCZtT1h26BcBwDlUvzZMLaoY0IYk:space/Rock_Large_2.gltf'], ['srock_large_3', 'gd', '1WDmFwtN2Htij5wgfWuvuWIaW7AWz1Jw1:space/Rock_Large_3.gltf'],
  ['alien_blob', 'gd', '14-JXNiTbO5AtHHJ-N9JyYRgK49yQCvyZ:space/Tree_Blob_1.gltf'], ['alien_spikes', 'gd', '1RguRtap9nVrgt6-FoBK0TyV4udHBYLww:space/Tree_Spikes_1.gltf'], ['alien_spiral', 'gd', '1Vw9JzyRkYfNl-yL1AOgvA7hCzxqInIjl:space/Tree_Spiral_1.gltf'], ['alien_swirl', 'gd', '1Uk2ygXj1OG7ehqxTuu9FXpxeyNlhi1_X:space/Tree_Swirl_1.gltf'],
  ['pickup_health', 'gd', '1yfIREq_LL11g2ESI_4Z0KJPBhU4Pr_pw:space/Pickup_Health.gltf'], ['pickup_bullets', 'gd', '1a_XhIdpCX6hIO46TUSb0ERQr1_pv9I-b:space/Pickup_Bullets.gltf'], ['pickup_crate', 'gd', '1wuFmEHfnifcmoDrp9yyTzv51dqQ9bHVB:space/Pickup_Crate.gltf'],
];

const out = process.argv[2], dl = process.argv[3], only = process.argv[4];
if (!out || !dl) { console.log('usage: node dev/fetchpack.js <outDir> <dlDir> [onlyPrefix]'); process.exit(1); }
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.join(out, 'tex'), { recursive: true }); fs.mkdirSync(dl, { recursive: true });
const curl = (url, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { execFileSync('curl', ['-sfL', '--max-time', '180', '-o', to, url]); return fs.statSync(to).size; }
  catch (e) { return -1; }
};
// A public Google Drive file. Drive answers `uc?export=download` with the bytes
// for anything it has virus-scanned (all of these); an HTML answer means a
// confirm page, which is passed through once.
async function gdrive(id, to) {
  if (fs.existsSync(to) && fs.statSync(to).size > 0) return fs.statSync(to).size;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let res = await fetch('https://drive.google.com/uc?export=download&id=' + id, { redirect: 'follow' });
  if (/text\/html/.test(res.headers.get('content-type') || '')) {
    const html = await res.text();
    const action = (html.match(/<form[^>]+action="([^"]+)"/) || [])[1];
    const inputs = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)];
    if (!action || !inputs.length) throw new Error('drive gave HTML for ' + id);
    res = await fetch(action + '?' + inputs.map(i => i[1] + '=' + encodeURIComponent(i[2])).join('&'), { redirect: 'follow' });
    if (/text\/html/.test(res.headers.get('content-type') || '')) throw new Error('drive confirm failed for ' + id);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(to, buf);
  return buf.length;
}
const pack = (src, dst, opts) => execFileSync('node', [path.join(__dirname, 'pack.js'), src, dst, ...(opts || [])], { stdio: 'inherit' });

(async () => {
  let ok = 0; const bad = [];
  // 1. nature textures: originals into <dl>/nature, downscaled copies into <out>/tex
  if (!only || 'tree'.startsWith(only) || /^(tree|bush|rock|grass|plant)/.test(only)) {
    for (const [file, id, size] of NATURE_TEX) {
      const dst = path.join(out, 'tex', file);
      if (fs.existsSync(dst) && fs.statSync(dst).size > 0) continue;
      try {
        await gdrive(id, path.join(dl, 'nature', file));
        execFileSync('node', [path.join(__dirname, 'imgtool.js'), 'resize', path.join(dl, 'nature', file), dst, String(size)], { stdio: 'inherit' });
      } catch (e) { bad.push('tex ' + file + ': ' + e.message); console.log('BAD tex ' + file + ' ' + e.message); }
    }
  }
  // 2. models
  for (const [name, src, ref, opts] of M) {
    if (only && !name.startsWith(only)) continue;
    const dst = path.join(out, name + '.glb');
    if (fs.existsSync(dst) && fs.statSync(dst).size > 1000) { ok++; continue; }
    try {
      if (src === 'nature') {
        const gpath = path.join(dl, 'nature', ref);
        if (!(fs.existsSync(gpath) && fs.statSync(gpath).size > 0) && curl(NATURE + ref, gpath) <= 0) throw new Error('download failed');
        // textures live next to the .gltf in the pack; the GLB points at assets/tex/<file>
        pack(gpath, dst, ['--texdir', path.join(dl, 'nature'), '--extern', 'tex/', ...(opts || [])]);
      } else if (src === 'gd') {
        const [id, file] = ref.split(':');
        const gpath = path.join(dl, file);
        await gdrive(id, gpath);
        pack(gpath, dst, opts);
      } else {
        const url = RAW + P[src] + ref;
        if (/\.glb$/i.test(ref)) {
          if (curl(url, dst) <= 0) throw new Error('download failed');
        } else {
          const d = path.join(dl, src, path.dirname(ref)); fs.mkdirSync(d, { recursive: true });
          const gpath = path.join(d, path.basename(ref));
          if (curl(url, gpath) <= 0) throw new Error('gltf download failed');
          const g = JSON.parse(fs.readFileSync(gpath, 'utf8'));
          const deps = [...(g.buffers || []).map(b => b.uri), ...(g.images || []).map(i => i.uri)].filter(u => u && !/^data:/.test(u));
          for (const u of deps) {
            const lp = path.join(d, decodeURIComponent(u));
            if (fs.existsSync(lp) && fs.statSync(lp).size > 0) continue;
            const uu = RAW + P[src] + path.posix.join(path.posix.dirname(ref), u);
            if (curl(uu, lp) <= 0) throw new Error('dep failed ' + u);
          }
          pack(gpath, dst, opts);
        }
      }
      ok++; console.log('ok  ' + name.padEnd(20) + String(fs.statSync(dst).size).padStart(9));
    } catch (e) { bad.push(name + ': ' + e.message); console.log('BAD ' + name + ' ' + e.message); }
  }
  console.log('done', ok, 'ok,', bad.length, 'failed');
  if (bad.length) console.log(bad.join('\n'));
})();
