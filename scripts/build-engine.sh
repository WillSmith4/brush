#!/usr/bin/env bash
set -euo pipefail
test -d upstream/.git
test "$(git -C upstream rev-parse HEAD)" = e9946cce637d66003ca1b22dd9141db78f177cef
nix build --impure --print-build-logs --out-link build/engine \
  --expr "import ./engine.nix { upstream = $(pwd)/upstream; }"
mkdir -p artifacts
cp build/engine/lib/FeatherKritaEngine.dylib artifacts/
xcrun --sdk iphoneos nm -gU artifacts/FeatherKritaEngine.dylib > artifacts/engine-exports.txt
grep -q ' _FKRenderAsync$' artifacts/engine-exports.txt
grep -q ' _FKRequest$' artifacts/engine-exports.txt
grep -q ' _FKFreeResponse$' artifacts/engine-exports.txt
xcrun --sdk iphoneos vtool -show-build artifacts/FeatherKritaEngine.dylib > artifacts/engine-platform.txt
grep -q 'minos 17.0' artifacts/engine-platform.txt
tar -C build/engine -czf artifacts/FeatherKritaEngine-resources.tar.gz resources licenses
