# Native Krita brush integration

The integration renders Krita brush strokes into flat surfaces cut to the actual
paint footprint, including disconnected tip regions and holes. Isotropic pixel
coordinates keep brush textures from wrapping around the host's six tube shapes.
A movable native menu imports brush resources, chooses one of six host brush
types, enables a binding, and restores the original tool for subsequent strokes.
Import uses the system document picker.

Each newly drawn stroke owns its preset and baked raster. Inject never retouches
an existing stroke, and Restore keeps completed paint. Atomic files in application
support retain these records through history replay and reopening. Individual
stroke copies inherit the baked image. Host edits, visibility, and selection
transforms continue to apply to the generated surface.

Color Smudge, Filter, and MyPaint engines receive an offscreen rendering of the
visible artwork under the brush, including original host strokes and earlier
Krita surfaces. Native Krita operates on that substrate. Only changed pixels form
the new surface; sampled depth keeps paint on the visible substrate. This is
painting on the visible projected surface, not volumetric mixing of hidden faces.

Capture temporarily aligns Feather's explicit fragment-depth uniforms with the
sampling camera and restores them afterward. Disconnected substrate depths do
not form bridging triangles. Older v2 paint keeps its saved raster but ignores
the mixed-camera depth map when rebuilding its surface; its saved data is kept.

Apple Pencil Hover uses the native preset's cursor outline at the selected brush
size and surface orientation. It does not create strokes or sample the canvas.
Switching presets updates the outline, Pencil-down hides it, and Restore returns
to the host preview. The existing host hover capability and cursor preference
still control when the preview appears.

Unchanged stroke meshes survive new drawing operations. Geometry generation
yields in batches, and alpha coverage keeps fine brush-tip detail on a bounded
mesh. Live drawing retains the most recent completed Krita image while coalescing
incoming Pencil updates; original Feather tubes are hidden immediately only for
injected types. Preview points come directly from the drawing path.

Transparent Krita paint uses source-over compositing without writing depth, in
a stable per-stroke order. Opaque scene surfaces still occlude paint. Smudge
captures color first and obtains substrate depth in a separate pass, so paint
layers do not reject one another while accumulating opacity.
The host shader writes linear fragment depth explicitly, so paint applies its
small surface separation in that shader instead of relying on polygon offset.
This prevents a single stroke from fighting its drawing support. The depth bias
is disabled during smudge capture and restored afterward.

Live drawing uses one persistent native brush stroke with the preset's paintop,
pressure, spacing and random state retained. Each stable spline sample is sent
once, in batches of at most 64. The mutable trailing Catmull-Rom segment waits
for its next control point or Pencil-up. The drawing plane and pixel scale are
fixed for the gesture rather than recomputed from an expanding stroke rectangle.
The camera-facing plane projects the visible drawing surface; Guide triangles
and sampled substrate depth place the painted pixels back in the scene.

Injected input now enters a separate preview path before the host builds its
tube geometry. It keeps the host's cached surface projection, spline, pressure,
mirroring and material settings, and uses a small constant material template.
While rendering is busy, only the latest Pencil input waits. The hidden host
tube and per-vertex adapter metadata are not rebuilt for every input event.
Ordinary, uninjected tools continue through the original host input path.

The native renderer submits paint jobs on a serial background queue. Dirty
regions are tracked on its paint layer. Only changed 256px tiles (with a 1px
sampling border) are returned, at most 16 per packet. RGBA bytes and a one-byte
coverage mask travel through
the app's local resource handler. A small result token replaces two base64 PNGs
in the WebKit reply. Raw pixels go directly into GPU data textures; live paint
does not run PNG compression, base64 encoding, image decode or canvas readback.
Pencil-up finishes the same native paint session, but displayed artwork retains
the exact live tiles and their captured surface geometry. Tiles are stored as
immutable records in `StrokeTiles-v1`; the existing stroke record contains their
IDs and the legacy baked PNG fallback. Rendering uses the tiles, so a large
stroke is not visibly replaced by a resampled whole-stroke raster. Existing
documents and already painted strokes are not rerendered.

At Pencil-up, the finished host curve immediately adopts the existing live
meshes. The curve owns their visibility, transforms and lifetime while the last
samples and immutable tile records finish saving. This first handoff does not
read tiles back from disk, decode them again or build a second visible mesh set.
Undo/removal detaches paint immediately even if storage is still pending.
The reusable Pencil mesh is released at handoff, and finished paint reads
uniforms from its document curve instead of the next gesture's preview mesh.
Concurrent host geometry pools share one finalization/save operation, preserving
the original host-path baseline. Geometry serialization yields in short batches.
Geometry, UVs, coverage, depth bias and tile-border clipping survive the handoff
and reopening, even if the drawing Guide is no longer available for raycasts.
For a Guide tile, texture updates keep its already chosen surface instead of
reselecting a support during finalization. Copies share immutable tile files;
transforms/visibility continue through the host curve. Stroke history retains
these files just like the existing per-stroke sidecars.

Earlier prefix-render APIs remain available to older adapters. Current drawing
uses explicit sequence numbers and new samples, so changing stroke bounds cannot
trigger a replay of earlier paint. Smudge seeds each newly visited substrate tile
once and continues mixing on the existing native layer. A spatial index bounds
surface lookup for dirty tiles; fixed Guide meshes survive texture updates.
The sparse native working surface is 16384 pixels per side at 128 pixels per
brush diameter; leaving that working area reports an error instead of silently
dropping paint. Actual device latency and complex presets still require testing.

Feather densifies spline positions without densifying its source normals. The
adapter resamples those normals before building live paint, preventing undefined
values from aborting preview. For strokes contacting a curved Guide, paint uses
the Guide's actual triangles and a local raster projection instead of tangent
quads that can cut through the support. The contacted patch is saved with the
stroke, so reopening it without the Guide preserves its surface. Native preview
uses that same support while drawing. Existing PNG paint is retained.

Live previews reuse their mesh, material, and GPU buffer capacity, growing the
buffers only when needed. Raster and geometry are updated together; a newer
partial path never stretches an older result. Superseded preview textures are
released immediately. Identical input fragments and native render requests are
cached. Coverage scanning, spatial indexing, and mesh generation yield in short
batches, including while Pencil is down. Shared mesh corners reuse the same
surface calculation, and unchanged Guide faces skip nearest-path searches and
pixel scanning that cannot affect their geometry. The native brush resolution,
sampling, preset dynamics, and final paint representation remain unchanged.

The saved streaming record retains its working frame and painted path, plus the
host path needed to recognize unchanged curves on reopen. Frozen tile surfaces
therefore come from the displayed live meshes rather than a second surface
reconstruction at Pencil-up.

The native asynchronous render entry point prepares resources on Qt's owner
thread, then waits for Krita and encodes output on a background queue. Completion
and image cleanup return to the owner thread. Stroke files use a separate serial
storage queue. Full-pressure paint size is normalized to the unchanged cursor
outline; native pressure dynamics remain active. Injected presets receive raw
normalized Pencil pressure instead of Feather's shape-dependent scaling.

The native engine is built from LibrePaint revision
`e9946cce637d66003ca1b22dd9141db78f177cef`, with its Krita paint operators,
resource loaders, color management, and stroke scheduler. The build uses Xcode
26.6, iPhoneOS SDK 26.5, and an iOS 17.0 deployment target. The adapter initializes
Qt's minimal platform so it does not create the host application's window.

- `native/KritaBridge.cpp` owns resource import and native rasterization.
- `native/Overlay.m` owns the menu, system file picker, and WebKit messages.
- `web/brush-runtime.js` owns texture coordinates, host geometry visibility,
  stale-result handling, and restoration.
- `engine.nix` and the workflows build and inspect the device library.
- `tests/` checks stroke lifetime, per-stroke persistence, flat geometry, and input mapping.

Run the JavaScript contracts with `npm ci --ignore-scripts && npm test`.
Device compilation and static binary inspection are separate gates. A successful
dependency build alone does not verify the renderer or demonstrate operation on
an iPad. The revised native engine compiled successfully in Actions run
41273639724 (streaming engine). Run 41270803291 supplied the intermediate raw
transport implementation and was not delivered as the real-time fix.
Windows tests use a native-response fixture; the device library
cannot execute there. Actual brush appearance and mixing need an iPad run.

The host-specific binary and frontend packaging are performed locally. Original
application executables, source bundles, user documents, and credentials are not
included in this repository.

Imported resources and finished stroke records are local to application support;
the original host document format is preserved. Exporting a host document alone
does not embed those records or the Krita brush bundle. Keep the application data
when updating. Legacy v1 strokes lacked individual preset records, so their
original per-stroke Krita identity cannot be recovered automatically.

LibrePaint and its dependencies retain their upstream licenses. Integration code
is GPL-3.0-or-later. The menu reference assets are identified separately in
`assets/provenance.json`; they are not represented as original integration artwork.
