# Native Krita brush integration

The integration renders Krita brush strokes into textures and maps those textures
onto the host application's existing 3D stroke geometry. A movable native menu
imports brush resources, chooses one of six host brush types, enables a binding,
and restores the original appearance. Import uses the system document picker.

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
- `tests/` checks reversible geometry integration and stroke input mapping.

Run the JavaScript contracts with `npm ci --ignore-scripts && npm test`.
Device compilation and static binary inspection are separate gates. A successful
dependency build alone does not verify the renderer or demonstrate operation on
an iPad. Native engine integration is still undergoing build validation.

The host-specific binary and frontend packaging are performed locally. Original
application executables, source bundles, user documents, and credentials are not
included in this repository.

Imported resources are copied to application support storage. Bindings are local
to the modified application; the host document format is preserved. Contextual
2D operations such as smudging sample the generated stroke texture, not a
flattened image of the entire 3D scene. Exported host documents do not embed the
Krita brush bundle through this adapter.

LibrePaint and its dependencies retain their upstream licenses. Integration code
is GPL-3.0-or-later. The menu reference assets are identified separately in
`assets/provenance.json`; they are not represented as original integration artwork.
