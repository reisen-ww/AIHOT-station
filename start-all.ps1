# AIHOT startup script (idempotent). Used by scheduled task "AIHOT-Stack" at logon.
# - web=3000, api=3001 (the sibling CryptoHot instance owns its own ports and
#   processes; never touch them).
# - Skips any component whose port is already listening (3000 web / 3001 api),
#   and any worker already running (tracked by _worker.pid, never by command line).
# - Logs to _api.log/_api.err/_web.log/_web.err/_worker.log/_worker.err/_start.log
# - No console window; safe to run from Task Scheduler.
# - Run with -Stop to stop only this instance (worker pid file, 3000, 3001).
param([switch]$Stop)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root    = 'E:\NEWS\apps\AIHOT'
$WebDir  = 'E:\NEWS\apps\AIHOT\apps\web'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir  = $Root
$StartLog = Join-Path $LogDir '_start.log'
$PgTask  = 'AIHOT-Postgres-5433'

# Identity of the worker process. The worker has no port, so it is tracked by pid file.
$WorkerPidFile = Join-Path $Root '_worker.pid'

function Write-Log([string]$Text) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
  Add-Content -Path $script:StartLog -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Start-NodeService([string]$Name, [string]$WorkDir, [string]$NodeArgs, [string]$StdOut, [string]$StdErr) {
  # Cap the V8 heap per role (2026-10-15 memory diet): the AI worker kept a
  # 112 MB working set; forcing tighter GC keeps the whole stack ~150 MB.
  $heapMB = switch ($Name) { 'worker' { 160 } 'api' { 128 } default { 96 } }
  $NodeArgs = "--max-old-space-size=$heapMB $NodeArgs"
  $p = Start-Process -FilePath $script:NodeExe -ArgumentList $NodeArgs `
        -WorkingDirectory $WorkDir -WindowStyle Hidden `
        -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr -PassThru
  Write-Log "STARTED $Name pid=$($p.Id) cwd=$WorkDir args=$NodeArgs"
  return $p
}

# --- worker identity helpers -------------------------------------------------
# DO NOT reintroduce a Get-CimInstance Win32_Process + CommandLine '*apps/worker/src/main.ts*' check.
# A real node process started here reports CommandLine as
#   "C:\Program Files\nodejs\node.exe" --env-file-if-exists=.env apps/worker/src/main.ts
# The working directory lives in the -WorkingDirectory parameter, not in the command
# line, so that string is byte-identical for the CryptoHot instance and cannot say
# which instance a worker belongs to. AIHOT silently lost its worker whenever
# CryptoHot's worker was alive: the scan matched the foreign pid, logged
# "SKIP worker (already running)" and never started one, while the log stayed green.
# The pid file plus process StartTime round-trip below is the identity check instead.

function Save-WorkerPid([int]$Id) {
  $proc = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if (-not $proc) { return }
  $stamp = $proc.StartTime.ToUniversalTime().ToString('o')
  try {
    [System.IO.File]::WriteAllText($script:WorkerPidFile, ("{0}`r`n{1}`r`n" -f $Id, $stamp), (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Log "WARN could not write $($script:WorkerPidFile): $($_.Exception.Message)"
  }
}

function Get-RunningWorker {
  if (-not (Test-Path $script:WorkerPidFile)) { return $null }
  $lines = @(Get-Content -Path $script:WorkerPidFile -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0) { return $null }
  $workerId = 0
  if (-not [int]::TryParse(($lines[0]).Trim(), [ref]$workerId)) {
    Write-Log "worker pid file unreadable (line 1 not an integer); treating worker as not running"
    return $null
  }
  $proc = Get-Process -Id $workerId -ErrorAction SilentlyContinue
  if (-not $proc) {
    Write-Log "worker pid file stale (pid=$workerId not running)"
    return $null
  }
  $stampText = ''
  if ($lines.Count -ge 2) { $stampText = ($lines[1]).Trim() }
  if (-not $stampText) {
    Write-Log "worker pid file has no StartTime line; falling back to pid-existence check only (pid=$workerId)"
    return $proc
  }
  $stamp = [datetime]::MinValue
  if (-not [datetime]::TryParse($stampText, [ref]$stamp)) {
    Write-Log "worker pid file StartTime unparsable; falling back to pid-existence check only (pid=$workerId)"
    return $proc
  }
  if ($proc.StartTime.ToUniversalTime() -ne $stamp.ToUniversalTime()) {
    Write-Log "worker pid $workerId reused by an unrelated process (StartTime mismatch); treating worker as not running"
    return $null
  }
  return $proc
}

# --- -Stop: stop ONLY this instance ------------------------------------------
# HARD SAFETY RULE: -Stop must never touch the sibling instance's ports, which
# belong to CryptoHot, nor any process found by name. It only touches the pid
# recorded in _worker.pid, the listeners on 3000/3001, and the pid file itself.
if ($Stop) {
  Write-Log '========== aihot start-all -Stop begin =========='
  $running = Get-RunningWorker
  if ($running) {
    Write-Log "STOP worker pid=$($running.Id) (taskkill /F /T)"
    & taskkill /F /T /PID $running.Id 2>&1 | ForEach-Object { Write-Log "  taskkill: $_" }
  } else {
    Write-Log 'STOP worker: nothing running (no live pid file)'
  }
  Remove-Item -Path $WorkerPidFile -Force -ErrorAction SilentlyContinue
  foreach ($port in @(3000, 3001)) {
    $owner = (Get-NetTCPConnection -State Listen -LocalPort $port -EA SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) {
      Write-Log "STOP port ${port} listener pid=$owner (taskkill /F /T)"
      & taskkill /F /T /PID $owner 2>&1 | ForEach-Object { Write-Log "  taskkill: $_" }
    } else {
      Write-Log "STOP port ${port}: nothing listening"
    }
  }
  Write-Log '========== aihot start-all -Stop end =========='
  exit 0
}

Write-Log '========== start-all begin =========='

if (-not (Test-Path $NodeExe)) {
  Write-Log "FATAL node.exe not found at $NodeExe"
  exit 1
}

# --- PostgreSQL (5433) is owned by task AIHOT-Postgres-5433; tolerate not-ready DB ---
if (-not (Test-Port 5433)) {
  Write-Log 'postgres 5433 not listening -> starting task AIHOT-Postgres-5433'
  try { Start-ScheduledTask -TaskName $PgTask -ErrorAction Stop } catch { Write-Log "WARN cannot start $PgTask : $($_.Exception.Message)" }
  for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Port 5433) { break }
  }
}
if (Test-Port 5433) { Write-Log 'postgres 5433 OK' } else { Write-Log 'WARN postgres 5433 still not listening; api may retry/fail' }

# --- api (3001) ---
if (Test-Port 3001) {
  $owner = (Get-NetTCPConnection -State Listen -LocalPort 3001 -EA SilentlyContinue | Select-Object -First 1).OwningProcess
  Write-Log "SKIP api (3001 already listening, pid=$owner)"
  $apiProc = Get-Process -Id $owner -EA SilentlyContinue
} else {
  $apiProc = Start-NodeService 'api' $Root '--env-file-if-exists=.env apps/api/src/main.ts' (Join-Path $LogDir '_api.log') (Join-Path $LogDir '_api.err')
}

# --- web (3000); cwd MUST be apps/web (relative ../../.env) ---
if (Test-Port 3000) {
  $owner = (Get-NetTCPConnection -State Listen -LocalPort 3000 -EA SilentlyContinue | Select-Object -First 1).OwningProcess
  Write-Log "SKIP web (3000 already listening, pid=$owner)"
  $webProc = Get-Process -Id $owner -EA SilentlyContinue
} else {
  $webProc = Start-NodeService 'web' $WebDir '--env-file-if-exists=../../.env server.ts' (Join-Path $LogDir '_web.log') (Join-Path $LogDir '_web.err')
}

# --- worker (no port; dedupe by pid file + StartTime, never by CommandLine) ---
$workerProc = Get-RunningWorker
if ($workerProc) {
  Write-Log "SKIP worker (already running, pid=$($workerProc.Id))"
} else {
  $workerProc = Start-NodeService 'worker' $Root '--env-file-if-exists=.env apps/worker/src/main.ts' (Join-Path $LogDir '_worker.log') (Join-Path $LogDir '_worker.err')
  if ($workerProc) { Save-WorkerPid $workerProc.Id }
}

# --- settle, then self-check ---
Start-Sleep -Seconds 12

Write-Log '--- self check ---'
Write-Log ("listening 3000/3001: " + ((Test-Port 3000)) + '/' + ((Test-Port 3001)))

$health = $null
for ($i = 1; $i -le 8; $i++) {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 8
    Write-Log ("health attempt $i OK: " + ($health | ConvertTo-Json -Compress -Depth 6))
    break
  } catch {
    Write-Log "health attempt $i FAILED: $($_.Exception.Message)"
    Start-Sleep -Seconds 4
  }
}

try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -TimeoutSec 15 -UseBasicParsing
  $title = ''
  if ($r.Content -match '<title>(.*?)</title>') { $title = $Matches[1] }
  Write-Log "web / status=$($r.StatusCode) title=$title"
} catch {
  Write-Log "web / FAILED: $($_.Exception.Message)"
}

Start-Sleep -Seconds 3
$tail = @()
if (Test-Path (Join-Path $LogDir '_worker.log')) { $tail = Get-Content (Join-Path $LogDir '_worker.log') -Tail 5 -EA SilentlyContinue }
Write-Log ('worker.log tail: ' + (($tail -join ' | ')))
Write-Log ("api pid=$($apiProc.Id) web pid=$($webProc.Id)")
Write-Log '========== start-all end =========='
