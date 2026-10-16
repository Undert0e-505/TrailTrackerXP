[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$VerifyOnly,
    [string]$CandidatePath,
    [string]$ReferenceApk,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$privateDirectory = 'D:\dev\TrailTrackerXPSigningPrivate'
$keystore = Join-Path $privateDirectory 'trailtracker-release.keystore'
$storeSecretFile = Join-Path $privateDirectory 'store-password.dpapi'
$keySecretFile = Join-Path $privateDirectory 'key-password.dpapi'
$expectedCertificateSha256 = '109e6bbd3f73cbb50927e1ed24c184c30146a70dc509073a0f03603e1accbed2'
$alias = 'trailtracker'

if ($VerifyOnly -and -not $CandidatePath) { throw '-VerifyOnly requires -CandidatePath.' }
if ($CandidatePath -and -not $VerifyOnly) { throw '-CandidatePath is only valid with -VerifyOnly.' }
if ($VerifyOnly -and $Clean) { throw '-Clean only applies to candidate builds.' }
if (-not (Test-Path -LiteralPath $keystore -PathType Leaf) -or
    -not (Test-Path -LiteralPath $storeSecretFile -PathType Leaf) -or
    -not (Test-Path -LiteralPath $keySecretFile -PathType Leaf)) {
    throw 'Protected local signer is missing. Run scripts/initialize-local-signing.ps1 first.'
}

$jdkCandidates = @($env:JAVA_HOME, 'C:\Program Files\Java\jdk-21', 'C:\Program Files\Android\Android Studio\jbr') |
    Where-Object { $_ } | Select-Object -Unique
$keytool = $jdkCandidates | ForEach-Object { Join-Path $_ 'bin\keytool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $keytool) { throw 'JDK keytool is missing.' }

function ConvertFrom-ProtectedFile([string]$Path) {
    $secureValue = ConvertTo-SecureString -String (Get-Content -LiteralPath $Path -Raw)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secureValue.Dispose()
    }
}
$storePassword = ConvertFrom-ProtectedFile $storeSecretFile
$keyPassword = ConvertFrom-ProtectedFile $keySecretFile
$names = @('TRAILTRACKER_SIGNING_STORE_FILE', 'TRAILTRACKER_STORE_PASSWORD', 'TRAILTRACKER_KEY_PASSWORD')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:TRAILTRACKER_SIGNING_STORE_FILE = $keystore
    # Protected local values intentionally take precedence over stale user/process variables.
    $env:TRAILTRACKER_STORE_PASSWORD = $storePassword
    $env:TRAILTRACKER_KEY_PASSWORD = $keyPassword
    $keyOutput = & $keytool -list -v -keystore $keystore -alias $alias `
        -storepass:env TRAILTRACKER_STORE_PASSWORD 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not unlock the protected TrailTrackerXP release keystore.' }
    $match = [regex]::Match(($keyOutput -join "`n"), '(?m)^\s*SHA256:\s*([0-9A-Fa-f:]+)')
    if (-not $match.Success -or $match.Groups[1].Value.Replace(':', '').ToLowerInvariant() -ne $expectedCertificateSha256) {
        throw 'Protected keystore does not match the pinned TrailTrackerXP release certificate.'
    }
    & $keytool -certreq -alias $alias -keystore $keystore -storepass:env TRAILTRACKER_STORE_PASSWORD `
        -keypass:env TRAILTRACKER_KEY_PASSWORD -file NUL 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not unlock the protected TrailTrackerXP private signing key.' }
    $buildScript = Join-Path $PSScriptRoot 'build-and-release.ps1'
    $arguments = if ($VerifyOnly) { @{ VerifyCandidate = $CandidatePath } } else { @{ CandidateBuild = $true } }
    if ($ReferenceApk) { $arguments.ReferenceApk = $ReferenceApk }
    if ($Clean) { $arguments.Clean = $true }
    if ($WhatIfPreference) {
        Write-Host "What if: would run tests and invoke the signed candidate workflow with protected signer '$keystore'."
        Write-Host 'No build, copy, promotion, publication, or repository change occurred.'
    } else {
        if (-not $VerifyOnly) {
            $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
            Push-Location $projectRoot
            try {
                npm test
                if ($LASTEXITCODE -ne 0) { throw 'Automated tests failed; candidate build was not started.' }
            } finally {
                Pop-Location
            }
        }
        & $buildScript @arguments
    }
} finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    $storePassword = $null
    $keyPassword = $null
}
