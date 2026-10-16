# TrailTrackerXP local Android build and candidate-promotion workflow.
# Phone QA uses the production release variant and established release signer.
# ProGuard/minification must remain disabled because it breaks background tracking.

[CmdletBinding()]
param(
    [switch]$CandidateBuild,
    [switch]$PreviewBuild,
    [switch]$ReleaseBuild,
    [switch]$DebugBuild,
    [string]$VerifyCandidate,
    [string]$PromoteCandidate,
    [string]$PromotionOutput,
    [string]$ReferenceApk,
    [switch]$Clean,
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$APP_NAME = 'TrailTrackerXP'
$EXPECTED_PACKAGE = 'com.trailtrackerxp.app'
$EXPECTED_CERTIFICATE_SHA256 = '109e6bbd3f73cbb50927e1ed24c184c30146a70dc509073a0f03603e1accbed2'
$KEY_ALIAS = 'trailtracker'
$REPO_DIR = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$APP_JSON_PATH = Join-Path $REPO_DIR 'app.json'
$ANDROID_DIR = Join-Path $REPO_DIR 'android'
$RELEASES_DIR = Join-Path $REPO_DIR 'releases'
$CANDIDATES_DIR = Join-Path $RELEASES_DIR 'candidates'
$DEBUG_DIR = Join-Path $RELEASES_DIR 'debug'
$KEYSTORE_PATH = $env:TRAILTRACKER_SIGNING_STORE_FILE

function Get-AppMetadata {
    $config = Get-Content -LiteralPath $APP_JSON_PATH -Raw | ConvertFrom-Json
    $versionName = [string]$config.expo.version
    $versionCode = [int]$config.expo.android.versionCode
    $packageName = [string]$config.expo.android.package
    if ($versionName -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') {
        throw 'app.json expo.version is missing or invalid.'
    }
    if ($versionCode -lt 1) { throw 'app.json android.versionCode must be a positive integer.' }
    if ($packageName -ne $EXPECTED_PACKAGE) {
        throw "Unexpected Android package '$packageName'; expected '$EXPECTED_PACKAGE'."
    }
    [pscustomobject]@{ VersionName = $versionName; VersionCode = $versionCode; PackageName = $packageName }
}

function Resolve-JdkHome {
    $candidates = @($env:JAVA_HOME, 'C:\Program Files\Java\jdk-21', 'C:\Program Files\Android\Android Studio\jbr') |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    foreach ($candidate in $candidates) {
        $java = Join-Path $candidate 'bin\java.exe'
        $keytool = Join-Path $candidate 'bin\keytool.exe'
        if ((Test-Path -LiteralPath $java -PathType Leaf) -and (Test-Path -LiteralPath $keytool -PathType Leaf)) {
            $versionOutput = (& $java -version 2>&1) -join "`n"
            if ($LASTEXITCODE -eq 0 -and $versionOutput -match 'version "21(?:\.|\")') {
                return [IO.Path]::GetFullPath($candidate)
            }
        }
    }
    throw 'JDK 21 was not found. Set JAVA_HOME or install it at C:\Program Files\Java\jdk-21.'
}

function Resolve-AndroidSdk {
    $candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, 'D:\dev\android-sdk') |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'platform-tools\adb.exe') -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw 'Android SDK was not found. Set ANDROID_HOME or install it at D:\dev\android-sdk.'
}

function Resolve-BuildTool([string]$Sdk, [string]$Name) {
    $tool = Get-ChildItem -LiteralPath (Join-Path $Sdk 'build-tools') -Filter $Name -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Directory.Name } catch { [version]'0.0' } } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $tool) { throw "Android build tool '$Name' was not found under $Sdk." }
    $tool
}

function Assert-SigningInputs([string]$Keytool, [switch]$RequirePrivateKey) {
    if (-not $RequirePrivateKey) {
        return $EXPECTED_CERTIFICATE_SHA256
    }
    if ([string]::IsNullOrWhiteSpace($KEYSTORE_PATH) -or
        -not (Test-Path -LiteralPath $KEYSTORE_PATH -PathType Leaf)) {
        throw 'Private release keystore is unavailable. Use scripts/build-signed-local.ps1.'
    }
    if ([string]::IsNullOrWhiteSpace($env:TRAILTRACKER_STORE_PASSWORD) -or
        [string]::IsNullOrWhiteSpace($env:TRAILTRACKER_KEY_PASSWORD)) {
        throw 'Release signing passwords are missing. Set TRAILTRACKER_STORE_PASSWORD and TRAILTRACKER_KEY_PASSWORD.'
    }
    $keyOutput = & $Keytool -list -v -keystore $KEYSTORE_PATH -alias $KEY_ALIAS `
        -storepass:env TRAILTRACKER_STORE_PASSWORD 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the established release keystore.' }
    $match = [regex]::Match(($keyOutput -join "`n"), '(?m)^\s*SHA256:\s*([0-9A-Fa-f:]+)')
    if (-not $match.Success) { throw 'The release keystore SHA-256 fingerprint was not reported by keytool.' }
    $digest = $match.Groups[1].Value.Replace(':', '').ToLowerInvariant()
    if ($digest -ne $EXPECTED_CERTIFICATE_SHA256) {
        throw 'The release keystore does not match the pinned TrailTrackerXP release certificate.'
    }
    $digest
}

function Get-ApkIdentity([string]$Path, [string]$Aapt) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "APK does not exist: $Path" }
    $badging = & $Aapt dump badging $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect APK manifest: $Path" }
    $firstLine = [string]($badging | Select-Object -First 1)
    $match = [regex]::Match($firstLine, "package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'")
    if (-not $match.Success) { throw "APK package/version metadata was not recognized: $Path" }
    [pscustomobject]@{
        PackageName = $match.Groups[1].Value
        VersionCode = [int]$match.Groups[2].Value
        VersionName = $match.Groups[3].Value
    }
}

function Test-ReleaseApk(
    [string]$Path,
    [string]$Apksigner,
    [string]$Aapt,
    [string]$KeystoreDigest,
    [string]$ExpectedVersionName = '',
    [int]$ExpectedVersionCode = 0
) {
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $identity = Get-ApkIdentity -Path $resolved -Aapt $Aapt
    if ($identity.PackageName -ne $EXPECTED_PACKAGE) {
        throw "APK package '$($identity.PackageName)' does not match '$EXPECTED_PACKAGE': $resolved"
    }
    if ($ExpectedVersionName -and $identity.VersionName -ne $ExpectedVersionName) {
        throw "APK versionName '$($identity.VersionName)' does not match app.json '$ExpectedVersionName'."
    }
    if ($ExpectedVersionCode -gt 0 -and $identity.VersionCode -ne $ExpectedVersionCode) {
        throw "APK versionCode '$($identity.VersionCode)' does not match app.json '$ExpectedVersionCode'."
    }
    $verifyOutput = & $Apksigner verify --verbose --print-certs $resolved 2>&1
    $verifyText = $verifyOutput -join "`n"
    if ($LASTEXITCODE -ne 0 -or $verifyText -notmatch '(?m)^Verifies$') {
        throw "APK signature verification failed: $resolved"
    }
    if ($verifyText -notmatch 'Verified using v2 scheme \(APK Signature Scheme v2\): true') {
        throw "APK Signature Scheme v2 is required: $resolved"
    }
    $signerCount = [regex]::Match($verifyText, 'Number of signers:\s*(\d+)')
    if (-not $signerCount.Success -or [int]$signerCount.Groups[1].Value -ne 1) {
        throw "APK must have exactly one signer: $resolved"
    }
    $digestMatch = [regex]::Match($verifyText, 'Signer #1 certificate SHA-256 digest:\s*([0-9A-Fa-f]+)')
    if (-not $digestMatch.Success) { throw "APK signer fingerprint is missing: $resolved" }
    $apkDigest = $digestMatch.Groups[1].Value.ToLowerInvariant()
    if ($apkDigest -ne $KeystoreDigest -or $apkDigest -ne $EXPECTED_CERTIFICATE_SHA256) {
        throw "APK signer does not match the established TrailTrackerXP release signer: $resolved"
    }
    [pscustomobject]@{
        Path = $resolved
        PackageName = $identity.PackageName
        VersionName = $identity.VersionName
        VersionCode = $identity.VersionCode
        CertificateSha256 = $apkDigest
        V1 = $verifyText -match 'Verified using v1 scheme \(JAR signing\): true'
        V2 = $true
        V3 = $verifyText -match 'Verified using v3 scheme \(APK Signature Scheme v3\): true'
        Size = (Get-Item -LiteralPath $resolved).Length
        Sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
    }
}

function Resolve-ReferencePath([string]$ExplicitPath, [string]$CanonicalPath, [string]$CandidatePath) {
    if ($ExplicitPath) { return (Resolve-Path -LiteralPath $ExplicitPath -ErrorAction Stop).Path }
    if ((Test-Path -LiteralPath $CanonicalPath -PathType Leaf) -and
        ([IO.Path]::GetFullPath($CanonicalPath) -ine [IO.Path]::GetFullPath($CandidatePath))) {
        return (Resolve-Path -LiteralPath $CanonicalPath).Path
    }
    $null
}

function Assert-NondecreasingVersionCode($CandidateInfo, [string]$ReferencePath, [string]$Apksigner,
    [string]$Aapt, [string]$KeystoreDigest) {
    if (-not $ReferencePath) {
        Write-Warning 'No reference APK was supplied or found; versionCode downgrade protection could not compare an installed/released APK.'
        return
    }
    $referenceInfo = Test-ReleaseApk -Path $ReferencePath -Apksigner $Apksigner -Aapt $Aapt `
        -KeystoreDigest $KeystoreDigest
    if ($CandidateInfo.VersionCode -lt $referenceInfo.VersionCode) {
        throw "Candidate versionCode $($CandidateInfo.VersionCode) is lower than reference versionCode $($referenceInfo.VersionCode)."
    }
    Write-Host "Reference APK: $($referenceInfo.Path) (versionCode $($referenceInfo.VersionCode))"
}

function Set-GeneratedAndroidConfig($AppMetadata, [switch]$ReleaseSigning) {
    $gradlePath = Join-Path $ANDROID_DIR 'app\build.gradle'
    $propertiesPath = Join-Path $ANDROID_DIR 'gradle.properties'
    if (-not (Test-Path -LiteralPath $gradlePath -PathType Leaf)) { throw 'Generated Android build.gradle is missing.' }
    $content = Get-Content -LiteralPath $gradlePath -Raw
    $content = [regex]::Replace($content, '(?m)^\s*versionCode\s+\d+\s*$', "        versionCode $($AppMetadata.VersionCode)")
    $content = [regex]::Replace($content, '(?m)^\s*versionName\s+"[^"]+"\s*$', "        versionName `"$($AppMetadata.VersionName)`"")
    if ($ReleaseSigning) {
        if ($content -match "storeFile\s+file\('release\.keystore'\)") {
            throw 'Unsafe legacy generated signing config detected. Regenerate android/ before building.'
        }
        if ($content -notmatch 'TRAILTRACKER_STORE_PASSWORD') {
            $debugMatch = [regex]::Match($content, '(?ms)signingConfigs\s*\{\s*debug\s*\{.*?^\s{8}\}\s*')
            if (-not $debugMatch.Success) { throw 'Could not locate the generated debug signing configuration.' }
            $releaseBlock = @"

        release {
            storeFile file(System.getenv('TRAILTRACKER_SIGNING_STORE_FILE'))
            storePassword System.getenv('TRAILTRACKER_STORE_PASSWORD')
            keyAlias '$KEY_ALIAS'
            keyPassword System.getenv('TRAILTRACKER_KEY_PASSWORD')
        }
"@
            $content = $content.Insert($debugMatch.Index + $debugMatch.Length, $releaseBlock)
        }
        $releaseSigningPattern = '(?ms)(buildTypes\s*\{.*?^\s{8}release\s*\{.*?signingConfig\s+)signingConfigs\.debug'
        if ($content -notmatch $releaseSigningPattern -and $content -notmatch '(?ms)^\s{8}release\s*\{.*?signingConfig\s+signingConfigs\.release') {
            throw 'Could not locate the generated release build type signing configuration.'
        }
        $content = [regex]::Replace($content, $releaseSigningPattern, '${1}signingConfigs.release', 1)
    }
    [IO.File]::WriteAllText($gradlePath, $content, [Text.UTF8Encoding]::new($false))
    $properties = Get-Content -LiteralPath $propertiesPath -Raw
    $requiredProperties = @(
        'android.enableProguardInReleaseBuilds=false',
        'android.enableShrinkResourcesInReleaseBuilds=false'
    )
    foreach ($property in $requiredProperties) {
        $propertyName = $property.Split('=')[0]
        if ($properties -match "(?m)^$([regex]::Escape($propertyName))=(?!false\s*$)") {
            throw "Generated Android property '$propertyName' must remain false for background tracking."
        }
        if ($properties -notmatch "(?m)^$([regex]::Escape($property))\s*$") {
            $properties = $properties.TrimEnd() + "`r`n$property`r`n"
        }
    }
    [IO.File]::WriteAllText($propertiesPath, $properties, [Text.UTF8Encoding]::new($false))
    $legacyCopiedKeystore = Join-Path $ANDROID_DIR 'app\release.keystore'
    if (Test-Path -LiteralPath $legacyCopiedKeystore -PathType Leaf) {
        Remove-Item -LiteralPath $legacyCopiedKeystore -Force
    }
}

function Patch-GeneratedResources {
    $iconSource = Join-Path $REPO_DIR 'assets\native-icons\android_icons'
    $resourceDirectory = Join-Path $ANDROID_DIR 'app\src\main\res'
    if ((Test-Path -LiteralPath $iconSource) -and (Test-Path -LiteralPath $resourceDirectory)) {
        foreach ($density in @('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi')) {
            $sourceDirectory = Join-Path $iconSource "mipmap-$density"
            $destinationDirectory = Join-Path $resourceDirectory "mipmap-$density"
            if (Test-Path -LiteralPath $sourceDirectory) {
                New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
                $launcher = Join-Path $sourceDirectory 'ic_launcher.png'
                if (Test-Path -LiteralPath $launcher) {
                    Copy-Item -LiteralPath $launcher -Destination (Join-Path $destinationDirectory 'ic_launcher.png') -Force
                    Copy-Item -LiteralPath $launcher -Destination (Join-Path $destinationDirectory 'ic_launcher_round.png') -Force
                }
                $notification = Join-Path $sourceDirectory 'ic_notification.png'
                if (Test-Path -LiteralPath $notification) {
                    $drawableDirectory = Join-Path $resourceDirectory "drawable-$density"
                    New-Item -ItemType Directory -Force -Path $drawableDirectory | Out-Null
                    Copy-Item -LiteralPath $notification -Destination (Join-Path $drawableDirectory 'ic_notification.png') -Force
                }
            }
        }
        $adaptiveDirectory = Join-Path $resourceDirectory 'mipmap-anydpi-v26'
        Remove-Item -LiteralPath (Join-Path $adaptiveDirectory 'ic_launcher.xml') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $adaptiveDirectory 'ic_launcher_round.xml') -Force -ErrorAction SilentlyContinue
    }
    $taskService = Join-Path $REPO_DIR 'node_modules\expo-location\android\src\main\java\expo\modules\location\services\LocationTaskService.kt'
    if (Test-Path -LiteralPath $taskService -PathType Leaf) {
        $taskContent = Get-Content -LiteralPath $taskService -Raw
        $taskContent = $taskContent -replace 'setSmallIcon\(applicationInfo\.icon\)', 'setSmallIcon(android.R.drawable.ic_notification)'
        $taskContent = $taskContent -replace '\.setColorized\(true\)', '.setColorized(false)'
        [IO.File]::WriteAllText($taskService, $taskContent, [Text.UTF8Encoding]::new($false))
    }
}

if ($Version) { throw 'Build-time version mutation is disabled. Update and review app.json deliberately before building.' }
$candidateAliasCount = @($CandidateBuild, $PreviewBuild, $ReleaseBuild).Where({ $_ }).Count
if ($candidateAliasCount -gt 1) { throw 'Use only one of -CandidateBuild, -PreviewBuild, or -ReleaseBuild.' }
$candidateMode = $candidateAliasCount -eq 1
$operationCount = @($candidateMode, [bool]$DebugBuild, [bool]$VerifyCandidate, [bool]$PromoteCandidate).Where({ $_ }).Count
if ($operationCount -eq 0) { $candidateMode = $true; $operationCount = 1 }
if ($operationCount -ne 1) { throw 'Choose exactly one build, verify, or promotion operation.' }
if ($Clean -and ($VerifyCandidate -or $PromoteCandidate)) { throw '-Clean only applies to build operations.' }
if ($PromotionOutput -and -not $PromoteCandidate) { throw '-PromotionOutput requires -PromoteCandidate.' }
if ($DebugBuild -and $ReferenceApk) { throw '-ReferenceApk applies to signed candidate verification, not debug builds.' }
if ($ReleaseBuild) { Write-Warning '-ReleaseBuild is now a compatibility alias for -CandidateBuild; it does not create or publish a canonical release.' }
if ($PreviewBuild) { Write-Host '-PreviewBuild uses the established release signer and is install-over compatible.' }

$app = Get-AppMetadata
$jdkHome = Resolve-JdkHome
$androidSdk = Resolve-AndroidSdk
$keytool = Join-Path $jdkHome 'bin\keytool.exe'
$apksigner = Resolve-BuildTool -Sdk $androidSdk -Name 'apksigner.bat'
$aapt = Resolve-BuildTool -Sdk $androidSdk -Name 'aapt.exe'
$canonicalArtifact = Join-Path $RELEASES_DIR "$APP_NAME-v$($app.VersionName).apk"
if ($VerifyCandidate -or $PromoteCandidate -or $candidateMode) {
    $keystoreDigest = Assert-SigningInputs -Keytool $keytool -RequirePrivateKey:$candidateMode
}

if ($VerifyCandidate -or $PromoteCandidate) {
    $candidatePath = if ($VerifyCandidate) { $VerifyCandidate } else { $PromoteCandidate }
    $candidate = Test-ReleaseApk -Path $candidatePath -Apksigner $apksigner -Aapt $aapt `
        -KeystoreDigest $keystoreDigest -ExpectedVersionName $app.VersionName -ExpectedVersionCode $app.VersionCode
    $referencePath = Resolve-ReferencePath -ExplicitPath $ReferenceApk -CanonicalPath $canonicalArtifact -CandidatePath $candidate.Path
    Assert-NondecreasingVersionCode -CandidateInfo $candidate -ReferencePath $referencePath `
        -Apksigner $apksigner -Aapt $aapt -KeystoreDigest $keystoreDigest
    Write-Host "Candidate: $($candidate.Path)"
    Write-Host "Package/version: $($candidate.PackageName) $($candidate.VersionName) ($($candidate.VersionCode))"
    Write-Host "Certificate SHA-256: $($candidate.CertificateSha256)"
    Write-Host "Signature schemes: v1=$($candidate.V1), v2=$($candidate.V2), v3=$($candidate.V3)"
    Write-Host "Size: $($candidate.Size) bytes"
    Write-Host "SHA-256: $($candidate.Sha256)"
    if ($VerifyCandidate) {
        Write-Host 'Verification only. No build, copy, tag, push, or publication occurred.'
        return
    }
    $promotionArtifact = if ($PromotionOutput) {
        [IO.Path]::GetFullPath((Join-Path $REPO_DIR $PromotionOutput))
    } else {
        $canonicalArtifact
    }
    if (Test-Path -LiteralPath $promotionArtifact) {
        throw "Promotion artifact already exists; refusing to overwrite: $promotionArtifact"
    }
    $promotionDirectory = Split-Path -Parent $promotionArtifact
    New-Item -ItemType Directory -Force -Path $promotionDirectory | Out-Null
    Copy-Item -LiteralPath $candidate.Path -Destination $promotionArtifact
    $promotedHash = (Get-FileHash -LiteralPath $promotionArtifact -Algorithm SHA256).Hash
    if ($promotedHash -ne $candidate.Sha256 -or (Get-Item -LiteralPath $promotionArtifact).Length -ne $candidate.Size) {
        throw 'Promoted artifact does not exactly match the validated candidate.'
    }
    Write-Host "Promoted exact candidate bytes: $promotionArtifact"
    Write-Host 'Local promotion only. No GitHub release, tag, commit, or push occurred.'
    return
}

$previousEnvironment = @{}
foreach ($name in @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'TEMP', 'TMP', 'GRADLE_OPTS')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$shortTemp = Join-Path $env:SystemDrive 'TrailTrackerXP-tmp'
try {
    New-Item -ItemType Directory -Force -Path $shortTemp | Out-Null
    $env:JAVA_HOME = $jdkHome
    $env:ANDROID_HOME = $androidSdk
    $env:ANDROID_SDK_ROOT = $androidSdk
    $env:TEMP = $shortTemp
    $env:TMP = $shortTemp
    $unixSocketOption = "-Djdk.net.unixdomain.tmpdir=$shortTemp"
    $env:GRADLE_OPTS = if ($env:GRADLE_OPTS) { "$($env:GRADLE_OPTS) $unixSocketOption" } else { $unixSocketOption }
    Push-Location $REPO_DIR
    try {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
        $gradle = Join-Path $ANDROID_DIR 'gradlew.bat'
        if (-not (Test-Path -LiteralPath $gradle -PathType Leaf)) {
            npx expo prebuild --platform android --no-install
            if ($LASTEXITCODE -ne 0) { throw 'Expo Android prebuild failed.' }
        }
        Set-GeneratedAndroidConfig -AppMetadata $app -ReleaseSigning:$candidateMode
        Patch-GeneratedResources
        Push-Location $ANDROID_DIR
        try {
            if ($Clean) {
                & $gradle clean --no-daemon
                if ($LASTEXITCODE -ne 0) { throw 'Gradle clean failed.' }
            }
            $task = if ($DebugBuild) { 'assembleDebug' } else { 'assembleRelease' }
            & $gradle $task --no-daemon
            if ($LASTEXITCODE -ne 0) { throw "Gradle $task failed." }
        } finally {
            Pop-Location
        }
    } finally {
        Pop-Location
    }
    if ($DebugBuild) {
        $sourceApk = Join-Path $ANDROID_DIR 'app\build\outputs\apk\debug\app-debug.apk'
        if (-not (Test-Path -LiteralPath $sourceApk -PathType Leaf)) { throw 'Debug APK was not produced.' }
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
        New-Item -ItemType Directory -Force -Path $DEBUG_DIR | Out-Null
        $artifact = Join-Path $DEBUG_DIR "$APP_NAME-v$($app.VersionName)-vc$($app.VersionCode)-dev-debug-$stamp.apk"
        if (Test-Path -LiteralPath $artifact) { throw "Debug output already exists: $artifact" }
        Copy-Item -LiteralPath $sourceApk -Destination $artifact
        $identity = Get-ApkIdentity -Path $artifact -Aapt $aapt
        Write-Host "Dev debug APK: $artifact"
        Write-Host "Package/version: $($identity.PackageName) $($identity.VersionName) ($($identity.VersionCode))"
        Write-Host "SHA-256: $((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash)"
        Write-Host 'Debug builds require Metro and cannot update a release-signed installation.'
        return
    }
    $sourceApk = Join-Path $ANDROID_DIR 'app\build\outputs\apk\release\app-release.apk'
    if (-not (Test-Path -LiteralPath $sourceApk -PathType Leaf)) { throw 'Release candidate APK was not produced.' }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    New-Item -ItemType Directory -Force -Path $CANDIDATES_DIR | Out-Null
    $artifact = Join-Path $CANDIDATES_DIR "$APP_NAME-v$($app.VersionName)-vc$($app.VersionCode)-candidate-$stamp.apk"
    if (Test-Path -LiteralPath $artifact) { throw "Candidate output already exists: $artifact" }
    Copy-Item -LiteralPath $sourceApk -Destination $artifact
    $sourceHash = (Get-FileHash -LiteralPath $sourceApk -Algorithm SHA256).Hash
    $candidate = Test-ReleaseApk -Path $artifact -Apksigner $apksigner -Aapt $aapt `
        -KeystoreDigest $keystoreDigest -ExpectedVersionName $app.VersionName -ExpectedVersionCode $app.VersionCode
    if ($sourceHash -ne $candidate.Sha256) { throw 'Candidate copy does not match the Gradle-signed APK bytes.' }
    $referencePath = Resolve-ReferencePath -ExplicitPath $ReferenceApk -CanonicalPath $canonicalArtifact -CandidatePath $candidate.Path
    Assert-NondecreasingVersionCode -CandidateInfo $candidate -ReferencePath $referencePath `
        -Apksigner $apksigner -Aapt $aapt -KeystoreDigest $keystoreDigest
    Write-Host "Signed candidate: $($candidate.Path)"
    Write-Host "Package/version: $($candidate.PackageName) $($candidate.VersionName) ($($candidate.VersionCode))"
    Write-Host "Certificate SHA-256: $($candidate.CertificateSha256)"
    Write-Host "Signature schemes: v1=$($candidate.V1), v2=$($candidate.V2), v3=$($candidate.V3)"
    Write-Host "Size: $($candidate.Size) bytes"
    Write-Host "SHA-256: $($candidate.Sha256)"
    Write-Host 'Candidate only. Test these exact bytes before using -PromoteCandidate; nothing was published.'
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}
