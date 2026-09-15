// fetchpack.js <outDir> <dlDir> [onlyPrefix]
// Download KayKit .gltf (+ .bin + images) or .glb files from GitHub raw and pack
// each into one self-contained assets/<name>.glb via pack.js.
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
const M = [ // [out, pack, file]
  ['char_knight', 'chr', 'Knight.glb'], ['char_barbarian', 'chr', 'Barbarian.glb'], ['char_mage', 'chr', 'Mage.glb'], ['char_rogue', 'chr', 'Rogue.glb'], ['char_rogue_hooded', 'chr', 'Rogue_Hooded.glb'],
  ['tree_a', 'hex', 'decoration/nature/tree_single_A.gltf'], ['tree_b', 'hex', 'decoration/nature/tree_single_B.gltf'],
  ['rock_c', 'hex', 'decoration/nature/rock_single_C.gltf'], ['rock_d', 'hex', 'decoration/nature/rock_single_D.gltf'], ['rock_e', 'hex', 'decoration/nature/rock_single_E.gltf'],
  ['barrel', 'hex', 'decoration/props/barrel.gltf'], ['crate_big', 'hex', 'decoration/props/crate_A_big.gltf'], ['crate_small', 'hex', 'decoration/props/crate_B_small.gltf'],
  ['lumber', 'hex', 'decoration/props/resource_lumber.gltf'], ['stone', 'hex', 'decoration/props/resource_stone.gltf'], ['tent', 'hex', 'decoration/props/tent.gltf'],
  ['wheelbarrow', 'hex', 'decoration/props/wheelbarrow.gltf'], ['pallet', 'hex', 'decoration/props/pallet.gltf'], ['fence_wood', 'hex', 'buildings/neutral/fence_wood_straight.gltf'], ['sack', 'hex', 'decoration/props/sack.gltf'],
  ['bench', 'city', 'bench.gltf'], ['box_a', 'city', 'box_A.gltf'], ['box_b', 'city', 'box_B.gltf'], ['bush', 'city', 'bush.gltf'],
  ['car_hatchback', 'city', 'car_hatchback.gltf'], ['car_police', 'city', 'car_police.gltf'], ['car_sedan', 'city', 'car_sedan.gltf'], ['car_wagon', 'city', 'car_stationwagon.gltf'], ['car_taxi', 'city', 'car_taxi.gltf'],
  ['dumpster', 'city', 'dumpster.gltf'], ['hydrant', 'city', 'firehydrant.gltf'], ['streetlight', 'city', 'streetlight.gltf'], ['trash_a', 'city', 'trash_A.gltf'], ['trash_b', 'city', 'trash_B.gltf'], ['watertower', 'city', 'watertower.gltf'], ['trafficlight', 'city', 'trafficlight_A.gltf'],
  ['barrel_large', 'dun', 'barrel_large.gltf.glb'], ['barrel_stack', 'dun', 'barrel_small_stack.gltf.glb'], ['box_small', 'dun', 'box_small.gltf.glb'], ['crates_stacked', 'dun', 'crates_stacked.gltf.glb'], ['keg', 'dun', 'keg.gltf.glb'],
  ['bottle_a', 'dun', 'bottle_A_green.gltf.glb'], ['bottle_b', 'dun', 'bottle_B_green.gltf.glb'], ['log_large', 'dun', 'trunk_large_A.gltf.glb'], ['log_medium', 'dun', 'trunk_medium_A.gltf.glb'], ['chest', 'dun', 'chest.glb'], ['chest_gold', 'dun', 'chest_gold.glb'],
  ['bed', 'fur', 'bed_single_A.gltf'], ['table', 'fur', 'table_medium.gltf'], ['chair', 'fur', 'chair_A.gltf'], ['couch', 'fur', 'couch.gltf'], ['cabinet', 'fur', 'cabinet_medium.gltf'], ['shelf', 'fur', 'shelf_A_big.gltf'], ['lamp', 'fur', 'lamp_standing.gltf'], ['armchair', 'fur', 'armchair.gltf'], ['rug', 'fur', 'rug_rectangle_A.gltf'],
  ['grave_a', 'hal', 'grave_A.gltf'], ['grave_b', 'hal', 'grave_B.gltf'], ['gravestone', 'hal', 'gravestone.gltf'], ['tree_dead', 'hal', 'tree_dead_large.gltf'], ['tree_dead_m', 'hal', 'tree_dead_medium.gltf'], ['fence_iron', 'hal', 'fence.gltf'], ['fence_gate', 'hal', 'fence_gate.gltf'], ['arch_gate', 'hal', 'arch_gate.gltf'], ['crypt', 'hal', 'crypt.gltf'], ['lantern', 'hal', 'lantern_standing.gltf'], ['pumpkin', 'hal', 'pumpkin_orange.gltf'], ['post_lantern', 'hal', 'post_lantern.gltf'],
  ['tree_pine_y', 'hal', 'tree_pine_yellow_large.gltf'], ['tree_pine_o', 'hal', 'tree_pine_orange_large.gltf'],
  ['container_a', 'spc', 'containers_A.gltf'], ['container_b', 'spc', 'containers_B.gltf'], ['cargo', 'spc', 'cargo_A_stacked.gltf'], ['lander', 'spc', 'lander_A.gltf'], ['turbine', 'spc', 'windturbine_tall.gltf'], ['solar', 'spc', 'solarpanel.gltf'], ['spacetruck', 'spc', 'spacetruck.gltf'], ['landingpad', 'spc', 'landingpad_small.gltf'], ['rock_space', 'spc', 'rock_A.gltf'],
];
const out = process.argv[2], dl = process.argv[3], only = process.argv[4];
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(dl, { recursive: true });
const get = (url, to) => {
  try { execFileSync('curl', ['-sfL', '--max-time', '120', '-o', to, url]); return fs.statSync(to).size; }
  catch (e) { return -1; }
};
let ok = 0; const bad = [];
for (const [name, pack, file] of M) {
  if (only && !name.startsWith(only)) continue;
  const dst = path.join(out, name + '.glb');
  if (fs.existsSync(dst) && fs.statSync(dst).size > 1000) { ok++; continue; }
  const url = RAW + P[pack] + file;
  try {
    if (/\.glb$/i.test(file)) {
      if (get(url, dst) <= 0) throw new Error('download failed');
    } else {
      const d = path.join(dl, pack, path.dirname(file)); fs.mkdirSync(d, { recursive: true });
      const gpath = path.join(d, path.basename(file));
      if (get(url, gpath) <= 0) throw new Error('gltf download failed');
      const g = JSON.parse(fs.readFileSync(gpath, 'utf8'));
      const deps = [...(g.buffers || []).map(b => b.uri), ...(g.images || []).map(i => i.uri)].filter(u => u && !/^data:/.test(u));
      for (const u of deps) {
        const lp = path.join(d, decodeURIComponent(u));
        if (fs.existsSync(lp) && fs.statSync(lp).size > 0) continue;
        const uu = RAW + P[pack] + path.posix.join(path.posix.dirname(file), u);
        if (get(uu, lp) <= 0) throw new Error('dep failed ' + u);
      }
      execFileSync('node', [path.join(__dirname, 'pack.js'), gpath, dst]);
    }
    ok++; console.log('ok  ' + name.padEnd(16) + String(fs.statSync(dst).size).padStart(9));
  } catch (e) { bad.push(name + ': ' + e.message); console.log('BAD ' + name + ' ' + e.message); }
}
console.log('done', ok, 'ok,', bad.length, 'failed');
if (bad.length) console.log(bad.join('\n'));
