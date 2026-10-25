$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }
& $csc -nologo -target:exe -platform:anycpu -optimize+ -out:(Join-Path $PSScriptRoot 'picker.exe') (Join-Path $PSScriptRoot 'picker.cs')
