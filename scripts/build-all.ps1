[CmdletBinding()]
param(
    [string]$TorrServerTag = '',
    [string]$TorrServerCommit = '',
    [string]$OutputDirectory = '',
    [switch]$SkipTests,
    [switch]$NoGoBootstrap
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $repoRoot '.build'
# Один плоский патч (git apply) + одна именованная серия format-patch (git am),
# применяемая поверх него, в этом порядке.
$containerSupportPatch = Join-Path $repoRoot 'patches\torrserver-gstreamer-container-support.patch'
$robustnessPatchDir = Join-Path $repoRoot 'patches\torrserver-gstreamer-robustness'
$torrServerLockPath = Join-Path $repoRoot 'config\torrserver-release.lock'
$torrServerSubmodulePath = Join-Path $repoRoot 'external\TorrServer'
$officialTorrServerRepository = 'YouROK/TorrServer'
$expectedSubmodulePath = 'external/TorrServer'
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

function Read-TorrServerSourceLock {
    if (-not (Test-Path -LiteralPath $torrServerLockPath)) {
        throw "Не найден lock-файл источника TorrServer: $torrServerLockPath"
    }

    try {
        $lock = Get-Content -LiteralPath $torrServerLockPath -Raw | ConvertFrom-Json
    } catch {
        throw "Не удалось прочитать lock-файл TorrServer: $($_.Exception.Message)"
    }

    foreach ($property in @('repository', 'tag', 'commit')) {
        if ([string]::IsNullOrWhiteSpace([string]$lock.$property)) {
            throw "В lock-файле TorrServer отсутствует '$property'."
        }
    }
    if ([string]$lock.submodulePath -ne $expectedSubmodulePath) {
        throw "Lock-файл ожидает submodulePath '$expectedSubmodulePath'."
    }
    if ([string]$lock.tag -notmatch '^MatriX\.\d+(\.\d+)*$') {
        throw "Недопустимый базовый тег TorrServer '$($lock.tag)'. Разрешены только официальные теги MatriX.*."
    }
    if ([string]$lock.commit -notmatch '^[0-9a-fA-F]{40}$') {
        throw "Commit TorrServer должен быть полным 40-символьным SHA."
    }
    return $lock
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
}

function Resolve-TorrServerSource {
    param([Parameter(Mandatory = $true)][psobject]$Lock)

    if (-not [string]::IsNullOrWhiteSpace($TorrServerTag) -and $TorrServerTag -ne $Lock.tag) {
        throw "Запрошен TorrServerTag '$TorrServerTag', но lock-файл закрепляет '$($Lock.tag)'. Обновите lock вместе с submodule."
    }
    if (-not [string]::IsNullOrWhiteSpace($TorrServerCommit) -and $TorrServerCommit.ToLowerInvariant() -ne $Lock.commit.ToLowerInvariant()) {
        throw "Запрошен TorrServerCommit '$TorrServerCommit', но lock-файл закрепляет '$($Lock.commit)'."
    }

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.gitmodules'))) {
        throw "Не найден .gitmodules. Источник TorrServer должен быть подключён как submodule."
    }
    $submoduleUrl = (git config --file (Join-Path $repoRoot '.gitmodules') --get "submodule.$expectedSubmodulePath.url" 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $submoduleUrl -ne [string]$Lock.repository) {
        throw "URL submodule '$expectedSubmodulePath' не совпадает с lock-файлом: '$submoduleUrl'."
    }

    Invoke-Native -FilePath 'git.exe' -Arguments @('submodule', 'sync', '--recursive')
    Invoke-Native -FilePath 'git.exe' -Arguments @('submodule', 'update', '--init', '--recursive', '--', $expectedSubmodulePath)

    if (-not (Test-Path -LiteralPath (Join-Path $torrServerSubmodulePath 'server\go.mod'))) {
        throw "В submodule не найден server/go.mod: $torrServerSubmodulePath"
    }

    $actualCommit = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'rev-parse', 'HEAD')
    if ($actualCommit.ToLowerInvariant() -ne [string]$Lock.commit.ToLowerInvariant()) {
        throw "Commit submodule '$actualCommit' не совпадает с lock-файлом '$($Lock.commit)'. Обновите gitlink и lock атомарно."
    }

    $dirty = Invoke-NativeOutput -FilePath 'git.exe' -Arguments @('-C', $torrServerSubmodulePath, 'status', '--porcelain', '--untracked-files=no')
    if (-not [string]::IsNullOrWhiteSpace($dirty)) {
        throw "Рабочее дерево TorrServer загрязнено. Сборка разрешена только из чистого pinned submodule.`n$dirty"
    }

    Assert-OfficialTorrServerTag -Tag $Lock.tag
    return [pscustomobject]@{
        Tag = [string]$Lock.tag
        Commit = [string]$Lock.commit
        Repository = [string]$Lock.repository
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

if (-not (Test-Path -LiteralPath $containerSupportPatch)) {
    throw "Не найден patch TorrServer: $containerSupportPatch"
}
$robustnessPatches = @(Get-ChildItem -LiteralPath $robustnessPatchDir -Filter '*.patch' | Sort-Object Name)
if ($robustnessPatches.Count -eq 0) {
    throw "В $robustnessPatchDir не найдено ни одного *.patch файла."
}

$sourceLock = Read-TorrServerSourceLock
$torrServerSource = Resolve-TorrServerSource -Lock $sourceLock
$TorrServerTag = $torrServerSource.Tag
$sourceRoot = Join-Path $buildRoot "TorrServer-$TorrServerTag-$($torrServerSource.Commit.Substring(0, 12))"
$serverModule = Join-Path $sourceRoot 'server'
if (Test-Path -LiteralPath $sourceRoot) {
    Remove-Item -LiteralPath $sourceRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
Write-Host "Копирование TorrServer submodule $($torrServerSource.Commit) (base $TorrServerTag)..."
Copy-Item -LiteralPath (Join-Path $torrServerSubmodulePath 'server') -Destination $serverModule -Recurse -Force
if (-not (Test-Path -LiteralPath $serverModule)) {
    throw "В submodule TorrServer не найден server/: $serverModule"
}

$goVersion = Resolve-GoVersion -ModuleFile (Join-Path $serverModule 'go.mod')
$goRoot = Join-Path $repoRoot ".tools\go-$goVersion\go"
$goExe = Join-Path $goRoot 'bin\go.exe'
$go = Get-GoExecutable

# git init даёт репозиторий для git am (нужен коммит-объект на каждый патч серии);
# git apply работает и без него, но так оба шага живут в одном контексте.
Invoke-Native -FilePath 'git.exe' -Arguments @('init', '-q', '.') -WorkingDirectory $sourceRoot

Invoke-Native -FilePath 'git.exe' -Arguments @('apply', '--check', $containerSupportPatch) -WorkingDirectory $sourceRoot
Invoke-Native -FilePath 'git.exe' -Arguments @('apply', $containerSupportPatch) -WorkingDirectory $sourceRoot

# git am применяет каждый патч поверх текущего индекса, а не поверх файлов на диске —
# без коммита индекс после git init пуст, и am не увидит файлы, которые apply уже изменил.
Invoke-Native -FilePath 'git.exe' -Arguments @('add', '-A') -WorkingDirectory $sourceRoot
Invoke-Native -FilePath 'git.exe' -Arguments @(
    '-c', 'user.name=TorrServerManager build',
    '-c', 'user.email=noreply@torrservermanager.local',
    'commit', '-q', '-m', 'import: TorrServer + container-support patch'
) -WorkingDirectory $sourceRoot

# git am сохраняет автора/дату из заголовков патча, но для коммита-«применителя»
# всё равно нужен committer; задаём его через окружение процесса, не через git config,
# чтобы не трогать ничью конфигурацию и не зависеть от identity текущей машины.
$env:GIT_AUTHOR_NAME = 'TorrServerManager build'
$env:GIT_AUTHOR_EMAIL = 'noreply@torrservermanager.local'
$env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
$env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL
try {
    foreach ($patch in $robustnessPatches) {
        Invoke-Native -FilePath 'git.exe' -Arguments @('am', $patch.FullName) -WorkingDirectory $sourceRoot
    }
} finally {
    Remove-Item Env:\GIT_AUTHOR_NAME, Env:\GIT_AUTHOR_EMAIL, Env:\GIT_COMMITTER_NAME, Env:\GIT_COMMITTER_EMAIL -ErrorAction SilentlyContinue
}
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
Write-Host "  Source:     $($torrServerSource.Repository)@$($torrServerSource.Commit)"
Write-Host "  Go:         $goVersion"
