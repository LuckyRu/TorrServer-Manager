# Прогон Go-тестов под детектором гонок.
#
# На Windows это невозможно: -race требует cgo, а gcc в системе нет. Поэтому прогон идёт через
# WSL. Без него конкурентные тесты в этом репозитории не имеют оракула вообще — они состоят из
# горутин и wg.Wait() и зелены безусловно.
[CmdletBinding()]
param(
    [int]$Count = 1,
    [string]$Run = '',
    [string]$Cpu = '1,2,8',
    # Пакеты, за которые отвечаем мы. ./torr/utils не входит: в тестах upstream (MatriX.145) там
    # гонка тест-харнесса — тест меняет глобальную переменную, пока её читает цикл соседнего теста.
    # Рабочий код не затронут, а чинить чужой тест значит заводить патч чужого файла.
    [string[]]$Packages = @('./gstreamer', './torr', './torr/storage/...', './settings')
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverModule = Join-Path $repoRoot 'external\TorrServer\server'
if (-not (Test-Path -LiteralPath (Join-Path $serverModule 'go.mod'))) {
    throw "Не найден $serverModule\go.mod. Субмодуль external/TorrServer не инициализирован."
}

function ConvertTo-WslPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $drive = $full.Substring(0, 1).ToLowerInvariant()
    return "/mnt/$drive" + $full.Substring(2).Replace('\', '/')
}

$wslModule = ConvertTo-WslPath -Path $serverModule

# go.mod требует Go новее того, что стоит в дистрибутиве, поэтому GOTOOLCHAIN=auto — не удобство,
# а условие сборки.
$goArgs = @('test', '-tags', 'gst', '-race', "-count=$Count", "-cpu=$Cpu")
if (-not [string]::IsNullOrWhiteSpace($Run)) {
    # Quoted for the shell: a -run pattern is an alternation, and an unquoted `|` becomes a pipe.
    $goArgs += "-run='" + $Run.Replace("'", "'\''") + "'"
}
$goArgs += $Packages

$command = "cd '$wslModule' && CGO_ENABLED=1 GOTOOLCHAIN=auto go $($goArgs -join ' ')"

Write-Host "> wsl -e bash -lc `"$command`"" -ForegroundColor DarkGray
$started = Get-Date
& wsl.exe -e bash -lc $command
$exitCode = $LASTEXITCODE
$elapsed = (Get-Date) - $started

if ($exitCode -ne 0) {
    throw "Прогон под -race завершился с кодом $exitCode за $([int]$elapsed.TotalSeconds) с."
}
Write-Host "Гонок не обнаружено за $([int]$elapsed.TotalSeconds) с (count=$Count, cpu=$Cpu)." -ForegroundColor Green
