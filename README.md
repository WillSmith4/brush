# Native brush integration build

This repository builds the open-source LibrePaint/Krita iOS dependencies needed
for an in-process brush rendering bridge. The upstream revision is pinned to
`e9946cce637d66003ca1b22dd9141db78f177cef`.

The first build establishes the unmodified upstream iOS development environment
with Xcode 26.6, iPhoneOS SDK 26.5 and the upstream iOS 17.0 deployment target.
The renderer bridge and application integration are subsequent build targets.
This dependency build alone is not a working brush integration.

Proprietary application executables, resources, user documents and credentials
are not build inputs to this repository. Final application packaging is local.

LibrePaint and its dependencies retain their upstream licenses. Integration
source derived from LibrePaint will retain its SPDX notices and compatible license.

