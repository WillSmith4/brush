param(
    [Parameter(Mandatory=$true)][string]$LLVM,
    [Parameter(Mandatory=$true)][string]$SDK,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$taskObject = Join-Path $OutputDirectory 'Overlay.o'
$taskDylib = Join-Path $OutputDirectory 'FeatherKritaOverlay.dylib'
$taskCryptex = Join-Path $SDK 'System\Cryptexes\OS\System\Library\Frameworks'
& (Join-Path $LLVM 'clang.exe') -target arm64-apple-ios17.0 -isysroot $SDK -F $taskCryptex -fobjc-arc -fblocks -O2 -Wall -Wextra -Wno-unused-parameter -c (Join-Path $taskRoot 'native\Overlay.m') -o $taskObject
if ($LASTEXITCODE -ne 0) { throw 'Overlay compilation failed' }
& (Join-Path $LLVM 'ld64.lld.exe') -dylib -arch arm64 -platform_version ios 17.0 17.5 -syslibroot $SDK -F $taskCryptex -install_name '@rpath/FeatherKritaOverlay.dylib' -no_adhoc_codesign -o $taskDylib $taskObject -framework UIKit -framework Foundation -framework QuartzCore -framework CoreGraphics -framework WebKit -framework UniformTypeIdentifiers -lobjc -lSystem
if ($LASTEXITCODE -ne 0) { throw 'Overlay linking failed' }
Get-FileHash -LiteralPath $taskDylib -Algorithm SHA256
