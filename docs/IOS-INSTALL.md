# Installing HK Access Nav on a physical iPhone

A complete record of how this app gets onto a real iPhone, why each step exists,
and what breaks if you skip it.

This document covers the **free Apple ID** path. It was written against the
configuration actually used on this machine, so the version numbers and values
are real rather than illustrative.

---

## 0. The short version

If everything is already set up and you just want to rebuild and reinstall:

```bash
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.22.0/bin:$PATH"
cd /Users/johnny/Desktop/hk-access-nav

npx expo prebuild --platform ios --clean

xcodebuild -workspace ios/HKAccessNav.xcworkspace \
  -scheme HKAccessNav \
  -configuration Release \
  -destination 'id=<YOUR_DEVICE_UDID>' \
  -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/HKAccessNav-diuffehrognfungkuewyjutvaono" \
  -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=CXULRZ6977 \
  build

xcrun devicectl device install app --device <YOUR_DEVICE_UDID> \
  "$HOME/Library/Developer/Xcode/DerivedData/HKAccessNav-diuffehrognfungkuewyjutvaono/Build/Products/Release-iphoneos/HKAccessNav.app"
```

Then on the phone, if prompted: trust the developer certificate (see §6).

Everything else in this document explains *why*, and what to do when it fails.

---

## 1. Why this is harder than it looks

There are three separate systems that must all agree before an app icon appears
on the home screen and actually opens:

| System | What it decides |
|---|---|
| **Expo / React Native** | How the JS is bundled and whether native files are generated |
| **Xcode + Apple** | Who is allowed to sign and run the app |
| **iOS on the device** | Whether *this* phone trusts *that* signature |

A failure in any one of them produces an error that looks like it came from a
different one. Two real examples from this project:

- `npx expo prebuild` **printed failure messages and still exited with code 0.**
  The command looked like it succeeded while the iOS project was never finished.
- The app built, installed, and then died instantly at launch with a UIKit error
  that had nothing to do with any of the code in `src/`.

Both are covered in the troubleshooting table (§9).

---

## 2. Mental model: what "installing the app" actually means

```
src/*.js  ──(Metro)──►  main.jsbundle  ──►  HKAccessNav.app  ──(codesign)──►  iPhone
                          │                      │                              │
                    JS, inlined at         native binary +              signature + profile
                    build time             embedded bundle               must be trusted
```

Key consequences of this model:

1. **The JS bundle is baked in at build time.** In a *Release* build the app
   contains `main.jsbundle` and needs no development server. This is the whole
   reason the app works outdoors with no laptop.
2. **Environment variables are inlined during that bundling step.** `EXPO_PUBLIC_*`
   values from `.env` become literal strings inside the bundle. They are not read
   at runtime.
3. **Changing JS requires a new build.** There is no hot reload once installed.

### Why the development client is not usable outdoors

The app currently installed from `npx expo run:ios` (Debug configuration) is a
**development client**. It deliberately contains no bundle and instead fetches JS
from a Metro server:

```
Opening exp+hk-access-nav://expo-development-client/?url=http%3A%2F%2F192.168.0.101%3A8081
```

That IP is a laptop on the local Wi-Fi. Away from that network, with no laptop,
the app has nothing to connect to. **A Debug/dev-client build can never satisfy
the "use it outdoors" requirement** — only a Release build can.

---

## 3. One-time machine setup

Verified versions on this machine:

| Tool | Version | Where |
|---|---|---|
| Node.js | v24.22.0 | `~/.nvm/versions/node/v24.22.0/bin` |
| npm | 11.19.1 | bundled with Node |
| Homebrew | 7.0.9 | `/opt/homebrew/bin` |
| CocoaPods | 1.17.0 | `/opt/homebrew/bin/pod` |
| Xcode | 27.1 | `/Applications/Xcode.app` |

### 3.1 Node

Node is installed via **nvm** and loaded from `~/.zshrc`. This matters because
nvm only configures *interactive* shells. A script, a non-login shell, or an
automation tool will not find `node` unless you add it explicitly:

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.0/bin:$PATH"
```

`nvm` has `default` set to `24`, so ordinary Terminal windows work without this.

### 3.2 CocoaPods

**This was the first hard blocker.** It was not installed, and Expo's automatic
fallbacks both failed:

```
- Installing CocoaPods...
  CocoaPods CLI not found in your PATH, installing it now.
› Failed to install CocoaPods CLI with Gem
› Failed to install CocoaPods with Homebrew. ... Cause: spawn brew ENOENT
```

Causes: the system Ruby is 2.6.10 and cannot write gems to `/Library/Ruby/Gems`
without `sudo`, and `brew` was not on the PATH of the non-login shell.

Fix:

```bash
brew install cocoapods
```

> **Warning — the trap:** `npx expo prebuild` **exits 0 even when this step
> fails.** Do not trust its exit code. Confirm the `✔ Installed CocoaPods` line
> appears, and that `ios/Pods/` and `ios/HKAccessNav.xcworkspace` exist.

---

## 4. Project configuration

> `ios/` and `android/` are **gitignored** (`/ios`, `/android` in `.gitignore`)
> and are regenerated from scratch by `npx expo prebuild`. Treat
> **`app.json` as the source of truth** and never hand-edit files under `ios/` —
> your changes will be destroyed on the next prebuild.

### 4.1 `appleTeamId` — makes signing survive prebuild

```json
"ios": {
  "supportsTablet": false,
  "bundleIdentifier": "com.hkaccessnav.app",
  "appleTeamId": "CXULRZ6977",
  ...
}
```

`@expo/config-plugins` maps this to `DEVELOPMENT_TEAM` in the generated Xcode
project. Without it, a `prebuild --clean` wipes the team setting and signing
breaks.

### 4.2 `ios.enableSceneSupport` — required by Xcode 27

```json
"plugins": [
  "expo-router",
  [
    "expo-build-properties",
    { "ios": { "enableSceneSupport": true } }
  ],
  ...
]
```

**Why this is mandatory.** Xcode 27 builds against the iOS 27 SDK, which
*requires* the UIKit scene-based life cycle. Expo SDK 57 templates still use the
older application-based life cycle, so the app builds and installs but iOS kills
it at launch:

```
Application failed to launch: UIScene life cycle is required for apps built with
this SDK.
```

The flag makes prebuild emit a `UIApplicationSceneManifest` in `Info.plist`
pointing at `EXExpoAppSceneDelegate`, and rewrites `AppDelegate.swift` so React
Native starts from the scene delegate instead of `didFinishLaunchingWithOptions`.

Official reference: <https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md>
(section *"Staying on SDK 57 with Xcode 27"*).

### 4.3 Version pinning for `expo-build-properties`

This is the one deliberate version mismatch in the project:

```json
"dependencies": {
  "expo-build-properties": "^58.0.10",
  ...
},
"expo": {
  "install": { "exclude": [ "expo-build-properties" ] }
}
```

`enableSceneSupport` was added in **58.0.2** and hardened in **58.0.3**. The
SDK-57-tagged release of this package (`57.0.22`) **does not contain the feature**.
So the project runs a 58.x package on an SDK 57 project — which is the officially
documented arrangement, and it is a no-op on SDK 58+.

The `expo.install.exclude` entry is **load-bearing**: without it, a future
`npx expo install --fix` would "helpfully" downgrade the package to 57.0.22 and
silently reintroduce the launch crash.

---

## 5. Apple signing setup (free account)

### 5.1 Add the Apple ID to Xcode

`Xcode → Settings (⌘,) → Accounts → +  → Apple ID`

This creates a **Personal Team** — the free tier. No $99 membership required.
A free Personal Team gives you:

- A development certificate
- A provisioning profile valid for **7 days**
- Up to 3 apps installed at once, 10 app IDs per week

### 5.2 Find the Team ID

```bash
defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier
```

Look for `teamID`. For this project it is `CXULRZ6977`, and note
`isFreeProvisioningTeam = 1`, confirming the free tier.

Alternatively, after a first signing attempt the certificate name contains it:

```bash
security find-identity -v -p codesigning
# "Apple Development: you@example.com (P8W6J7V6Y8)"   ← cert ID, not team ID
```

### 5.3 Confirm the app is signable for free

Free accounts reject certain entitlements. This app is safe:

```bash
cat ios/HKAccessNav/HKAccessNav.entitlements
# <dict/>  ← empty: no push, no App Groups, nothing paid-only
```

Deployment target is iOS 16.4, so any modern iPhone qualifies.

---

## 6. Building and installing

### 6.1 Find the device UDID

```bash
xcrun devicectl list devices
```

Look for `Reality = physical` (anything marked `simulated` is a Mac simulator):

```
Name              Identifier                          Reality
何晉宇的iPhone      00008130-000A0991207A8D3A (UDID)     physical
```

### 6.2 Generate the native project

```bash
npx expo prebuild --platform ios --clean
```

Verify the team actually landed:

```bash
grep -c "DEVELOPMENT_TEAM = CXULRZ6977" ios/HKAccessNav.xcodeproj/project.pbxproj
# expect: 2
```

### 6.3 Build a signed Release app

`-allowProvisioningUpdates` is what lets Xcode create the certificate and
provisioning profile on demand — this is the step that turns a "0 valid
identities" machine into a signing-capable one.

```bash
DD="$HOME/Library/Developer/Xcode/DerivedData/HKAccessNav-diuffehrognfungkuewyjutvaono"

xcodebuild -workspace ios/HKAccessNav.xcworkspace \
  -scheme HKAccessNav \
  -configuration Release \
  -destination 'id=00008130-000A0991207A8D3A' \
  -derivedDataPath "$DD" \
  -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=CXULRZ6977 \
  build
```

Success looks like `** BUILD SUCCEEDED **`. The result is
`$DD/Build/Products/Release-iphoneos/HKAccessNav.app`.

### 6.4 Verify the bundle before installing

Confirm the JS is embedded and the API key was actually inlined (a silent
failure here means the app runs but every AI feature fails in the field):

```bash
APP="$DD/Build/Products/Release-iphoneos/HKAccessNav.app"

ls -l "$APP/main.jsbundle"          # ~4.9 MB = JS is embedded
codesign -dv "$APP" 2>&1 | grep TeamIdentifier   # CXULRZ6977
```

To check inlining without printing the secret:

```bash
python3 - "$APP/main.jsbundle" <<'EOF'
import sys
d = open(sys.argv[1], 'rb').read()
print("key inlined       :", b'sk-' in d)
print("env-var name leaked:", b'EXPO_PUBLIC_SILICONFLOW_API_KEY' in d)
EOF
```

`key inlined: True` and `env-var name leaked: False` is the healthy result —
it proves the substitution happened at build time.

### 6.5 Install

```bash
xcrun devicectl device install app --device 00008130-000A0991207A8D3A "$APP"
```

Success prints `App installed: bundleID: com.hkaccessnav.app`.

### 6.6 Trust the app on the iPhone

Installing is not enough. iOS refuses to launch development-signed apps until the
user explicitly trusts the certificate:

```
Unable to launch com.hkaccessnav.app because it has an invalid code signature,
inadequate entitlements or its profile has not been explicitly trusted by the user.
```

On the iPhone, in this order:

1. **Enable Developer Mode** (the phone will restart)
   - English: `Settings → Privacy & Security → Developer Mode → On`
   - 中文: `設定 → 隱私權與安全性 → 開發者模式 → 開啟`
   - This toggle only appears *after* the phone has been connected to Xcode once.
2. **Trust the certificate**
   - English: `Settings → General → VPN & Device Management → Developer App → "Apple Development: …" → Trust`
   - 中文: `設定 → 一般 → VPN 與裝置管理 → 開發者 App → 信任`

Optional remote launch to confirm:

```bash
xcrun devicectl device process launch --device 00008130-000A0991207A8D3A com.hkaccessnav.app
```

On first use the app will also ask for camera, microphone and location
permissions — those strings come from `ios.infoPlist` in `app.json`.

---

## 7. What "works outdoors" actually means

Once installed, the Release app:

- Contains its own JS bundle — **no Metro, no laptop, no Wi-Fi requirement**
- Runs on **cellular data** for anything needing the network
- Keeps the custom ATS exception for the plain-HTTP backend at `47.237.92.84`
  (declared in `app.json` → `ios.infoPlist.NSAppTransportSecurity`)

That ATS exception is a concrete reason to prefer this route over Expo Go, which
runs inside its own app with its own `Info.plist` and would not honour it.

> **Security note, stated plainly.** Because `EXPO_PUBLIC_*` is inlined and the
> client calls SiliconFlow directly, **the API key ships inside the app binary**.
> For a personal device that is an acceptable trade. It is *not* a security
> model: anyone with the `.app` can extract the key. Before distributing this
> app, those calls belong behind a server that holds the key server-side.
> This limitation is already documented in `src/core/config.js`.

---

## 8. The 7-day expiry, and how to stop needing the laptop

A free-account provisioning profile expires **7 days** after it is issued. After
that the app stops launching until it is re-signed.

Check the current expiry:

```bash
python3 - "$APP/embedded.mobileprovision" <<'EOF'
import plistlib, sys
raw = open(sys.argv[1], 'rb').read()
p = plistlib.loads(raw[raw.find(b'<?xml'):raw.find(b'</plist>')+8])
print("Expires:", p['ExpirationDate'])
EOF
```

There are two ways to handle this:

| Approach | Laptop needed |
|---|---|
| Rebuild + reinstall with the commands in §0 | Every 7 days |
| **SideStore** (below) | Once, for initial setup only |

### 8.1 SideStore — on-device renewal

[SideStore](https://sidestore.io/) re-signs apps on the iPhone itself, so renewal
never needs a computer. It needs a **pairing file**, which requires a computer
exactly once.

> **Status: documented from official sources, not yet performed on this project.**
> Treat §8.1 as a plan to follow, not a record of something verified.

**Step 1 — create the pairing file** (Mac + cable, one time). Either tool works:

- **idevice_pair** — <https://github.com/jkcoxson/idevice_pair/releases>, a GUI
  app; connect the phone, unlock it to the home screen, choose your device, press
  **load**, then **install** under "SideStore".
- **JitterbugPair** — <https://github.com/osy/Jitterbug/releases>; run it with the
  phone unlocked on the home screen, then enter your passcode when prompted.
  It writes a `.mobiledevicepairing` file to your home folder.

**Step 2 — transfer the pairing file to the iPhone.** Zip it first — some
transfer methods truncate the long extension. AirDrop is easiest.

**Step 3 — install SideStore and its VPN.** On iOS 17.4–26.x SideStore needs
**LocalDevVPN** (or the WireGuard tunnel) running whenever SideStore is used;
that VPN is how it talks to its on-device helper.

**Step 4 — install this app through SideStore** rather than Xcode, so that
SideStore owns the signature and can renew it. SideStore accepts a `.ipa`; build
one with `xcodebuild -exportArchive`, or keep the `.app` and package it.

Once working, renewal is automatic every 7 days with no laptop.

> On **iOS 27+** this is simpler: [SideInstaller](https://sideinstaller.net/)
> performs the whole pairing+install on-device with no PC at any point.
> On iOS 17.4–26.x the pairing file above is unavoidable.

### 8.2 If you would rather pay

A $99/yr Apple Developer Program membership removes the 7-day limit entirely and
enables EAS Build + TestFlight, which needs no cable at all. The `eas.json` in
this repo already has a suitable `preview` profile (`distribution: internal`).

---

## 9. Troubleshooting

| Symptom | Real cause | Fix |
|---|---|---|
| `npx expo prebuild` prints `CocoaPods CLI not found` then **still exits 0** | CocoaPods absent; `gem` can't write to system Ruby, `brew` not on PATH | `brew install cocoapods`. Never trust prebuild's exit code — check for `✔ Installed CocoaPods` |
| `spawn brew ENOENT` | `/opt/homebrew/bin` missing from a non-interactive PATH | `export PATH="/opt/homebrew/bin:$PATH"` |
| App installs then dies instantly: `UIScene life cycle is required` | Xcode 27 / iOS 27 SDK needs the scene life cycle | `expo-build-properties` → `ios.enableSceneSupport: true`, then `prebuild --clean` |
| `Project is incompatible with this version of Expo Go` | Expo Go ships one SDK per build; the App Store version is newer than this project's SDK 57 | Not fixable while on SDK 57 — use the native build (§6), or upgrade to SDK 58 |
| `Signing for "HKAccessNav" requires a development team` | No `DEVELOPMENT_TEAM` | Add `ios.appleTeamId` to `app.json`, re-run `prebuild --clean` |
| `0 valid identities found` | Apple ID not added to Xcode yet | `Xcode → Settings → Accounts → +` |
| `... profile has not been explicitly trusted by the user` | iOS security gate | Developer Mode **and** certificate trust, §6.6 |
| Deep links / URL opens work in Debug but not Release | Scene life cycle changes `Linking.getInitialURL()` behaviour | See the scene lifecycle FYI doc (§4.2) |
| App runs but every AI feature fails silently | API key not inlined into the bundle | Re-check §6.4; ensure `.env` exists at build time |
| `EXPO_PUBLIC_*` is `undefined` in an **EAS cloud** build | `.env` is gitignored, so it is not uploaded | Use `eas env:create` — local builds do **not** have this problem |

---

## 10. Quick reference

| Item | Value |
|---|---|
| Bundle identifier | `com.hkaccessnav.app` |
| Apple Team ID (free Personal Team) | `CXULRZ6977` |
| Signing account | `johnnyho1234567@gmail.com` |
| Device | iPhone 15 Pro — `00008130-000A0991207A8D3A` |
| DerivedData | `~/Library/Developer/Xcode/DerivedData/HKAccessNav-diuffehrognfungkuewyjutvaono` |
| Built app | `…/Build/Products/Release-iphoneos/HKAccessNav.app` |
| Expo SDK / React Native | 57.0.30 / 0.86.3 |
| Xcode | 27.1 |
| CocoaPods | 1.17.0 |
| Update path when JS changes | `npx expo prebuild --clean`, then §6.3–6.5 |

### The two rules that prevent most pain

1. **`app.json` is the source of truth.** `ios/` is generated and gitignored —
   edits there do not survive.
2. **`npx expo prebuild` lies about success.** It exits 0 on internal failure.
   Verify the artifacts, not the exit code.
