[CmdletBinding()]
param(
    [string]$TorrServerTag = '',
    [string]$OutputDirectory = '',
    [switch]$SkipTests,
    [switch]$NoGoBootstrap,
    [switch]$RequireRelease
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

function Invoke-NativeExitCode {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [Parameter(Mandatory = $false)][string]$WorkingDirectory = $repoRoot
    )

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments *> $null
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Get-SubmoduleGitlink {
    $entry = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('ls-tree', 'HEAD', $expectedSubmodulePath)
    $match = [regex]::Match($entry, '^\s*\d+\s+commit\s+(?<sha>[0-9a-f]{40})\s')
    if (-not $match.Success) {
        return ''
    }
    return $match.Groups['sha'].Value
}

function Test-SubmoduleAncestor {
    param(
        [Parameter(Mandatory = $true)][string]$Ancestor,
        [Parameter(Mandatory = $true)][string]$Descendant
    )

    $code = Invoke-NativeExitCode -FilePath 'git.exe' `
        -Arguments @('merge-base', '--is-ancestor', $Ancestor, $Descendant) `
        -WorkingDirectory $torrServerSubmodulePath
    switch ($code) {
        0 { return $true }
        1 { return $false }
        default {
            throw "git merge-base не смог сравнить $Ancestor и $Descendant (код $code). Выполните 'git -C $expectedSubmodulePath fetch origin'."
        }
    }
}

# `git submodule update` выписывает gitlink родителя, а на рабочей ветке gitlink отстаёт
# по построению: родитель записывает его последним шагом выпуска, а не первым. Безусловный
# update молча пересобирает предыдущий релиз из detached HEAD.
function Sync-TorrServerSubmodule {
    param([Parameter(Mandatory = $false)][string]$Gitlink = '')

    Invoke-Native -FilePath 'git.exe' -Arguments @('submodule', 'sync', '--recursive')

    if (-not (Test-Path -LiteralPath (Join-Path $torrServerSubmodulePath 'server\go.mod'))) {
        Invoke-Native -FilePath 'git.exe' -Arguments @('submodule', 'update', '--init', '--recursive', '--', $expectedSubmodulePath)
        return
    }
    if ([string]::IsNullOrWhiteSpace($Gitlink)) {
        return
    }

    $head = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'rev-parse', 'HEAD')
    if ($head -eq $Gitlink) {
        return
    }

    if (Test-SubmoduleAncestor -Ancestor $Gitlink -Descendant $head) {
        Write-Host "Субмодуль опережает gitlink родителя: сборка идёт из рабочей ветки, откат не выполняется." -ForegroundColor Yellow
        return
    }
    if (Test-SubmoduleAncestor -Ancestor $head -Descendant $Gitlink) {
        Write-Host "Субмодуль отстаёт от gitlink родителя: перемотка вперёд на $($Gitlink.Substring(0, 12))."
        Invoke-Native -FilePath 'git.exe' -Arguments @('merge', '--ff-only', $Gitlink) -WorkingDirectory $torrServerSubmodulePath
        return
    }

    throw "История субмодуля разошлась с gitlink родителя ($($Gitlink.Substring(0, 12))). Сведите их вручную: сборка не выбирает за вас, какую сторону потерять."
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

    $gitlink = Get-SubmoduleGitlink
    Sync-TorrServerSubmodule -Gitlink $gitlink

    if (-not (Test-Path -LiteralPath (Join-Path $torrServerSubmodulePath 'server\go.mod'))) {
        throw "В submodule не найден server/go.mod: $torrServerSubmodulePath"
    }

    Invoke-Native -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'fetch', '--tags', 'origin')
    $actualCommit = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'rev-parse', 'HEAD')
    $branch = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'rev-parse', '--abbrev-ref', 'HEAD')
    $dirty = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'status', '--porcelain', '--untracked-files=no')
    $isDirty = -not [string]::IsNullOrWhiteSpace($dirty)

    $resolvedTag = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'describe', '--tags', '--match', 'MatriX.*-TorrentMod.*', '--abbrev=0', 'HEAD')
    $tagMatch = [regex]::Match($resolvedTag, $torrServerReleaseTagPattern)
    if (-not $tagMatch.Success) {
        throw "Не удалось определить downstream-тег MatriX.*-TorrentMod.* из истории submodule."
    }
    if (-not [string]::IsNullOrWhiteSpace($TorrServerTag) -and $TorrServerTag -ne $resolvedTag) {
        throw "Запрошен TorrServerTag '$TorrServerTag', но ближайший тег submodule — '$resolvedTag'."
    }
    $upstreamTag = $tagMatch.Groups['upstream'].Value
    Assert-OfficialTorrServerTag -Tag $upstreamTag

    # `describe --abbrev=0` называет ближайший тег и молчит о расстоянии до него, поэтому
    # сборка на три коммита впереди 1.6 без этой проверки штампуется как ровно 1.6.
    $distance = [int](Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'rev-list', '--count', "$resolvedTag..HEAD"))
    $devReasons = @()
    if ($distance -gt 0) {
        $where = if ($branch -eq 'HEAD') { 'субмодуль' } else { "ветка $branch" }
        $devReasons += "$where впереди тега ${resolvedTag} на $distance коммит(ов)"
    }
    if ($isDirty) {
        $devReasons += 'рабочее дерево субмодуля изменено и не соответствует ни одному коммиту'
    }
    if (-not [string]::IsNullOrWhiteSpace($gitlink) -and $gitlink -ne $actualCommit) {
        $devReasons += "gitlink родителя ещё указывает на $($gitlink.Substring(0, 12))"
    }

    $buildVersion = $resolvedTag
    if ($devReasons.Count -gt 0) {
        $buildVersion = "$resolvedTag-dev.$distance.g$($actualCommit.Substring(0, 7))"
        if ($isDirty) {
            $buildVersion += '.dirty'
        }
    }
    if ($devReasons.Count -gt 0 -and $RequireRelease) {
        throw "Запрошена релизная сборка, но источник TorrServer в дев-состоянии:`n  - $($devReasons -join "`n  - ")"
    }

    return [pscustomobject]@{
        ReleaseTag = $resolvedTag
        BuildVersion = $buildVersion
        UpstreamTag = $upstreamTag
        Commit = $actualCommit
        Branch = $branch
        Repository = $submoduleUrl
        IsDev = $devReasons.Count -gt 0
        DevReasons = $devReasons
        DirtyFiles = $dirty
    }
}

function Write-BuildStateBanner {
    param([Parameter(Mandatory = $true)][psobject]$Source)

    if (-not $Source.IsDev) {
        Write-Host "Релизная сборка TorrServer $($Source.ReleaseTag)." -ForegroundColor Green
        return
    }

    Write-Host ''
    Write-Host '  ДЕВ-СБОРКА TorrServer — не релиз  ' -ForegroundColor Black -BackgroundColor Yellow
    foreach ($reason in $Source.DevReasons) {
        Write-Host "  - $reason" -ForegroundColor Yellow
    }
    if (-not [string]::IsNullOrWhiteSpace($Source.DirtyFiles)) {
        foreach ($line in ($Source.DirtyFiles -split "`n")) {
            Write-Host "      $($line.Trim())" -ForegroundColor DarkYellow
        }
    }
    Write-Host "  Версия бинарника: $($Source.BuildVersion)" -ForegroundColor Yellow
    Write-Host '  Релиз требует тега на HEAD, чистого дерева и обновлённого gitlink; ключ -RequireRelease это проверяет.' -ForegroundColor Yellow
    Write-Host ''
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
$torrServerBuildVersion = $torrServerSource.BuildVersion
$torrServerVersion = $torrServerSource.UpstreamTag
Write-BuildStateBanner -Source $torrServerSource
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
$ldflags = "-s -w -checklinkname=0 -X server/version.Version=$torrServerBuildVersion"
Invoke-Native -FilePath $go -Arguments @('build', '-tags=nosqlite,gst', '-trimpath', "-ldflags=$ldflags", '-o', $serverOutput, './cmd') -WorkingDirectory $serverModule

$managerArguments = @('publish', 'TorrServerManager.csproj', '-c', 'Release', '-o', $outputRoot)
Invoke-Native -FilePath 'dotnet.exe' -Arguments $managerArguments -WorkingDirectory $repoRoot

Write-Host ""
Write-Host "Готово:" -ForegroundColor Green
Write-Host "  Manager:   $(Join-Path $outputRoot 'TorrServerManager.exe')"
Write-Host "  TorrServer: $serverOutput"
Write-Host "  Version:    $torrServerBuildVersion" -ForegroundColor $(if ($torrServerSource.IsDev) { 'Yellow' } else { 'Green' })
Write-Host "  Upstream:   $torrServerVersion"
Write-Host "  Release:    $torrServerReleaseTag"
Write-Host "  Source:     $($torrServerSource.Repository)@$($torrServerSource.Commit) ($($torrServerSource.Branch))"
Write-Host "  Go:         $goVersion"
Write-BuildStateBanner -Source $torrServerSource
