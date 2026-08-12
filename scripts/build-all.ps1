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
$torrServerSubmodulePath = Join-Path $repoRoot 'external\TorrServer'
$officialTorrServerRepository = 'YouROK/TorrServer'
$expectedSubmodulePath = 'external/TorrServer'
$torrServerReleaseTagPattern = '^(?<upstream>MatriX\.\d+(?:\.\d+)+)-TorrentMod\.(?<downstream>\d+(?:\.\d+)*)$'
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

function Invoke-NativeOutput {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [Parameter(Mandatory = $false)][string]$WorkingDirectory = $repoRoot
    )

    Push-Location $WorkingDirectory
    try {
        $output = & $FilePath @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath завершился с кодом ${LASTEXITCODE}: $($output -join ' ')"
        }
        return ($output -join "`n").Trim()
    } finally {
        Pop-Location
    }
}

function Assert-OfficialTorrServerTag {
    param([Parameter(Mandatory = $true)][string]$Tag)

    $escapedTag = [Uri]::EscapeDataString($Tag)
    $releaseUrl = "https://api.github.com/repos/$officialTorrServerRepository/releases/tags/$escapedTag"
    Write-Host "Проверка официального базового релиза TorrServer: $releaseUrl..."
    try {
        $release = Invoke-RestMethod -Headers $githubApiHeaders -Uri $releaseUrl
    } catch {
        throw "Не удалось подтвердить официальный релиз TorrServer из GitHub: $($_.Exception.Message)"
    }

    if ([string]$release.tag_name -ne $Tag -or $release.draft -or $release.prerelease) {
        throw "Тег TorrServer '$Tag' не является официальным стабильным релизом upstream."
    }

    $upstreamRef = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @(
        'ls-remote', "https://github.com/$officialTorrServerRepository.git", "refs/tags/$Tag^{}"
    )
    $upstreamCommit = ($upstreamRef -split '\s+')[0]
    $localCommit = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'rev-parse', "refs/tags/$Tag^{}")
    if ($upstreamCommit -notmatch '^[0-9a-fA-F]{40}$' -or $localCommit.ToLowerInvariant() -ne $upstreamCommit.ToLowerInvariant()) {
        throw "Тег '$Tag' в submodule не совпадает с официальным upstream commit."
    }
}

function Resolve-TorrServerSource {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.gitmodules'))) {
        throw "Не найден .gitmodules. Источник TorrServer должен быть подключён как submodule."
    }
    $submoduleUrl = (git config --file (Join-Path $repoRoot '.gitmodules') --get "submodule.$expectedSubmodulePath.url" 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($submoduleUrl)) {
        throw "В .gitmodules не найден URL submodule '$expectedSubmodulePath'."
    }

    Invoke-Native -FilePath 'git.exe' -Arguments @('submodule', 'sync', '--recursive')
    Invoke-Native -FilePath 'git.exe' -Arguments @('submodule', 'update', '--init', '--recursive', '--', $expectedSubmodulePath)

    if (-not (Test-Path -LiteralPath (Join-Path $torrServerSubmodulePath 'server\go.mod'))) {
        throw "В submodule не найден server/go.mod: $torrServerSubmodulePath"
    }

    $dirty = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'status', '--porcelain', '--untracked-files=no')
    if (-not [string]::IsNullOrWhiteSpace($dirty)) {
        throw "Рабочее дерево TorrServer загрязнено. Сборка разрешена только из чистого pinned submodule.`n$dirty"
    }

    Invoke-Native -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'fetch', '--tags', 'origin')
    $resolvedTag = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'describe', '--tags', '--match', 'MatriX.*-TorrentMod.*', '--abbrev=0', 'HEAD')
    $tagMatch = [regex]::Match($resolvedTag, $torrServerReleaseTagPattern)
    if (-not $tagMatch.Success) {
        throw "Не удалось определить downstream-тег MatriX.*-TorrentMod.* из истории submodule."
    }
    if (-not [string]::IsNullOrWhiteSpace($TorrServerTag) -and $TorrServerTag -ne $resolvedTag) {
        throw "Запрошен TorrServerTag '$TorrServerTag', но submodule закреплён на '$resolvedTag'."
    }
    $upstreamTag = $tagMatch.Groups['upstream'].Value
    Assert-OfficialTorrServerTag -Tag $upstreamTag
    $actualCommit = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'rev-parse', 'HEAD')
    return [pscustomobject]@{
        ReleaseTag = $resolvedTag
        UpstreamTag = $upstreamTag
        Commit = $actualCommit
        Repository = $submoduleUrl
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

$torrServerSource = Resolve-TorrServerSource
$torrServerReleaseTag = $torrServerSource.ReleaseTag
$torrServerVersion = $torrServerSource.UpstreamTag
$sourceRoot = Join-Path $buildRoot "TorrServer-$torrServerReleaseTag-$($torrServerSource.Commit.Substring(0, 12))"
$serverModule = Join-Path $sourceRoot 'server'
if (Test-Path -LiteralPath $sourceRoot) {
    Remove-Item -LiteralPath $sourceRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
Write-Host "Копирование TorrServer submodule $($torrServerSource.Commit) (release $torrServerReleaseTag, base $torrServerVersion)..."
Copy-Item -LiteralPath (Join-Path $torrServerSubmodulePath 'server') -Destination $serverModule -Recurse -Force
if (-not (Test-Path -LiteralPath $serverModule)) {
    throw "В submodule TorrServer не найден server/: $serverModule"
}

$goVersion = Resolve-GoVersion -ModuleFile (Join-Path $serverModule 'go.mod')
$goRoot = Join-Path $repoRoot ".tools\go-$goVersion\go"
$goExe = Join-Path $goRoot 'bin\go.exe'
$go = Get-GoExecutable

Invoke-Native -FilePath $go -Arguments @('fmt', './gstreamer') -WorkingDirectory $serverModule
if (-not $SkipTests) {
    Invoke-Native -FilePath $go -Arguments @('test', '-tags=gst', './gstreamer') -WorkingDirectory $serverModule
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$serverOutput = Join-Path $outputRoot 'TorrServer.exe'
$ldflags = "-s -w -checklinkname=0 -X server/version.Version=$torrServerReleaseTag"
Invoke-Native -FilePath $go -Arguments @('build', '-tags=nosqlite,gst', '-trimpath', "-ldflags=$ldflags", '-o', $serverOutput, './cmd') -WorkingDirectory $serverModule

$managerArguments = @('publish', 'TorrServerManager.csproj', '-c', 'Release', '-o', $outputRoot)
Invoke-Native -FilePath 'dotnet.exe' -Arguments $managerArguments -WorkingDirectory $repoRoot

Write-Host ""
Write-Host "Готово:" -ForegroundColor Green
Write-Host "  Manager:   $(Join-Path $outputRoot 'TorrServerManager.exe')"
Write-Host "  TorrServer: $serverOutput"
Write-Host "  Version:    $torrServerReleaseTag"
Write-Host "  Upstream:   $torrServerVersion"
Write-Host "  Release:    $torrServerReleaseTag"
Write-Host "  Source:     $($torrServerSource.Repository)@$($torrServerSource.Commit)"
Write-Host "  Go:         $goVersion"
