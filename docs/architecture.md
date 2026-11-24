# RibbonTone architecture

Same layering as HalftoneCuttable and Photo2Mosaic (standalone copies, no
cross-folder imports): `src/core/` is DOM-free maths, `src/pipeline.js` chains
it, `src/worker.js` runs the pipeline off the main thread, `src/app.js` is the
only DOM file. The harness (`verify.html`, `run-tests.ps1`) runs the core and
pipeline directly.

## Conventions

- Millimetres and degrees inside; inches only at the UI edge.
- y runs down from the top bar (y = 0) to the fixed bottom bar (y = H).
- A ribbon's angle θ is its face normal's direction in the horizontal plane:
  0 = facing the viewer, + = face turned to the viewer's right (clockwise
  seen from above). Both faces are white, so θ and θ + 180° look alike and one
  slot holds both. Angles in the plan are unwrapped, so consecutive brackets
  give the twist's size and direction.

## Pipeline

1. **Tone** (`core/units.js`): gamma and brightness → linear luminance.
2. **Piece** (`pieceGeometry`): the image covers W × H; ribbons centred at the pitch.
3. **Columns** (`core/target.js`): each ribbon's box [x ± p/2] × [y, y + dy],
   averaged in linear light from a summed-area table (exact on constant pixels).
4. **Brightness over a half turn** (`core/optics.js`), per ribbon, as a LUT:
   `Y = c·F + (1 − c)·Ybg` with coverage `c = (w|cos(θ−α)| + t|sin(θ−α)|)/(p cos α)`,
   face `F` = Lambert under a directional light plus ambient, plus a satin
   Blinn-Phong sheen. α is the direction to the viewer from that ribbon. A
   measured curve (`angle value` lines from the calibration combs) can replace it.
   Near edge-on an unlit face is darker than the backdrop, so the darkest angle
   comes a few degrees before 90°.
   The backdrop's share is darkened by the ribbons' own shadows on it
   (`backdropLit`): on the box's back wall (half a comb depth behind, or the pin
   stand-off), each ribbon's cross-section dropped along the light is an
   interval per pitch; the part of the visible gap it covers keeps only ambient
   light. Negligible on black, large on white.
   **Dark ribbons on a white backdrop** is the same model with the two
   reflectances swapped (the toggle swaps them; material presets then give a
   dyed-black ribbon, 0.05): face-on is now the darkest angle.
5. **Reachable range**: the image is mapped, in lightness (∛Y), onto
   [max of the ribbons' minima, min of their maxima]; contrast stretches first.
6. **Twist mechanics** (`core/twist.js`):
   - rate limit `κmax = (2/w)·√(2ε)` from the edge strain ε
     (0.55 % at 20 mm → 90° per 150 mm);
   - between brackets one torque runs down the span, `dθ/dy = M/k(y)`,
     `k = G·w·t³/3 + T(y)·w²/12`, `T(y) = T0 + λg(H − y)`, so the twist crowds
     toward each span's bottom and the limit applies to the **peak** rate;
   - coiling check: torque against 2√(B·T), B = E·w·t³/12.
7. **Solver** (`core/solve.js`), three exact dynamic programs:
   - *ideal path*: Viterbi over θ mod 180° (≤ 1° states), each sample turning at
     most κmax·dy either way. It is the best any bracket layout can do (the
     Ideal view) and guides the next two;
   - *bracket heights*: shortest path over a grid of candidate heights, spans
     within [least spacing, longest span], span cost = tone error of a ribbon
     running between the ideal path's end values along the tension profile; a
     price per bracket is bisected until the count fits. Shared rows sum every
     ribbon's span costs; per-ribbon heights run it per ribbon;
   - *bracket angles*: Viterbi over each bracket's angle (±30° around the ideal
     path, 1° steps) with the exact span cost, allowing a transition only if
     the span's peak rate is within κmax. Twist directions fall out of it.
   Ribbons are solved left to right; each passes a share ("Spread error") of
   its vertically blurred lightness error to the next, which the eye mixes.
8. **Twist directions** (`core/align.js`): during the solve, each ribbon's
   ideal path and angle DP carry a small cost (`solve.alignCost`, ALIGN_K per
   sample) for turning differently from (Align twists on, +1) or alike to
   (off, −1) the ribbon on its left. After it, each ribbon is kept or mirrored whole about
   the direction to the viewer (θ → 2α − θ: same look from the design
   viewpoint, same brackets, same rate), chosen exactly over the row. Measured
   on a viewer 1 m to either side (`offAxisDistortion`): on gives the fewest
   stripes and a steadier blend than no preference; off the steadiest blend
   but the most stripes. The Preview's Viewer slider shows any sideways position.
9. **Stats**: tone error (lightness ×100, sample by sample) and "as seen"
   (after mixing neighbours 1:2:1 and a pitch down the ribbon), with the ideal
   path's for comparison; brackets; the worst span's peak rate and coil ratio.

## Views and files

- Preview / Ideal: `core/render.js` projects each slice's ends onto the wall
  plane from the eye, shades the visible face, and ray-casts shadows from the
  ribbons two either side. The app fills each ribbon as one gradient polygon,
  farthest from the viewer first; the brightest face is white.
- Fabrication (`core/fab.js`): comb rows (slots along (cos θ, −sin θ) seen from
  above, FRONT at the viewer's edge, split at midpoints between ribbons to fit
  the cutter bed). Each comb is as deep as its own row needs (`rowDepth`: the
  farthest-reaching slot plus the margin front and back), centred on the
  ribbons' line; the box is as deep as the deepest, so the pipeline solves
  once with the deepest possible comb and again with the deepest that came out
  (the backdrop shadows depend on it). Comb ends carry tabs into slots in the
  side panels (`sidePanelPiece`, cut two). The optional split is a zigzag
  (`combLayout`): along each slot, peaks between ribbons (the back half gets a
  V at each ribbon); where a straight leg would cut back through a steep slot
  it first runs straight out of the slot's end (a dogleg, at least the least
  web long). With pins, the top and bottom bars are combs too. the bracket list CSV (slot angle and
  signed turn since the bracket above), a 1:1 wall template, the calibration
  combs. SVG and DXF (R12, y flipped) from the same shapes.

## 3D view

`core/scene.js` builds the geometry (DOM-free, tested); `app/view3d.js` draws it
with hand-written WebGL. World space: x as on the piece, y up, z toward the
viewer, ribbons' centre lines at z = 0.

- Ribbons: strips cut at every bracket and about every 2° of turn, with the
  cross-section `render.js` projects.
- Combs: solid prisms (comb length × comb depth × sheet thickness) that the
  ribbons simply pass through; the depth buffer hides the part inside, which
  reads as a slot. Slot outlines are drawn on both faces. Solid (any colour) or
  clear acrylic (blended, no depth write, farthest first, back faces then front:
  so prism triangles must wind counter-clockwise from outside, which a test checks).
- Pins: the top and bottom bars stay combs; every bracket between them is a
  pin clip (`fab.clipShapes`): a flat T cut from the comb sheet. The crossbar
  is the slot plus `clipWall` all round, turned to the ribbon's angle; the stem
  (80 % of the clip's width) runs straight back to the wall and on through the
  back panel as a tab. The stem's end is cut parallel to whichever face of the
  clip it meets, half a clip wall short of the slot, so a straight line always
  separates stem and slot (a square end clipped the slot's corner on tilted
  clips). The cut path is the union of the two convex shapes (Weiler–Atherton);
  the harness checks every whole degree. Cut files: the clips packed across the
  cutter bed, labelled ribbon.bracket along the stem, and the back panel with a
  slot for each stem.
- Box: back, sides, top and bottom, open at the front. Its depth is the combs';
  the combs mount to its sides; with pins the back wall is the stand-off past
  a ribbon turned end-on (w/2 + stand-off behind the centre line).
- Shading is the optics model (Lambert + sheen, same light, same exposure), so
  the design-viewpoint preset matches the 2D Preview.
- Shadows: a shadow map (RGBA-packed depth, WebGL 1), orthographic from the
  light over the scene's bounds, 3 × 3 samples, a normal offset of 1.5 texels
  so the thin ribbons do not shadow themselves. Only direct light and sheen are
  shadowed. Redrawn when the scene, light or casters change, not per frame.
  Clear combs cast none.
- What the 3D view shows that the solver does not model: the COMBS' shadows. A
  solid comb, lit from above, shades a band of ribbon and backdrop below it
  (about (D/2 − z)·Ly/Lz deep). Clear combs avoid most of it.
- A WebGL canvas cannot be a 2D canvas too, so the 3D view has its own canvas.
  Headless checks need `--use-angle=swiftshader --enable-unsafe-swiftshader`.

## Verification

`run-tests.ps1` (port 8098) runs `verify.html` headless: optics, twist, target
sampling, the three DPs (two against brute force / exhaustive search), the
renderer's projections and shadows, fabrication geometry (including SVG/DXF
angle agreement), projects, and the pipeline's limits and layouts.

## Deferred

Heat-set jigs, 3D-printed ribbons (a continuous-profile mode: the ideal path is
already it), plastically twisted metal strips, several viewpoints at once,
colour, a photo reader for the calibration curve, shadows across slices.
3D view: hover picking, a walk-by slider, an assembly
slider, a section plane, OBJ export, cutting files for the pin tabs.
