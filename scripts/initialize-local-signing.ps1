[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SourceKeystore = (Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) 'release.keystore'),
    [switch]$FromCredentialManager,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$privateDirectory = 'D:\dev\TrailTrackerXPSigningPrivate'
$privateKeystore = Join-Path $privateDirectory 'trailtracker-release.keystore'
$storeSecretFile = Join-Path $privateDirectory 'store-password.dpapi'
$keySecretFile = Join-Path $privateDirectory 'key-password.dpapi'
$expectedCertificateSha256 = '109e6bbd3f73cbb50927e1ed24c184c30146a70dc509073a0f03603e1accbed2'
$alias = 'trailtracker'

if (-not (Test-Path -LiteralPath $SourceKeystore -PathType Leaf)) {
    throw "Established release keystore is missing: $SourceKeystore"
}
$existingPrivateFiles = @($privateKeystore, $storeSecretFile, $keySecretFile) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
if ($existingPrivateFiles.Count -and -not $Force) {
    throw "Private signing store already exists: $privateDirectory (use -Force only to replace it deliberately)."
}

$jdkCandidates = @($env:JAVA_HOME, 'C:\Program Files\Java\jdk-21', 'C:\Program Files\Android\Android Studio\jbr') |
    Where-Object { $_ } | Select-Object -Unique
$keytool = $jdkCandidates | ForEach-Object { Join-Path $_ 'bin\keytool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $keytool) { throw 'JDK keytool is missing.' }

function Read-GenericCredentialSecureString([string]$Target) {
    if (-not ('TrailTrackerCredentialReader' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TrailTrackerCredentialReader {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);
}
'@
    }
    $credentialPointer = [IntPtr]::Zero
    if (-not [TrailTrackerCredentialReader]::CredRead($Target, 1, 0, [ref]$credentialPointer)) {
        throw "Windows Generic Credential '$Target' was not found for the current user."
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $credentialPointer, [type][TrailTrackerCredentialReader+Credential])
        if ($credential.CredentialBlobSize -eq 0) { throw "Windows Generic Credential '$Target' is empty." }
        $plainText = [Runtime.InteropServices.Marshal]::PtrToStringUni(
            $credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2)).TrimEnd([char]0)
        $secure = ConvertTo-SecureString -String $plainText -AsPlainText -Force
        $plainText = $null
        return $secure
    } finally {
        [TrailTrackerCredentialReader]::CredFree($credentialPointer)
    }
}

function ConvertTo-PlainText([Security.SecureString]$SecureValue) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$storeSecret = $null
$keySecret = $null
$storePassword = $null
$keyPassword = $null
$previousStorePassword = [Environment]::GetEnvironmentVariable('TRAILTRACKER_STORE_PASSWORD', 'Process')
$previousKeyPassword = [Environment]::GetEnvironmentVariable('TRAILTRACKER_KEY_PASSWORD', 'Process')
try {
    if ($FromCredentialManager) {
        $storeSecret = Read-GenericCredentialSecureString 'TRAILTRACKER_STORE_PASSWORD'
        $keySecret = Read-GenericCredentialSecureString 'TRAILTRACKER_KEY_PASSWORD'
    } else {
        $storeSecret = Read-Host 'Established TrailTrackerXP keystore passphrase' -AsSecureString
        $keySecret = Read-Host 'Established TrailTrackerXP private-key passphrase' -AsSecureString
    }
    $storePassword = ConvertTo-PlainText $storeSecret
    $keyPassword = ConvertTo-PlainText $keySecret
    $env:TRAILTRACKER_STORE_PASSWORD = $storePassword
    $env:TRAILTRACKER_KEY_PASSWORD = $keyPassword

    $keyOutput = & $keytool -list -v -keystore $SourceKeystore -storepass:env TRAILTRACKER_STORE_PASSWORD 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'The recovered store credential did not unlock the established release keystore.' }
    $keyText = $keyOutput -join "`n"
    $aliases = @([regex]::Matches($keyText, '(?m)^Alias name:\s*(.+)$') |
        ForEach-Object { $_.Groups[1].Value.Trim() })
    $entryTypes = @([regex]::Matches($keyText, '(?m)^Entry type:\s*(.+)$') |
        ForEach-Object { $_.Groups[1].Value.Trim() })
    if ($aliases.Count -ne 1 -or $aliases[0] -ne $alias -or
        $entryTypes.Count -ne 1 -or $entryTypes[0] -ne 'PrivateKeyEntry') {
        throw "Expected exactly one PrivateKeyEntry with alias '$alias'."
    }
    $digestMatch = [regex]::Match($keyText, '(?m)^\s*SHA256:\s*([0-9A-Fa-f:]+)')
    if (-not $digestMatch.Success) { throw 'Keytool did not report the release certificate fingerprint.' }
    $digest = $digestMatch.Groups[1].Value.Replace(':', '').ToLowerInvariant()
    if ($digest -ne $expectedCertificateSha256) {
        throw 'The keystore does not match the pinned TrailTrackerXP release certificate. Do not replace the established key.'
    }
    & $keytool -certreq -alias $alias -keystore $SourceKeystore -storepass:env TRAILTRACKER_STORE_PASSWORD `
        -keypass:env TRAILTRACKER_KEY_PASSWORD -file NUL 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The recovered private-key credential did not unlock the published signing key.' }

    if ($PSCmdlet.ShouldProcess($privateDirectory, 'Create protected local signing store')) {
        New-Item -ItemType Directory -Force -Path $privateDirectory | Out-Null
        & icacls.exe $privateDirectory /inheritance:r /grant:r "$env:USERNAME`:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the private signing directory ACL.' }
        Copy-Item -LiteralPath $SourceKeystore -Destination $privateKeystore -Force:$Force
        ConvertFrom-SecureString -SecureString $storeSecret |
            Set-Content -LiteralPath $storeSecretFile -Encoding ascii -NoNewline
        ConvertFrom-SecureString -SecureString $keySecret |
            Set-Content -LiteralPath $keySecretFile -Encoding ascii -NoNewline
        Write-Host "Protected local signing store initialized: $privateDirectory"
        Write-Host "Certificate SHA-256: $digest"
        if ($FromCredentialManager) {
            Write-Host 'Source Windows Credential Manager entries were left unchanged.'
        }
    }
} finally {
    [Environment]::SetEnvironmentVariable('TRAILTRACKER_STORE_PASSWORD', $previousStorePassword, 'Process')
    [Environment]::SetEnvironmentVariable('TRAILTRACKER_KEY_PASSWORD', $previousKeyPassword, 'Process')
    $storePassword = $null
    $keyPassword = $null
    if ($storeSecret) { $storeSecret.Dispose() }
    if ($keySecret) { $keySecret.Dispose() }
}
