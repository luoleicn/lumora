# Desktop updater releases

lumora checks the latest stable GitHub Release at startup and when the user
chooses **Help → Check for Updates…**. Release builds publish signed updater
assets plus `latest.json`; normal local builds do not need signing secrets.

## One-time signing setup

Generate the updater key on a trusted machine and keep the private-key file out
of this repository:

```bash
npm exec --workspace @lumora/desktop -- tauri signer generate -w /absolute/existing/private-directory/lumora-updater.key
```

`-w` 的父目录必须已经存在，并且当前用户需要有写权限。不要把密钥写进项目目录。

1. Replace `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY` in
   `apps/desktop/src-tauri/tauri.conf.json` with the generated public key. The
   public key is safe to commit and is embedded in every app build.
2. Add the complete private-key text as the GitHub Actions repository secret
   `TAURI_SIGNING_PRIVATE_KEY`.
3. If the key has a non-empty password, add it as
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. If the password is empty, do not
   create this secret; GitHub does not accept empty secret values and Tauri
   treats the missing environment value as an empty password.
4. Back up the private key and password securely. Losing them means existing
   installations cannot verify releases signed by a replacement key.

GitHub Actions exposes those two secrets only to the packaging/signing steps.
Tauri reads them from the step environment, signs every updater artifact, and
writes adjacent `.sig` files. The private key is not added to an app, artifact,
release, log, or `latest.json`. Clients use only the embedded public key to
verify a downloaded update before installation.

## Release behavior

Pushing `vX.Y.Z` runs `.github/workflows/release.yml` for macOS arm64/x64,
Linux deb/AppImage, and Windows MSI/NSIS. The workflow:

1. builds normal installers and updater-specific assets;
2. creates or refreshes a draft GitHub Release;
3. uploads each artifact and signature;
4. generates and uploads `latest.json` only after every expected signature is
   present; and
5. publishes the release. Prerelease tags are marked as prereleases and are not
   returned by GitHub's `/releases/latest` endpoint.

The workflow deliberately fails before packaging while the public-key
placeholder remains or if the signing private key is unavailable. The password
secret is optional for keys generated with an empty password.
