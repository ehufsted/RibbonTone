# RibbonTone

Turns an image into a buildable halftone made of hanging, twisted white ribbons
on a black background (or dark ribbons on a white one: a single toggle). A ribbon turned to face you covers most of its pitch and
reads light; turned edge-on it all but vanishes. Twisting each ribbon down its
length draws the image's tone.

You give it the image and the physical facts: ribbon width, spacing and
thickness, the material, the tension of the fixed bottom bar, the light, and
where the viewer stands. It chooses every bracket's angle, the direction of each
twist and, when spacing is uneven, the bracket heights. It keeps within the
twist-rate limit (the edges must not overstretch: about 150 mm per quarter turn
for a 20 mm ribbon) and your spacing and count limits.

## Run it

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

then open http://localhost:8080/. No installs; any static server works.

Tests: `powershell -ExecutionPolicy Bypass -File run-tests.ps1` (headless Chrome
or Edge), or open http://localhost:8080/verify.html.

## Brackets

- **Combs**: laser-cut strips with one angled slot per ribbon, one per shared
  row. Rows can be **even** or **bunched** where the image has detail.
- **Wall pins**: any of the above, or **each ribbon its own heights**, which
  gives the best image and no horizontal lines. Each bracket is a small flat T
  cut from sheet: a slotted clip at the ribbon's angle on a stem that plugs
  into the box's back panel.

## 3D view

The whole piece in 3D (WebGL): ribbons, the combs as solid or clear prisms (or,
with wall pins, the T-shaped clips), and an optional black box
around the back, sides, top and bottom, with shadows. Drag to orbit, right-drag to pan, wheel
or pinch to zoom. Presets include the design viewpoint, which matches the Preview.

## Outputs

- Combs as SVG or DXF (cut red, engrave blue; long combs split to fit the cutter bed).
- A bracket list as CSV: height, slot angle, and the twist since the bracket above (size and direction).
- A 1:1 wall template.
- With wall pins: the pin clips (SVG/DXF, packed for the cutter) and the back panel with a slot per clip.
- Plan JSON and a preview PNG.
- Calibration combs: photograph them under the real light and type the readings
  in as a measured brightness curve.

See [docs/architecture.md](docs/architecture.md) for the model and the solver.

## Licence

GPL-3.0 (see LICENSE).
