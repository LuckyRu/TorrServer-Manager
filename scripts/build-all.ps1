[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$TorrServerCommit = 'd442a8b4500568ddd2d7647c7b1f72f073b79ea9',
    [string]$OutputDirectory = '',
    [switch]$SkipTests,
    [switch]$NoGoBootstrap
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $repoRoot '.build'
$sourceRoot = Join-Path $buildRoot "TorrServer-$TorrServerCommit"
$serverModule = Join-Path $sourceRoot 'server'
$patchPath = Join-Path $repoRoot 'patches\torrserver-gstreamer-container-support.patch'
$goVersion = '1.25.7'
$goRoot = Join-Path $repoRoot ".tools\go-$goVersion\go"
$goExe = Join-Path $goRoot 'bin\go.exe'
$outputRoot = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    Join-Path $repoRoot 'publish'
} else {
    [IO.Path]::GetFullPath($OutputDirectory)
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [Parameter(Mandatory = $false)][string]$WorkingDirectory = $repoRoot
    )

    Write-Host "> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath завершился с кодом $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Get-GoExecutable {
    if (Test-Path -LiteralPath $goExe) {
        return $goExe
    }

    if (-not $NoGoBootstrap) {
        $goCommand = Get-Command go.exe -ErrorAction SilentlyContinue
        if ($null -ne $goCommand) {
            return $goCommand.Source
        }
    }

    if ($NoGoBootstrap) {
        throw "Go $goVersion не найден. Установите Go и повторите запуск без -NoGoBootstrap."
    }

    $toolsRoot = Split-Path $goRoot -Parent
    $bootstrapRoot = Join-Path $toolsRoot "go-bootstrap-$goVersion"
    $archive = Join-Path $toolsRoot "go$goVersion.windows-amd64.zip"
    New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
    if (-not (Test-Path -LiteralPath $archive)) {
        $url = "https://go.dev/dl/go$goVersion.windows-amd64.zip"
        Write-Host "Загрузка Go $goVersion..."
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
    }

    if (Test-Path -LiteralPath $bootstrapRoot) {
        Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $bootstrapRoot -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $goRoot -Parent) | Out-Null
    if (Test-Path -LiteralPath $goRoot) {
        Remove-Item -LiteralPath $goRoot -Recurse -Force
    }
    Move-Item -LiteralPath (Join-Path $bootstrapRoot 'go') -Destination $goRoot
    Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force
    return $goExe
}

if (-not (Test-Path -LiteralPath $patchPath)) {
    throw "Не найден patch TorrServer: $patchPath"
}

$go = Get-GoExecutable
if (Test-Path -LiteralPath $sourceRoot) {
    Remove-Item -LiteralPath $sourceRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

$archive = Join-Path $buildRoot "TorrServer-$TorrServerCommit.zip"
$sourceUrl = "https://github.com/YouROK/TorrServer/archive/$TorrServerCommit.zip"
Write-Host "Загрузка TorrServer commit $TorrServerCommit..."
Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $archive
Expand-Archive -LiteralPath $archive -DestinationPath $buildRoot -Force
if (-not (Test-Path -LiteralPath $serverModule)) {
    throw "В архиве TorrServer не найден server/: $serverModule"
}

Invoke-Native -FilePath 'git.exe' -Arguments @('apply', '--check', $patchPath) -WorkingDirectory $sourceRoot
Invoke-Native -FilePath 'git.exe' -Arguments @('apply', $patchPath) -WorkingDirectory $sourceRoot
Invoke-Native -FilePath $go -Arguments @('fmt', './gstreamer') -WorkingDirectory $serverModule
if (-not $SkipTests) {
    Invoke-Native -FilePath $go -Arguments @('test', '-tags=gst', './gstreamer') -WorkingDirectory $serverModule
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$serverOutput = Join-Path $outputRoot 'TorrServer.exe'
Invoke-Native -FilePath $go -Arguments @('build', '-tags=nosqlite,gst', '-trimpath', '-ldflags=-s -w -checklinkname=0', '-o', $serverOutput, './cmd') -WorkingDirectory $serverModule

$managerArguments = @('publish', 'TorrServerManager.csproj', '-c', 'Release', '-o', $outputRoot)
Invoke-Native -FilePath 'dotnet.exe' -Arguments $managerArguments -WorkingDirectory $repoRoot

Write-Host ""
Write-Host "Готово:" -ForegroundColor Green
Write-Host "  Manager:   $(Join-Path $outputRoot 'TorrServerManager.exe')"
Write-Host "  TorrServer: $serverOutput"
Write-Host "  Source:    $TorrServerCommit"
