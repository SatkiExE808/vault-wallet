# Android APK signing — one-time setup

The `build-apk.yml` workflow signs every APK with a release keystore so installs over the same package ID succeed. You need to set up the keystore + 4 GitHub Secrets exactly once.

## Step 1 — Generate (or reuse) a keystore

### Option A: I already have `vault-release.keystore` from an earlier local build

Find the file on your Mac (typically `~/vault-wallet/android/vault-release.keystore` or wherever you ran the manual APK build before). Skip to Step 2.

### Option B: Generate a fresh keystore

⚠️ **Important caveat**: An APK signed by a fresh keystore will **not** install over an existing APK signed by a different keystore — Android refuses signature mismatches. You'll have to uninstall the current Vault app first, then install the new one. Future updates from the same CI keystore will install cleanly.

```bash
# Run anywhere on your Mac. Pick a strong password and write it down.
keytool -genkey -v \
  -keystore vault-release.keystore \
  -storetype PKCS12 \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias vault
```

The tool will ask for:
- A keystore password (twice) — call this `STORE_PASSWORD`
- A few identity questions (name, org, country) — answers don't matter much
- A key password — either press Enter to reuse the keystore password (recommended) or enter a different one — call this `KEY_PASSWORD`

You now have `vault-release.keystore` in the current directory. **Back it up somewhere safe** — if you lose it, you can never push a signature-matching update again.

## Step 2 — Base64-encode the keystore

```bash
base64 -i vault-release.keystore | pbcopy   # macOS: copies to clipboard
# or: base64 -i vault-release.keystore | tr -d '\n' > keystore.b64
```

The base64 string is one giant line (no newlines).

## Step 3 — Add 4 Secrets in GitHub

Go to:
**https://github.com/SatkiExE808/vault-wallet/settings/secrets/actions** → **New repository secret**

Create these four secrets one by one:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The base64 blob from Step 2 (paste from clipboard) |
| `ANDROID_KEYSTORE_PASSWORD` | `STORE_PASSWORD` from Step 1 |
| `ANDROID_KEY_ALIAS` | `vault` (the `-alias` argument from keytool) |
| `ANDROID_KEY_PASSWORD` | `KEY_PASSWORD` from Step 1 (same as store password if you pressed Enter) |

## Step 4 — Trigger the first build

Either:

- **Push any commit to `main`** — the workflow runs automatically.
- **Or trigger manually**: GitHub repo → **Actions** tab → **Build & release APK** → **Run workflow** → **Run**.

About 8–12 minutes later you'll see:

- A signed `vault-wallet.apk` attached to https://github.com/SatkiExE808/vault-wallet/releases/latest
- The same APK as a workflow artifact (Actions tab → most recent run → "Artifacts" at the bottom)

Both link to the exact same file.

## Updates

After setup, every `git push origin main` rebuilds the APK and refreshes the `latest` release. Friends can install with one command:

```bash
adb install -r vault-wallet.apk
```

or just download from the Releases page and tap to install.

## Cutting a tagged release

For a more formal milestone:

```bash
git tag v1.0.1
git push origin v1.0.1
```

That creates a **permanent** release (separate from the rolling `latest`) at `/releases/tag/v1.0.1` with auto-generated release notes from the commit log.

## Verifying a signed APK after the fact

```bash
# From the project root:
~/Library/Android/sdk/build-tools/34.0.0/apksigner verify --print-certs vault-wallet.apk
```

The SHA-1 / SHA-256 fingerprints should match across every build that came from the same keystore.
