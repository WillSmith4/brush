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

Selecting or hovering an injected brush warms a small native-rendered tip cache.
Pencil events can display a textured tip trail synchronously while the exact
native stroke is still rendering. The fast tip trail is a provisional preview;
the full preset dynamics come from the native stroke result. Preview startup
does not depend on a timer firing while the Pencil is held down. Saved artwork
continues to use the complete native result, with independent undo and editing.

Feather densifies spline positions without densifying its source normals. The
adapter resamples those normals before building live paint, preventing undefined
values from aborting preview. For strokes contacting a curved Guide, paint uses
the Guide's actual triangles and a local raster projection instead of tangent
quads that can cut through the support. The contacted patch is saved with the
stroke, so reopening it without the Guide preserves its surface. The provisional
tip preview uses that same support while drawing. Existing PNG paint is retained.

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
40975781948. Windows tests use a native-response fixture; the device library
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
