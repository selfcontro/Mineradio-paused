param([switch]$WaitForCompletion)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Interactive cloud test requires a disposable Actions runner.' }
$logPath = Join-Path $env:RUNNER_TEMP 'qmkg-cloud-test.log'
$errorPath = Join-Path $env:RUNNER_TEMP 'qmkg-cloud-test-error.log'
if (-not $WaitForCompletion) {
  Start-Process -FilePath (Get-Command node).Source -ArgumentList 'tools/qmkg-windows-cloud-smoke.cjs' -WorkingDirectory $PWD.Path -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath | Out-Null
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath 'cloud-qr/ready.json') { Write-Output 'Official QR is ready for mobile confirmation.'; exit 0 }
    if (Test-Path -LiteralPath 'cloud-results/finished.json') { throw 'Test stopped before QR; see sanitized cloud report.' }
    Start-Sleep -Seconds 2
  }
  throw 'Official QR was not ready within three minutes.'
}
$deadline = (Get-Date).AddMinutes(8)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath 'cloud-results/finished.json') {
    if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath }
    $result = Get-Content -Raw -LiteralPath 'cloud-results/finished.json' | ConvertFrom-Json
    exit $result.exitCode
  }
  Start-Sleep -Seconds 3
}
throw 'Cloud login or playback test exceeded the time limit.'
