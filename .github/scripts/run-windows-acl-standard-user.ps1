param(
  [switch]$Child,
  [string]$RepositoryPathBase64 = "",
  [string]$NodePathBase64 = "",
  [string]$TestTempPathBase64 = ""
)

$ErrorActionPreference = "Stop"

function Decode-Utf8Base64 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  return [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String($Value)
  )
}

if ($Child) {
  # Start-Process with another credential may inherit the runner account's
  # TEMP values. Move all temporary files into the standard user's own profile
  # before Node creates the ACL fixture.
  $repositoryPath = Decode-Utf8Base64 -Value $RepositoryPathBase64
  $nodePath = Decode-Utf8Base64 -Value $NodePathBase64
  $testTemp = Decode-Utf8Base64 -Value $TestTempPathBase64
  New-Item -ItemType Directory -Path $testTemp -Force | Out-Null
  $env:TEMP = $testTemp
  $env:TMP = $testTemp

  $testFile = Join-Path `
    $repositoryPath `
    "plugins\trelio-agent-workspaces\tests\trelio-workspace.test.mjs"
  & $nodePath `
    --test `
    "--test-name-pattern=Windows bridge applies" `
    $testFile
  exit $LASTEXITCODE
}

$repositoryPath = $env:GITHUB_WORKSPACE
$nodePath = (Get-Command node -ErrorAction Stop).Source
$userName = "trelioacltest"
$plainPassword = "Trelio-Acl-$([Guid]::NewGuid().ToString('N'))-aA1!"
$securePassword = ConvertTo-SecureString `
  $plainPassword `
  -AsPlainText `
  -Force
$credential = New-Object System.Management.Automation.PSCredential(
  "$env:COMPUTERNAME\$userName",
  $securePassword
)
$stdoutPath = Join-Path $env:RUNNER_TEMP "trelio-acl-standard-user.stdout.log"
$stderrPath = Join-Path $env:RUNNER_TEMP "trelio-acl-standard-user.stderr.log"

try {
  New-LocalUser `
    -Name $userName `
    -Password $securePassword `
    -PasswordNeverExpires `
    -UserMayNotChangePassword | Out-Null

  # A regression run under the runner administrator would hide the exact
  # production failure. Assert the disposable account is not an administrator
  # before executing the real bridge implementation with that identity.
  $administratorMembers = @(
    Get-LocalGroupMember -Group "Administrators" |
      ForEach-Object { $_.Name }
  )
  if ($administratorMembers -contains "$env:COMPUTERNAME\$userName") {
    throw "Windows ACL regression account unexpectedly has administrator rights."
  }

  $repositoryPathBase64 = [System.Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($repositoryPath)
  )
  $nodePathBase64 = [System.Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($nodePath)
  )
  # A non-interactive first logon may not expose LocalApplicationData through
  # SpecialFolder yet. Pass the exact new profile temp path explicitly; the
  # child creates it only after Windows has loaded that user's profile.
  $testTempPath = Join-Path `
    $env:SystemDrive `
    "Users\$userName\AppData\Local\Temp\trelio-acl-regression"
  $testTempPathBase64 = [System.Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($testTempPath)
  )
  $windowsPowerShell = Join-Path `
    $env:SystemRoot `
    "System32\WindowsPowerShell\v1.0\powershell.exe"
  $childArguments = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$PSCommandPath`"",
    "-Child",
    "-RepositoryPathBase64",
    $repositoryPathBase64,
    "-NodePathBase64",
    $nodePathBase64,
    "-TestTempPathBase64",
    $testTempPathBase64
  )

  $process = Start-Process `
    -FilePath $windowsPowerShell `
    -ArgumentList $childArguments `
    -Credential $credential `
    -LoadUserProfile `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -Wait `
    -PassThru

  if (Test-Path $stdoutPath) {
    Get-Content $stdoutPath
  }
  if (Test-Path $stderrPath) {
    Get-Content $stderrPath
  }
  if ($process.ExitCode -ne 0) {
    throw "Windows ACL standard-user regression failed with exit code $($process.ExitCode)."
  }
} finally {
  Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
  $plainPassword = $null
}
