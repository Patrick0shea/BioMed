# BioMed simulators

Two browser-based 3D simulations, linked by tabs at the top of each page:

| Page | What it shows |
|---|---|
| **Laparoscopic entry** — `index.html` | LapSim: interactive laparoscope insertion through the abdominal wall, with a live scope feed and results. |
| **Anastomosis probe** — `probe.html` | ProbeSim: animated transanal balloon-probe procedure — assembly, insertion to the red line, balloon inflation at the anastomosis, button sequence, deflation and removal. |

Runs fully offline — three.js is bundled in `vendor/`.

## ProbeSim — anastomosis balloon probe

A step-by-step animation in the same 3D style as LapSim (translucent patient, internal
anatomy), with the patient in lithotomy position:

1. **Assemble the probe** — handle, balloon, atraumatic tip and inflation line fit onto the marked shaft (labelled).
2. **Grip & power on** — a gloved hand grips the handle; the thumb presses **button 1** and the status light turns green.
3. **Position at anal verge** — the probe is brought in line with the rectum.
4. **Insert to the red line** — the probe advances until the red line sits at the anal verge; the balloon is then level with the anastomosis (9 cm).
5. **Inflate the balloon** — thumb presses **button 2**; the balloon expands and the rectal wall bulges at the anastomosis.
6. **Hold** at the anastomosis.
7. **Deflate the balloon** — thumb presses **button 3**.
8. **Withdraw the probe.**

The bottom panel is a fixed close-up with a sagittal cutaway of the rectum so the probe,
red line and balloon can be seen inside. The right panel shows tip depth, red-line
distance, balloon diameter/volume/pressure, button states and a time-stamped event log.

**Controls:** play/pause (`Space`), previous/next step (`←`/`→`), restart (`R`), click a
step to jump to it, drag the timeline, 0.5×/1×/2× speed, loop, auto camera (turns off
when you orbit), cutaway (`C`), labels, show/hide hand, skin opacity.

**Changing the device:** every dimension (shaft, balloon size, red-line position, handle,
button positions/colours/names) is in the `PROBE` object at the top of `js/probeModel.js`.
The step order, timings and captions are the `PHASES` list in `js/probe.js`.

The hand is the MIT-licensed WebXR "generic hand" model (`assets/hand-right.glb`, licence
in `assets/HAND-MODEL-LICENSE.md`), posed procedurally to wrap the handle and solve the
thumb position for each button.

## LapSim — laparoscopic entry

A browser-based 3D simulation of a laparoscope being inserted into an insufflated abdomen.
Pick a port site, push the scope through the abdominal wall, and watch both the
laparoscope camera feed and the results: tissue layers crossed, organs in view, distance
to the nearest structures, contacts, injuries, and a session log you can export.

## Run it on localhost

The page uses ES modules, so it has to be served over HTTP (opening `index.html` directly
from disk won't work).

**Python (macOS / Linux / Windows):**

```bash
cd lap-sim
python3 -m http.server 8000
```

Then open <http://localhost:8000> (LapSim) or <http://localhost:8000/probe.html> (ProbeSim).

Or use the helper script: `./start.sh` (macOS/Linux) or `start.bat` (Windows).

**Node alternative:** `npx serve -l 8000` from inside the folder.

Any modern desktop browser with WebGL 2 works (Chrome, Edge, Firefox, Safari).

## Deploy on Vercel

It's a plain static site — no build step, no dependencies.

1. In Vercel, **Add New → Project** and import this GitHub repository.
2. Leave **Framework Preset** as **Other**, the root directory as `./`, and the build and
   output settings empty.
3. **Deploy.** Every push to `main` redeploys automatically.

## What you see

| Panel | Contents |
|---|---|
| **Laparoscope monitor** | Live feed from the scope tip: circular optic, barrel distortion, the scope's own light with inverse-square falloff and auto-gain, sensor grain. In the wall it shows the tissue layer you're in; touching tissue gives a red-out; injuries bleed into the field; a cold scope fogs on entry. |
| **External view** | Patient on the table with a translucent skin, the trocar, scope shaft, field-of-view cone, port sites and the trajectory along the shaft axis (yellow → orange → red as it nears a structure). Drag to orbit, scroll to zoom. |
| **Tip readout** | Tissue/space, abdominal region, wall thickness at the port, intra-abdominal length, angle to the wall normal, first structure on the shaft axis, structure at the centre of view. |
| **Nearest structures** | Live distances from the tip to the five closest structures. |
| **Field of view** | What fraction of the image each structure occupies (ray-cast through the scope camera). |
| **Session results** | Cavity entries, tissue contacts, injuries, max depth, time in cavity, tip path length, structures visualised, plus **Export results (JSON)**. |
| **Event log** | Time-stamped layer transitions, peritoneal entry, proximity warnings, contacts, injuries. |

## Controls

| Input | Action |
|---|---|
| Insertion depth slider, `W`/`S`, or scroll on the monitor | Advance / withdraw |
| Tilt sliders, arrow keys, or drag on the monitor | Pivot the scope about the port (fulcrum) |
| `Q` / `E` or light-post slider | Rotate a 30° optic's viewing direction |
| `1`–`5` | Port: umbilical, Palmer's point, right subcostal, left iliac fossa, suprapubic |
| `M` | Large monitor |
| `X` | Suction / irrigate (clears blood and fog) |
| `R` | Withdraw scope |

Patient settings: insufflation pressure (0–20 mmHg changes the size of the pneumoperitoneum
and the clearance under the wall) and BMI (changes subcutaneous fat thickness).

## How it works

- `js/anatomy.js` — the cavity and organs (liver, gallbladder, stomach, spleen, colon,
  appendix, small bowel, greater omentum, bladder, aorta/iliacs, IVC, falciform ligament).
  Each organ is defined by signed-distance primitives (ellipsoids, tubes, sheets); the
  meshes are generated from the same primitives, so the proximity/contact maths matches
  what's drawn. Sphere tracing over those fields powers the field-of-view analysis and
  "ahead on axis" readouts.
- `js/main.js` — port geometry and wall layers, scope kinematics (pivoting at the port,
  0°/30° optics), the contact/injury state machine (including sweeping the path between
  frames so a fast move can't skip through an organ), UI, and the two-viewport renderer.
- `js/scopePost.js` — the monitor's post-processing shader.
- `js/textures.js` — procedural, tileable tissue textures drawn on canvas.
- `js/probe.js`, `js/probeModel.js`, `js/hand.js` — ProbeSim scene and timeline, the probe model, and the posable gripping hand.

Coordinates are in centimetres: +y anterior, −z cranial, +x patient's left.

## Thresholds used

| Distance from tip to surface | Status |
|---|---|
| > 3 cm | clear |
| 1–3 cm | caution |
| 0.12–1 cm | close |
| ≤ 0.12 cm | contact |
| ≤ −0.4 cm (inside) | injury (organ-specific outcome; major vessels end the session as critical) |

## Disclaimer

Anatomy, tissue thicknesses, pressures and injury thresholds are simplified for teaching and
demonstration. This is not a validated surgical training device or a clinical tool.
