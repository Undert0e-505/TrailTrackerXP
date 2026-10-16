# Build and release workflow

TrailTrackerXP builds locally on Windows. Phone acceptance uses a production-variant APK signed by
the established release certificate; a debug APK cannot update an installed public release.
Building, testing, local promotion and GitHub publication are deliberately separate steps.

## Prerequisites

- Node.js and npm
- JDK 21 (`JAVA_HOME`, `C:\Program Files\Java\jdk-21`, or Android Studio's JBR)
- Android SDK (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, or `D:\dev\android-sdk`)
- The protected local signer described in [Release signing](SIGNING.md), for signed builds only

The scripts use a short local temporary directory and set the Java Unix-domain-socket temporary
path for the build process. This avoids the Windows AF_UNIX/long-temporary-path Gradle failure
without deleting Gradle caches. Release minification and resource shrinking remain disabled because
they break background location tracking.

## Development debug build

```powershell
.\scripts\build-and-release.ps1 -DebugBuild
```

This produces a uniquely named APK under `releases/debug/`. It uses debug signing and loads its
JavaScript from Metro (`npx expo start`), so it is for development/emulator use only. It cannot be
installed over the public release-signed app.

## Release-signed phone candidate

Initialize this Windows user's protected signer once from the existing Windows Generic Credentials
(never create a replacement key):

```powershell
.\scripts\initialize-local-signing.ps1 -FromCredentialManager
```

Then preview and build the signed candidate:

```powershell
.\scripts\build-signed-local.ps1 -WhatIf
.\scripts\build-signed-local.ps1 -ReferenceApk C:\path\to\published-v1.3.1.apk
```

The helper decrypts the DPAPI-protected passphrase only in the current process, validates the
keystore against the pinned public certificate, runs the repository test suite, injects signing
variables for the build, and restores them afterward. The default production-variant candidate is
standalone (Metro is not required), preserves `app.json` versionName/versionCode, and is written
without overwrite to:

`releases/candidates/TrailTrackerXP-v<version>-vc<code>-candidate-<UTC timestamp>.apk`

Every candidate is checked for package `com.trailtrackerxp.app`, app version, APK Signature Scheme
v2, exactly one signer, pinned signer fingerprint, byte size and SHA-256. Supplying `-ReferenceApk`
also prevents a lower versionCode than the published/reference APK. For v1.3.1 the established
versionCode is 7.

`-PreviewBuild` and `-ReleaseBuild` remain compatibility aliases for `-CandidateBuild` in the core
script. They do not publish or create the canonical release artifact. Private local signing should
normally go through `build-signed-local.ps1`.

## Verify and test the exact candidate

```powershell
.\scripts\build-signed-local.ps1 -VerifyOnly `
  -CandidatePath .\releases\candidates\TrailTrackerXP-v2.0.0-vc8-candidate-<timestamp>.apk `
  -ReferenceApk C:\path\to\published-v1.3.1.apk
```

On the physical phone, install with `adb install -r <candidate.apk>` or open the APK directly. Do
not uninstall the current app merely to bypass a signature/version failure: uninstalling deletes
TrailTrackerXP's on-device activity data. Confirm the update preserves existing data, then exercise
background recording, pause/resume/save, maps, Calendar/Stats refresh, GPX import/export, running
conversion, XP/achievements and challenges.

Record the tested candidate's path, size and SHA-256. The candidate that passes phone acceptance is
the only file that should move to promotion.

## Promote the exact tested bytes

```powershell
.\scripts\build-and-release.ps1 `
  -PromoteCandidate .\releases\candidates\TrailTrackerXP-v2.0.0-vc8-candidate-<timestamp>.apk `
  -ReferenceApk C:\path\to\published-v1.3.1.apk
```

Promotion performs the same package/version/signature/certificate checks, computes SHA-256, and
copies those exact bytes to `releases/TrailTrackerXP-v<version>.apk`. It does **not** rebuild. It
refuses to overwrite an existing canonical artifact and verifies size/hash equality after copying.
For a non-publishing promotion-path check, `-PromotionOutput <unique-relative-path>` selects a
different non-existing destination; all validation and no-overwrite rules remain active.

Promotion is local preparation only. Publishing to GitHub is a distinct maintainer action requiring
explicit authorization, final source review, commit/tag/push decisions, release notes, and upload of
the already validated canonical APK. These scripts never tag, push, or publish.

## Version and generated-file safety

Version name and Android versionCode live in `app.json` and must be reviewed deliberately. The
build script refuses its legacy `-Version` mutation parameter. Generated `android/` and APK output
under `releases/` are ignored and must not be committed. Signing material stays outside the
repository and shared drive.

`-Clean` runs Gradle's project clean only. It does not delete the generated Android project or broad
caches. The Expo-generated release configuration is changed only to reference process-scoped signer
variables; no password is written into generated Gradle files.

## Troubleshooting

- Missing signer: run `initialize-local-signing.ps1 -FromCredentialManager` with the established
  keystore and current-user credentials. Never generate a substitute key for an existing app.
- Signature mismatch: verify the pinned fingerprint and use the established release signer.
- Version downgrade: compare against the published/reference APK and update `app.json` deliberately.
- Debug red screen: start Metro, or install a release-signed candidate for standalone phone QA.
- Missing Android tools: install Android SDK build-tools and platform-tools, then set `ANDROID_HOME`.
