# dev/

Tools that are not part of the game.

| File | What |
| --- | --- |
| `test.js` | Headless building / collision suite. `node dev/test.js` — loads the real engine, world and game code with a stubbed DOM and checks walls block at every frame rate, walls built through you push you out, falls land on floors, ramp decks are solid from below, cones are walkable, placement lands next to you, staircases chain, structures collapse when their base goes, and hillside placement works. |
| `gltest.html` | Renderer smoke test in a real WebGL2 context: terrain, textured pieces, props, an animated character with hand-slot axis markers. Open `http://localhost:3500/dev/gltest.html?anim=Running_A&upper=2H_Ranged_Aiming`. |
| `fetchpack.js` | Downloads the KayKit models the game uses from GitHub and packs each `.gltf` + `.bin` + texture into one `.glb` (`pack.js`). |
| `strip.js` | Trims a character `.glb` to the animation clips the game plays and drops the pack's melee weapons. |

## Screenshots without a browser window

The game has a screenshot mode: any `?auto=…` query starts a match, places the
player, steps the simulation without rendering, renders one frame and paints a
status line at the top. With headless Chrome:

```
chrome --headless=new --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader
  --window-size=1280,720 --virtual-time-budget=30000 --screenshot=out.png
  "http://localhost:3500/?auto=1&poi=0&ox=-20&oz=22&yaw=-0.6&give=ar&bots=3"
```

| Parameter | Meaning |
| --- | --- |
| `auto=1` / `auto=menu` / `auto=drop` | in-match / the menu backdrop / mid-skydive |
| `poi=N` `ox` `oz` or `x` `z` | where to stand (offset from a POI, or absolute) |
| `yaw` `pitch` | where to look |
| `give=ar&rar=3` `mats=500` | loadout |
| `bots=N&bdist=7` | park N armed bots in front, facing you |
| `build=2&place=1` | build mode with that piece, place it N times |
| `fp=1` `ads=1` `fire=1` `walk=1` | first person, aim, fire once, hold W during the sim steps |
| `front=3` / `side=3` | look at the player from in front / from the right |
| `steps=30` | simulation steps (1/30 s each) before the frame |
