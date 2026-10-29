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
40958196905. Windows tests use a native-response fixture; the device library
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
