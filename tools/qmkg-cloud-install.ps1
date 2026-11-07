$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'This installer check only runs in GitHub Actions.' }
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
$installDir = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'qmkg-install\Mineradio'))
if (-not $installDir.StartsWith($runnerRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install directory is outside the disposable runner root.' }
if (Test-Path -LiteralPath (Join-Path $installDir 'Mineradio.exe')) { throw 'The install directory is not fresh.' }
$installer = (Resolve-Path -LiteralPath 'dist\Mineradio-2.2.2-QMKG-Setup.exe').Path
$result = Start-Process -FilePath $installer -ArgumentList ('/S /D=' + $installDir) -WindowStyle Hidden -Wait -PassThru
if ($result.ExitCode -ne 0) { throw ('Installer exit code: ' + $result.ExitCode) }
$requestedExe = Join-Path $installDir 'Mineradio.exe'
$candidates = @($requestedExe, 'D:\Mineradio\Mineradio.exe', 'C:\Mineradio\Mineradio.exe', (Join-Path $env:LOCALAPPDATA 'Programs\mineradio\Mineradio.exe'))
$found = @($candidates | Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
if ($found.Count -ne 1) { throw 'Cannot uniquely locate the app installed in the fresh runner.' }
$exe = Get-Item -LiteralPath $found[0]
if ($exe.VersionInfo.ProductVersion -ne '2.2.2') { throw 'Installed version mismatch.' }
New-Item -ItemType Directory -Path 'cloud-results' -Force | Out-Null
$report = @{ installed=$true; version=$exe.VersionInfo.ProductVersion; architecture='x64'; customSilentInstallDirHonored=($exe.FullName -eq $requestedExe); installerSHA256=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash }
$report | ConvertTo-Json | Set-Content -LiteralPath 'cloud-results\installation.json' -Encoding utf8
('QMKG_INSTALLED_EXE=' + $exe.FullName) >> $env:GITHUB_ENV
if (-not $report.customSilentInstallDirHonored) { Write-Warning 'The upstream installer ignored /D during silent installation and used its default path in this disposable VM.' }
Write-Output 'Windows 2.2.2 installer completed successfully in the disposable Windows runner.'
