{ upstream }:
let
  source = builtins.getFlake (toString upstream);
  original = source.packages.aarch64-darwin.librepaint-ios-app;
in original.overrideAttrs (old: {
  pname = "feather-krita-engine";
  postPatch = (old.postPatch or "") + ''
    cp -R ${./native} feather-native
    chmod -R u+w feather-native
    printf '\nadd_subdirectory(feather-native)\n' >> CMakeLists.txt
  '';
  buildTargets = [ "FeatherKritaEngine" ];
  preBuild = ''
    ninja -n FeatherKritaEngine > engine-build-plan.txt
    printf 'Native engine build command count: '
    wc -l < engine-build-plan.txt
    # Compile the adapter first so interface errors do not wait for all libraries.
    ninja feather-native/CMakeFiles/FeatherKritaEngine.dir/KritaBridge.cpp.o
  '';
  buildPhase = ''
    runHook preBuild
    cmake --build . --target FeatherKritaEngine --parallel "$NIX_BUILD_CORES"
    runHook postBuild
  '';
  doInstallCheck = false;
  preInstall = "";
  postInstall = "";
  preInstallCheck = "";
  postInstallCheck = "";
  installPhase = ''
    mkdir -p "$out/lib" "$out/resources/bundles" "$out/licenses"
    cp feather-native/FeatherKritaEngine.dylib "$out/lib/"
    cp engine-build-plan.txt "$out/"
    cp ../krita/data/bundles/Krita_4_Default_Resources.bundle "$out/resources/bundles/"
    cp -R ../krita/data/profiles "$out/resources/profiles"
    cp ../COPYING "$out/licenses/LibrePaint-COPYING"
    cp -R ../packaging/ios/notices "$out/licenses/notices"
    cp -R ../packaging/ios/manifests "$out/licenses/manifests"
    cp -R ../LICENSES "$out/licenses/SPDX"
  '';
})
