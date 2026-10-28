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
  doInstallCheck = false;
  preInstall = "";
  postInstall = "";
  preInstallCheck = "";
  postInstallCheck = "";
  installPhase = ''
    mkdir -p "$out/lib" "$out/resources/bundles" "$out/licenses"
    cp feather-native/FeatherKritaEngine.dylib "$out/lib/"
    cp ../krita/data/bundles/Krita_4_Default_Resources.bundle "$out/resources/bundles/"
    cp ../COPYING "$out/licenses/LibrePaint-COPYING"
    cp -R ../packaging/ios/notices "$out/licenses/notices"
    cp -R ../packaging/ios/manifests "$out/licenses/manifests"
    cp -R ../LICENSES "$out/licenses/SPDX"
  '';
})
