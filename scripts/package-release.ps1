[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$BuildDirectory = 'build',
    [string]$OutputDirectory = 'release'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    throw 'CMake was not found. Run this script in Developer PowerShell for Visual Studio 2022.'
}

cmake -S . -B $BuildDirectory -G 'Visual Studio 17 2022' -A x64 -DRELAY_BUILD_TESTS=ON
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed.' }

cmake --build $BuildDirectory --config $Configuration --parallel --target RelayBridge relay_protocol_tests
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

ctest --test-dir $BuildDirectory -C $Configuration --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }

$exe = Get-ChildItem -Path $BuildDirectory -Recurse -Filter RelayBridge.exe | Select-Object -First 1
if ($null -eq $exe) { throw 'RelayBridge.exe was not produced.' }

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Copy-Item $exe.FullName (Join-Path $OutputDirectory 'RelayBridge.exe') -Force
Copy-Item README.md (Join-Path $OutputDirectory 'README.md') -Force
Compress-Archive -Path (Join-Path $OutputDirectory 'RelayBridge.exe'), (Join-Path $OutputDirectory 'README.md') `
    -DestinationPath (Join-Path $OutputDirectory 'RelayBridge-windows-x64.zip') -Force

Write-Host "Ready: $(Join-Path $OutputDirectory 'RelayBridge.exe')"
Write-Host "Package: $(Join-Path $OutputDirectory 'RelayBridge-windows-x64.zip')"
