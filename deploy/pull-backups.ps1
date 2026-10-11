<#
.SYNOPSIS
  Pulls sealed Natalis Lar backups (*.natalisbak) from a host to this PC.

.DESCRIPTION
  A host that runs "natalis backup --seal-to" makes one sealed package per Lar per day, named
  <lar>-<yyyyMMdd>-<HHmmss>.natalisbak. This script copies every package it does not have yet into
  <Dest>\daily\<lar>, checks each copy's SHA-256 against the host (sha256sum, run there), keeps the first package of
  each month in <Dest>\monthly\<lar>, and prunes to the newest -DailyKeep daily and -MonthlyKeep monthly copies of
  each Lar. A cloud sync client (for example Google Drive for desktop) can then sync <Dest> off the house. Each copy
  keeps the host's file time, which is what the stale check reads.

  THIS SCRIPT CANNOT OPEN PACKAGES. It never holds the sealing key and never reads what is inside a package. It
  moves whole, sealed files and checks their hashes. To open one, copy it to a machine that holds the key and run
  "natalis unseal" there.

  After a run it writes <Dest>\status.json and appends to <Dest>\pull.log. A failed run exits 1. A run where some
  Lar's newest copy is older than -StaleHours exits 2. Both raise a Windows notification.

  It runs ssh and scp with BatchMode=yes, so the login must be key-based with no passphrase prompt. Package names
  are checked against the exact pattern before any remote command uses them.

.PARAMETER SshHost
  The host as ssh knows it (a name from your ssh config is best). Required.

.PARAMETER RemoteDir
  The folder of sealed packages on the host, relative to the login folder, such as lar-sealed. Required.

.PARAMETER Dest
  The folder on this PC. Created if missing. Default: NatalisBackups in your user profile.

.PARAMETER DailyKeep
  Daily copies kept per Lar. Default 30.

.PARAMETER MonthlyKeep
  Monthly copies kept per Lar. Default 12.

.PARAMETER StaleHours
  Hours after which a Lar's newest copy counts as stale. Default 48.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File pull-backups.ps1 -SshHost <host alias> -RemoteDir lar-sealed -Dest "<folder on this PC>"

.NOTES
  Exit codes: 0 ok, 1 failed, 2 newest copy stale. Windows PowerShell 5.1 compatible.
#>
param(
  [string]$SshHost = "",
  [string]$RemoteDir = "",
  [string]$Dest = "",
  [int]$DailyKeep = 30,
  [int]$MonthlyKeep = 12,
  [int]$StaleHours = 48
)

$ErrorActionPreference = "Stop"
if (-not $Dest) { $Dest = Join-Path $env:USERPROFILE "NatalisBackups" }
$Ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
if (-not (Test-Path -LiteralPath $Ssh)) { $Ssh = "ssh" }
$Scp = Join-Path $env:WINDIR "System32\OpenSSH\scp.exe"
if (-not (Test-Path -LiteralPath $Scp)) { $Scp = "scp" }
$LogPath = Join-Path $Dest "pull.log"

# A package name: <lar>-<yyyyMMdd>-<HHmmss>.natalisbak. A Lar name is letters, digits, dashes and underscores.
$PackagePattern = '^(?<lar>[A-Za-z0-9][A-Za-z0-9_-]*)-(?<month>\d{6})\d{2}-\d{6}\.natalisbak$'
$HostPattern = '^[A-Za-z0-9][A-Za-z0-9._@-]*$'
$RemoteDirPattern = '^[A-Za-z0-9._~/-]+$'

function Exit-Usage([string]$Message) {
  [Console]::Error.WriteLine("pull-backups: $Message")
  exit 1
}

if (-not $SshHost -or $SshHost -cnotmatch $HostPattern) { Exit-Usage "-SshHost is required and must be a plain ssh host name." }
if (-not $RemoteDir -or $RemoteDir -cnotmatch $RemoteDirPattern -or $RemoteDir.StartsWith("-") -or $RemoteDir.Contains("..")) {
  Exit-Usage "-RemoteDir is required: a plain folder name relative to the login folder, with no spaces and no '..'."
}
if ($DailyKeep -lt 1 -or $MonthlyKeep -lt 1 -or $StaleHours -lt 1) { Exit-Usage "-DailyKeep, -MonthlyKeep and -StaleHours must be 1 or more." }

function Write-Log([string]$Line) {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Add-Content -LiteralPath $LogPath -Value "$stamp $Line" -Encoding utf8
}

function Show-Notice([string]$Title, [string]$Body) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName("text")
    $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
    $texts.Item(1).AppendChild($template.CreateTextNode($Body)) | Out-Null
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($template))
  } catch {
    Write-Log "notice_failed: $($_.Exception.Message)"
  }
}

function Invoke-Remote([string]$Command) {
  $output = & $Ssh -o BatchMode=yes -o ConnectTimeout=20 $SshHost $Command
  if ($LASTEXITCODE -ne 0) { throw "ssh_failed ($LASTEXITCODE)" }
  return $output
}

# Keeps the newest $Keep packages in one Lar's folder and removes the rest. Only exact package names are touched.
function Remove-Oldest([string]$Folder, [int]$Keep) {
  $all = @(Get-ChildItem -LiteralPath $Folder -File | Where-Object { $_.Name -cmatch $PackagePattern } | Sort-Object Name -Descending)
  foreach ($file in ($all | Select-Object -Skip $Keep)) {
    Remove-Item -LiteralPath $file.FullName
    Write-Log "pruned $(Split-Path -Leaf $Folder)/$($file.Name)"
  }
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$DailyRoot = Join-Path $Dest "daily"
$MonthlyRoot = Join-Path $Dest "monthly"
New-Item -ItemType Directory -Force -Path $DailyRoot, $MonthlyRoot | Out-Null

$status = [ordered]@{ ok = $false; checked_at = (Get-Date).ToUniversalTime().ToString("o"); host = $SshHost; pulled = @(); lars = [ordered]@{}; error = $null }
$exitCode = 0
try {
  # One line per package: "<mtime epoch> <sha256>  <name>". Only exact package names are kept, and only those
  # names are used in the copy command below. The host's file time is what the stale check reads.
  $listingCommand = 'cd ' + $RemoteDir + ' && for f in *.natalisbak; do [ -f $f ] && echo $(stat -c %Y $f) $(sha256sum $f); done; true'
  $listing = Invoke-Remote $listingCommand
  $remote = @{}
  foreach ($line in @($listing)) {
    if ($line -cmatch '^(\d+) ([0-9a-f]{64})\s+(\S+)$') {
      $epoch = [long]$Matches[1]
      $hash = $Matches[2]
      $name = $Matches[3]
      if ($name -cmatch $PackagePattern) {
        $remote[$name] = @{ epoch = $epoch; hash = $hash; lar = $Matches['lar'] }
      }
    }
  }
  if ($remote.Count -eq 0) { throw "no_packages_on_host" }

  foreach ($name in ($remote.Keys | Sort-Object)) {
    $entry = $remote[$name]
    $larDaily = Join-Path $DailyRoot $entry.lar
    New-Item -ItemType Directory -Force -Path $larDaily | Out-Null
    $target = Join-Path $larDaily $name
    if (Test-Path -LiteralPath $target) { continue }

    $partial = "$target.partial"
    Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
    & $Scp -q -B -o BatchMode=yes -o ConnectTimeout=20 "${SshHost}:$RemoteDir/$name" $partial
    if ($LASTEXITCODE -ne 0) {
      Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
      throw "scp_failed $name"
    }
    $localHash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($localHash -ne $entry.hash) {
      Remove-Item -LiteralPath $partial
      throw "hash_mismatch $name"
    }
    (Get-Item -LiteralPath $partial).LastWriteTimeUtc = [DateTimeOffset]::FromUnixTimeSeconds($entry.epoch).UtcDateTime
    Move-Item -LiteralPath $partial -Destination $target
    $status.pulled += $name
    Write-Log "pulled $($entry.lar)/$name"
  }

  # The first package of each month, per Lar, is also kept under monthly.
  foreach ($file in (Get-ChildItem -LiteralPath $DailyRoot -Recurse -File | Sort-Object FullName)) {
    if ($file.Name -cnotmatch $PackagePattern) { continue }
    $lar = $Matches['lar']
    $prefix = "$lar-$($Matches['month'])"
    $larMonthly = Join-Path $MonthlyRoot $lar
    New-Item -ItemType Directory -Force -Path $larMonthly | Out-Null
    $already = @(Get-ChildItem -LiteralPath $larMonthly -File | Where-Object { $_.Name.StartsWith($prefix) })
    if ($already.Count -eq 0) {
      Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $larMonthly $file.Name)
      Write-Log "monthly $lar/$($file.Name)"
    }
  }

  foreach ($larDir in @(Get-ChildItem -LiteralPath $DailyRoot -Directory)) { Remove-Oldest $larDir.FullName $DailyKeep }
  foreach ($larDir in @(Get-ChildItem -LiteralPath $MonthlyRoot -Directory -ErrorAction SilentlyContinue)) { Remove-Oldest $larDir.FullName $MonthlyKeep }

  $now = (Get-Date).ToUniversalTime()
  $stale = @()
  foreach ($larDir in @(Get-ChildItem -LiteralPath $DailyRoot -Directory | Sort-Object Name)) {
    $newest = @(Get-ChildItem -LiteralPath $larDir.FullName -File | Where-Object { $_.Name -cmatch $PackagePattern } | Sort-Object Name -Descending | Select-Object -First 1)
    if ($newest.Count -eq 0) { continue }
    $ageHours = [math]::Round(($now - $newest[0].LastWriteTimeUtc).TotalHours, 1)
    $status.lars[$larDir.Name] = [ordered]@{ newest = $newest[0].Name; age_hours = $ageHours }
    if ($ageHours -gt $StaleHours) { $stale += $larDir.Name }
  }

  if ($stale.Count -gt 0) {
    $status.error = "newest_copy_stale: " + ($stale -join ", ")
    $exitCode = 2
    Write-Log "stale: $($stale -join ', ')"
    Show-Notice "Natalis backup is stale" ("The newest copy of {0} here is older than {1} hours. The host may not be making backups." -f ($stale -join ", "), $StaleHours)
  } else {
    $status.ok = $true
  }
} catch {
  $status.error = $_.Exception.Message
  $exitCode = 1
  Write-Log "failed: $($status.error)"
  Show-Notice "Natalis backup pull failed" $status.error
}

$json = $status | ConvertTo-Json -Depth 4 -Compress
[IO.File]::WriteAllText((Join-Path $Dest "status.json"), $json, (New-Object Text.UTF8Encoding($false)))
Write-Log ("done exit=$exitCode pulled=" + $status.pulled.Count)
exit $exitCode
