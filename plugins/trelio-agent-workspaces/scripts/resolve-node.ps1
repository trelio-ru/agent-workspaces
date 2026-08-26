[CmdletBinding()]
param(
  [string]$ProcessPath = [Environment]::GetEnvironmentVariable("Path", "Process"),
  [string]$UserPath = [Environment]::GetEnvironmentVariable("Path", "User"),
  [string]$MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine"),
  [switch]$SkipDefaultInstallRoots,
  [switch]$PathOnly
)

$ErrorActionPreference = "Stop"

# Codex Desktop may keep the PATH inherited when the app process was started,
# even though the Node installer has already updated the durable Windows PATH.
# This diagnostic is deliberately read-only: it resolves an exact executable,
# checks its actual version and returns machine-readable JSON to onboarding. It
# never edits PATH, Codex config or the user's Node installation.
$candidates = [System.Collections.Generic.List[object]]::new()
$seenPaths = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)

function Add-NodeCandidate {
  param(
    [AllowNull()]
    [string]$CandidatePath,
    [Parameter(Mandatory = $true)]
    [string]$Source
  )

  if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    return
  }

  $expandedPath = [Environment]::ExpandEnvironmentVariables($CandidatePath.Trim())
  if (-not [IO.Path]::IsPathRooted($expandedPath)) {
    # Relative PATH entries depend on the active repository and must never be
    # promoted to a runtime merely because onboarding happened to run there.
    return
  }

  if (-not (Test-Path -LiteralPath $expandedPath -PathType Leaf)) {
    return
  }

  $resolvedPath = (Get-Item -LiteralPath $expandedPath -Force).FullName
  if ($seenPaths.Add($resolvedPath)) {
    $candidates.Add([pscustomobject]@{
      path = $resolvedPath
      source = $Source
    })
  }
}

function Add-NodeCandidatesFromPath {
  param(
    [AllowNull()]
    [string]$PathValue,
    [Parameter(Mandatory = $true)]
    [string]$Source
  )

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return
  }

  foreach ($directory in $PathValue.Split([IO.Path]::PathSeparator)) {
    if ([string]::IsNullOrWhiteSpace($directory)) {
      continue
    }
    $trimmedDirectory = $directory.Trim()
    Add-NodeCandidate `
      -CandidatePath (Join-Path -Path $trimmedDirectory -ChildPath "node.exe") `
      -Source $Source
  }
}

# Check the current process first so a normal healthy installation keeps the
# same behavior. Then inspect durable machine/user PATH values and the official
# installer roots without mutating the parent Codex process.
Add-NodeCandidatesFromPath -PathValue $ProcessPath -Source "process-path"

if (-not $SkipDefaultInstallRoots) {
  foreach ($programFilesRoot in @($env:ProgramW6432, $env:ProgramFiles)) {
    if ([string]::IsNullOrWhiteSpace($programFilesRoot)) {
      continue
    }
    Add-NodeCandidate `
      -CandidatePath (Join-Path -Path $programFilesRoot -ChildPath "nodejs\node.exe") `
      -Source "program-files"
  }
}

Add-NodeCandidatesFromPath -PathValue $MachinePath -Source "machine-path"
Add-NodeCandidatesFromPath -PathValue $UserPath -Source "user-path"

$firstIncompatible = $null
foreach ($candidate in $candidates) {
  $versionText = (& $candidate.path "--version" 2>$null | Select-Object -First 1)
  $versionMatch = [regex]::Match(
    [string]$versionText,
    '^v(?<major>[0-9]+)\.[0-9]+\.[0-9]+$'
  )
  if ($LASTEXITCODE -ne 0 -or -not $versionMatch.Success) {
    continue
  }

  $isCompatible = [int]$versionMatch.Groups["major"].Value -ge 22
  $resolved = [pscustomobject]@{
    status = if ($isCompatible) { "ready" } else { "upgrade_required" }
    nodePath = $candidate.path
    version = $versionText
    source = $candidate.source
    processPathReady = $candidate.source -eq "process-path"
    # This flag concerns only Codex-managed stdio MCP startup. The onboarding
    # bridge itself can immediately use nodePath as an absolute executable.
    restartMayBeRequiredForLocalMcp = $candidate.source -ne "process-path"
  }

  if ($resolved.status -eq "ready") {
    # The paired Windows MCP launcher needs only the already validated absolute
    # executable. Keep the default JSON diagnostic stable for agents and users.
    if ($PathOnly) {
      $resolved.nodePath
    } else {
      $resolved | ConvertTo-Json -Compress
    }
    exit 0
  }

  if ($null -eq $firstIncompatible) {
    $firstIncompatible = $resolved
  }
}

if ($null -ne $firstIncompatible) {
  if (-not $PathOnly) {
    $firstIncompatible | ConvertTo-Json -Compress
  }
  exit 0
}

if (-not $PathOnly) {
  [pscustomobject]@{
    status = "not_found"
    nodePath = $null
    version = $null
    source = $null
    processPathReady = $false
    restartMayBeRequiredForLocalMcp = $false
  } | ConvertTo-Json -Compress
}
