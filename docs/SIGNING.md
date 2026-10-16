# Release signing

TrailTrackerXP updates must keep the established Android release identity. The public certificate
SHA-256 is:

`109E6BBD3F73CBB50927E1ED24C184C30146A70DC509073A0F03603E1ACCBED2`

The build scripts pin this value and compare it with `apksigner verify --print-certs`.

On the local Windows build host, private material belongs outside the repository:

- `D:\dev\TrailTrackerXPSigningPrivate\trailtracker-release.keystore`
- `D:\dev\TrailTrackerXPSigningPrivate\trailtracker-release-source-backup.keystore`
- `D:\dev\TrailTrackerXPSigningPrivate\store-password.dpapi`
- `D:\dev\TrailTrackerXPSigningPrivate\key-password.dpapi`

The DPAPI file is encrypted for the current Windows profile and is not a portable backup. The
initializer copies the already-established keystore, verifies its sole private-key entry and
certificate, stores the credentials through Windows DPAPI, and restricts the directory ACL. It
never generates a key.

```powershell
.\scripts\initialize-local-signing.ps1 -FromCredentialManager
.\scripts\build-signed-local.ps1 -WhatIf
```

`-FromCredentialManager` reads the current user's existing Generic Credentials named
`TRAILTRACKER_STORE_PASSWORD` and `TRAILTRACKER_KEY_PASSWORD` through the Windows Credential API.
It never displays them or passes them on a command line. The source credentials remain unchanged.
Before creating the private store, the initializer proves that they unlock both the keystore and
private key, that the keystore contains exactly one `PrivateKeyEntry` named `trailtracker`, and that
its certificate matches the pinned public fingerprint.

The signed-build helper always replaces any stale process/user signing environment values with the
DPAPI-protected private-store values for the child build, then restores the previous process values.
Environment variables therefore cannot silently override the validated local signer.

After the protected copy and its hash were verified on this host, the original ignored repository
keystore was moved—not deleted—to the source-backup path above. No release keystore or DPAPI blob
should remain anywhere under the repository checkout.

Keep independent encrypted off-machine backups of both the keystore and passphrase. Never place a
keystore, passphrase or DPAPI blob in Git, GitHub, logs, command arguments, screenshots, shell
history, an APK delivery folder, or the shared drive. Losing the established key or passphrase means
a newly signed APK cannot update existing installations.
