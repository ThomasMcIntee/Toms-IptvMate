# Keystore Setup for Release Signing

This plan outlines the steps to generate a new upload keystore and configure the Android app to use it for signing release builds.

## User Review Required

> [!IMPORTANT]
> I will be storing the keystore passwords in `local.properties`. This file is already ignored by your `.gitignore`, which is a secure practice to avoid committing secrets to version control. However, please ensure you back up the generated `release-key.jks` and the passwords I will provide.

## Proposed Changes

### [Root Project]

#### [MODIFY] [local.properties](file:///C:/prgtm/Toms-IPTVmate/Toms-IPTVmate/android/local.properties)
Store the keystore path, alias, and passwords here.

#### [NEW] [release-key.jks](file:///C:/prgtm/Toms-IPTVmate/Toms-IPTVmate/android/app/release-key.jks)
Generate the keystore file in the `app` module.

### [App Module]

#### [MODIFY] [build.gradle](file:///C:/prgtm/Toms-IPTVmate/Toms-IPTVmate/android/app/build.gradle)
Configure `signingConfigs` and update the `release` build type to use the new signing configuration.

## Verification Plan

### Automated Tests
- Run `./gradlew assembleRelease` to verify that a **signed** release APK is generated.
- Verify the APK signature using `apksigner`.

### Manual Verification
- Check that `app-release.apk` (instead of `app-release-unsigned.apk`) is present in `app/build/outputs/apk/release/`.
