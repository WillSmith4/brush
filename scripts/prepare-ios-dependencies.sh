#!/usr/bin/env bash
set -euo pipefail

revision=e9946cce637d66003ca1b22dd9141db78f177cef
mkdir -p upstream artifacts
git -C upstream init -q
git -C upstream remote add origin https://github.com/serika12345/librepaint.git
git -C upstream fetch --depth=1 origin "$revision"
git -C upstream checkout --detach FETCH_HEAD
test "$(git -C upstream rev-parse HEAD)" = "$revision"

test "$(uname -m)" = arm64
xcodebuild -version | tee artifacts/xcode.txt
xcrun --sdk iphoneos --show-sdk-version | tee artifacts/sdk.txt
xcode_description="$(xcodebuild -version)"
test "${xcode_description%%$'\n'*}" = 'Xcode 26.6'
test "$(xcrun --sdk iphoneos --show-sdk-version)" = '26.5'

# GitHub's Xcode.app is a symlink. Declare its canonical destination so the
# Darwin sandbox grants access to the same pinned Xcode installation.
python3 - <<'PY'
from pathlib import Path
import json
p = Path('upstream/nix/ios/toolchain.nix')
original = 'impureHostDeps = [\n    xcodeApp\n  ];'
text = p.read_text()
assert text.count(original) == 1
actual = str(Path('/Applications/Xcode.app').resolve())
assert actual == '/Applications/Xcode_26.6.app', actual
p.write_text(text.replace(original, 'impureHostDeps = [\n    xcodeApp\n    ' + json.dumps(actual) + '\n  ];'))
PY

# Evaluate one source-independent profile for the entire dependency build.
cd upstream
nix develop --print-build-logs --profile "$RUNNER_TEMP/brush-ios-profile" \
  .#librepaint-ios-incremental-env \
  --command bash -c 'cmake --version; ninja --version; xcrun --sdk iphoneos clang++ --version' \
  2>&1 | tee ../artifacts/dependencies.log
printf '%s\n' "$revision" > ../artifacts/upstream-revision.txt
nix-store --query --requisites "$RUNNER_TEMP/brush-ios-profile" > ../artifacts/dependency-paths.txt
