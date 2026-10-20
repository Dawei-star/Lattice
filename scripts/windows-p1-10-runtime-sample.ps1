param(
    [string]$ExePath = (Join-Path $PSScriptRoot '..\src-tauri\target\release\lattice.exe'),
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\doc\升级计划\windows-p1-10-runtime-sample.json'),
    [int[]]$Sizes = @(500, 10000),
    [int]$Runs = 3
)

$ErrorActionPreference = 'Stop'

function New-TestVault([string]$Path, [int]$Count) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    for ($i = 1; $i -le $Count; $i++) {
        $id = ('019501a2-3b4c-4c5d-89ab-{0:D12}' -f $i)
        $body = "---`nid: $id`ntitle: Gate sample $i`n---`n`nWindows P1-10 runtime sample content $i."
        [System.IO.File]::WriteAllText((Join-Path $Path ("note-{0:D5}.md" -f $i)), $body, $utf8)
    }
}

function Get-IndexedCount([string]$DbPath, [string]$SqlitePath) {
    if (-not (Test-Path -LiteralPath $DbPath)) { return $null }
    try {
        $value = (& $SqlitePath $DbPath 'SELECT COUNT(*) FROM notes;' 2>$null | Out-String).Trim()
        if ($value -match '^\d+$') { return [int]$value }
    } catch {
        return $null
    }
    return $null
}

function Enqueue-InitialScan([string]$DbPath, [string]$SqlitePath) {
    $jobId = [Guid]::NewGuid().ToString()
    $sql = "INSERT INTO jobs (id, type, key, status, payload, attempts, max_attempts, cancel_requested, created_at, updated_at) VALUES ('$jobId', 'vault-scan', 'gate-sample', 'queued', NULL, 0, 3, 0, datetime('now'), datetime('now'));"
    try {
        & $SqlitePath $DbPath $sql 2>$null | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Measure-Launch([string]$VaultPath, [int]$Count, [string]$Mode, [int]$Run, [string]$SqlitePath) {
    $dbPath = Join-Path $VaultPath '.lattice\lattice.db'
    $oldVault = $env:LATTICE_VAULT_DIR
    $env:LATTICE_VAULT_DIR = $VaultPath
    $started = [System.Diagnostics.Stopwatch]::StartNew()
    $process = $null
    try {
        $process = Start-Process -FilePath $ExePath -PassThru
        $windowMs = $null
        $dbMs = $null
        $indexMs = $null
        $scanQueued = $false
        $lastIndexProbe = [DateTime]::MinValue
        $indexed = $null
        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) { break }
            $process.Refresh()
            if ($null -eq $windowMs -and $process.MainWindowHandle -ne 0) {
                $windowMs = [int]$started.ElapsedMilliseconds
            }
            if ($null -eq $dbMs -and (Test-Path -LiteralPath $dbPath)) {
                $dbMs = [int]$started.ElapsedMilliseconds
            }
            if (-not $scanQueued -and (Test-Path -LiteralPath $dbPath)) {
                $scanQueued = Enqueue-InitialScan $dbPath $SqlitePath
            }
            if (([DateTime]::UtcNow - $lastIndexProbe).TotalMilliseconds -ge 1000) {
                $indexed = Get-IndexedCount $dbPath $SqlitePath
                $lastIndexProbe = [DateTime]::UtcNow
            }
            if ($null -eq $indexMs -and $indexed -eq $Count) {
                $indexMs = [int]$started.ElapsedMilliseconds
            }
            if ($null -ne $indexMs -and $null -ne $windowMs) { break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $process.HasExited) {
            Start-Sleep -Milliseconds 1000
            $process.Refresh()
            $workingSet = [int64]$process.WorkingSet64
            $tcpCount = @(Get-NetTCPConnection -OwningProcess $process.Id -ErrorAction SilentlyContinue).Count
        } else {
            $workingSet = $null
            $tcpCount = 0
        }
        [pscustomobject]@{
            size = $Count
            mode = $Mode
            run = $Run
            windowReadyMs = $windowMs
            databaseCreatedMs = $dbMs
            indexCompleteMs = $indexMs
            indexedNotes = (Get-IndexedCount $dbPath $SqlitePath)
            workingSetBytes = $workingSet
            tcpListeners = $tcpCount
            processId = $process.Id
        }
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $null = $process.WaitForExit(5000)
        }
        if ($null -eq $oldVault) { Remove-Item Env:LATTICE_VAULT_DIR -ErrorAction SilentlyContinue }
        else { $env:LATTICE_VAULT_DIR = $oldVault }
    }
}

$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
$sqlite = (Get-Command sqlite3.exe).Source
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lattice-p1-10-" + [Guid]::NewGuid().ToString('N'))
$results = [System.Collections.Generic.List[object]]::new()

try {
    foreach ($size in $Sizes) {
        for ($run = 1; $run -le $Runs; $run++) {
            $vault = Join-Path $tempRoot ("cold-$size-$run")
            New-TestVault $vault $size
            $results.Add((Measure-Launch $vault $size 'cold' $run $sqlite))
        }

        $warmVault = Join-Path $tempRoot ("warm-$size")
        New-TestVault $warmVault $size
        $null = Measure-Launch $warmVault $size 'warm-prime' 0 $sqlite
        for ($run = 1; $run -le $Runs; $run++) {
            $results.Add((Measure-Launch $warmVault $size 'warm' $run $sqlite))
        }
    }

    $report = [pscustomobject]@{
        generatedAt = (Get-Date).ToString('o')
        platform = 'windows'
        executable = $resolvedExe
        definition = @{
            cold = 'Fresh temporary Vault with no .lattice database before launch.'
            warm = 'Same temporary Vault after one completed index before launch.'
            windowReadyMs = 'Process main window handle appearance; not first-screen interactive readiness.'
            indexCompleteMs = 'Time until SQLite notes row count reaches the generated file count.'
        }
        samples = $results
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding utf8
    $results | Select-Object size,mode,run,windowReadyMs,databaseCreatedMs,indexCompleteMs,indexedNotes,workingSetBytes,tcpListeners | Format-Table -AutoSize | Out-String | Write-Output
    Write-Output "Report: $OutputPath"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
