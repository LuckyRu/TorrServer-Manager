[CmdletBinding()]
param(
    [string]$TorrServerTag = '',
    [string]$OutputDirectory = '',
    [switch]$SkipTests,
    [switch]$NoGoBootstrap
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $repoRoot '.build'
$patchPath = Join-Path $repoRoot 'patches\torrserver-gstreamer-container-support.patch'
$torrServerLockPath = Join-Path $repoRoot 'config\torrserver-release.lock'
$torrServerRepository = 'YouROK/TorrServer'
$githubApiHeaders = @{ 'User-Agent' = 'TorrServerManager-build' }
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
            $pathGoVersion = (& $goCommand.Source version 2>$null | Select-String -Pattern 'go version go([0-9]+\.[0-9]+(?:\.[0-9]+)?)')
            if ($null -ne $pathGoVersion) {
                $pathVersion = [version]$pathGoVersion.Matches[0].Groups[1].Value
                if ($pathVersion -ge [version]$goVersion) {
                    Write-Host "Используется Go $($pathVersion.ToString()) из PATH."
                    return $goCommand.Source
                }
                Write-Host "Go $($pathVersion.ToString()) из PATH ниже требуемого Go $goVersion; загружается подходящий toolchain."
            }
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

function Resolve-GoVersion {
    param([Parameter(Mandatory = $true)][string]$ModuleFile)

    $goDirective = Select-String -Path $ModuleFile -Pattern '^\s*go\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$' |
        Select-Object -First 1
    if ($null -eq $goDirective) {
        throw "В $ModuleFile не найдено требование версии Go (директива go)."
    }

    $version = $goDirective.Matches[0].Groups[1].Value
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
        throw "В $ModuleFile указана неполная версия Go '$version'. Для автоматической загрузки нужна версия x.y.z."
    }
    return $version
}

function Resolve-TorrServerTag {
    param([string]$RequestedTag)

    if ([string]::IsNullOrWhiteSpace($RequestedTag)) {
        if (-not (Test-Path -LiteralPath $torrServerLockPath)) {
            throw "Не найден lock-файл релиза TorrServer: $torrServerLockPath"
        }
        $RequestedTag = (Get-Content -LiteralPath $torrServerLockPath -Raw).Trim()
    }

    if (-not [string]::IsNullOrWhiteSpace($RequestedTag) -and $RequestedTag -notmatch '^MatriX\.\d+(\.\d+)*$') {
        throw "Недопустимый тег TorrServer '$RequestedTag'. Разрешены только официальные теги MatriX.*."
    }

    $escapedTag = [Uri]::EscapeDataString($RequestedTag)
    $releaseUrl = "https://api.github.com/repos/$torrServerRepository/releases/tags/$escapedTag"

    Write-Host "Проверка официального релиза TorrServer: $releaseUrl..."
    try {
        $release = Invoke-RestMethod -Headers $githubApiHeaders -Uri $releaseUrl
    } catch {
        throw "Не удалось получить официальный релиз TorrServer из GitHub: $($_.Exception.Message)"
    }

    $resolvedTag = [string]$release.tag_name
    if ($resolvedTag -notmatch '^MatriX\.\d+(\.\d+)*$') {
        throw "Релиз TorrServer имеет недопустимый тег '$resolvedTag'. Разрешены только официальные теги MatriX.*."
    }
    if ($release.draft -or $release.prerelease) {
        throw "Релиз TorrServer '$resolvedTag' является draft/prerelease и не может использоваться для сборки."
    }
    return $resolvedTag
}

if (-not (Test-Path -LiteralPath $patchPath)) {
    throw "Не найден patch TorrServer: $patchPath"
}

$TorrServerTag = Resolve-TorrServerTag -RequestedTag $TorrServerTag
$sourceRoot = Join-Path $buildRoot "TorrServer-$TorrServerTag"
$serverModule = Join-Path $sourceRoot 'server'
if (Test-Path -LiteralPath $sourceRoot) {
    Remove-Item -LiteralPath $sourceRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

$archive = Join-Path $buildRoot "TorrServer-$TorrServerTag.zip"
$sourceUrl = "https://github.com/$torrServerRepository/archive/refs/tags/$TorrServerTag.zip"
Write-Host "Загрузка TorrServer release $TorrServerTag..."
Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $archive
Expand-Archive -LiteralPath $archive -DestinationPath $buildRoot -Force
if (-not (Test-Path -LiteralPath $serverModule)) {
    throw "В архиве TorrServer не найден server/: $serverModule"
}

$goVersion = Resolve-GoVersion -ModuleFile (Join-Path $serverModule 'go.mod')
$goRoot = Join-Path $repoRoot ".tools\go-$goVersion\go"
$goExe = Join-Path $goRoot 'bin\go.exe'
$go = Get-GoExecutable

Invoke-Native -FilePath 'git.exe' -Arguments @('apply', '--check', $patchPath) -WorkingDirectory $sourceRoot
Invoke-Native -FilePath 'git.exe' -Arguments @('apply', $patchPath) -WorkingDirectory $sourceRoot
Invoke-Native -FilePath $go -Arguments @('fmt', './gstreamer') -WorkingDirectory $serverModule
if (-not $SkipTests) {
    Invoke-Native -FilePath $go -Arguments @('test', '-tags=gst', './gstreamer') -WorkingDirectory $serverModule
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$serverOutput = Join-Path $outputRoot 'TorrServer.exe'
$ldflags = "-s -w -checklinkname=0 -X server/version.Version=$TorrServerTag"
Invoke-Native -FilePath $go -Arguments @('build', '-tags=nosqlite,gst', '-trimpath', "-ldflags=$ldflags", '-o', $serverOutput, './cmd') -WorkingDirectory $serverModule

$managerArguments = @('publish', 'TorrServerManager.csproj', '-c', 'Release', '-o', $outputRoot)
Invoke-Native -FilePath 'dotnet.exe' -Arguments $managerArguments -WorkingDirectory $repoRoot

Write-Host ""
Write-Host "Готово:" -ForegroundColor Green
Write-Host "  Manager:   $(Join-Path $outputRoot 'TorrServerManager.exe')"
Write-Host "  TorrServer: $serverOutput"
Write-Host "  Version:    $TorrServerTag"
Write-Host "  Release:    $TorrServerTag"
Write-Host "  Go:         $goVersion"
