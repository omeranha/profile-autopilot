$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectDir = $PSScriptRoot
$manifest = Get-Content (Join-Path $projectDir 'package.json') -Raw | ConvertFrom-Json
$outputPath = Join-Path $projectDir "$($manifest.name)-$($manifest.version).vsix"

$vsixManifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($manifest.name)" Version="$($manifest.version)" Publisher="$($manifest.publisher)" />
    <DisplayName>$($manifest.displayName)</DisplayName>
    <Description xml:space="preserve">$($manifest.description)</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types>
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
"@

$entries = @{
    '[Content_Types].xml'    = [System.Text.Encoding]::UTF8.GetBytes($contentTypes)
    'extension.vsixmanifest' = [System.Text.Encoding]::UTF8.GetBytes($vsixManifest)
    'extension/package.json' = [System.IO.File]::ReadAllBytes((Join-Path $projectDir 'package.json'))
}
Get-ChildItem $projectDir -Filter '*.js' | ForEach-Object { $entries["extension/$($_.Name)"] = [System.IO.File]::ReadAllBytes($_.FullName) }

if (Test-Path $outputPath) { Remove-Item $outputPath }
$stream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::CreateNew)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($name in $entries.Keys) {
    $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    $entryStream.Write($entries[$name], 0, $entries[$name].Length)
    $entryStream.Dispose()
}
$archive.Dispose()
$stream.Dispose()
Write-Output $outputPath
