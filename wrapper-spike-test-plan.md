# Android Wrapper Spike -- Test Plan (v3.4.5n-spike)

Panel mandate (Code Red): prove that **Door 1 (Camera) activates flawlessly**
and **the Amazon Exit Node successfully escapes the wrapper into the native
Amazon app**, on a physical Android device -- emulators are explicitly
forbidden per the QA Lead.

## Setup (one-time, ~20 minutes)

1. Install Android Studio for Windows: https://developer.android.com/studio
2. During Android Studio first-run, accept all default SDK installs
   (Platform Tools, Build Tools, latest API level).
3. Enable Developer Mode + USB Debugging on your Android phone:
   - Settings -> About phone -> tap "Build number" 7 times to unlock
     Developer Options
   - Settings -> Developer Options -> toggle "USB debugging" ON
4. Connect phone to Windows via USB cable. Accept the "Allow USB debugging?"
   prompt on the phone.

## Build the spike (from PowerShell)

```powershell
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git checkout wrapper-spike-android
npm install
npx cap add android
npx cap sync android
npx cap open android
```

`npx cap open android` launches Android Studio with the generated project
loaded. First-time Gradle sync takes ~5-10 minutes.

In Android Studio: top toolbar -> device dropdown should show your physical
phone (e.g. "Pixel 7 Pro"). Click the green Run button. Capacitor builds
the APK, installs it on your phone, launches the wrapped Savvey.

## Pass criteria (both must hold)

### Test 1 -- Camera flow (Door 1)

1. Tap the green "Snap a product" tile on home.
2. Native Android camera should open WITHIN 1 SECOND.
3. Point at any product, tap shutter.
4. Result screen should appear within ~5 seconds with verdict pill, hero
   image, and Amazon CTA.
5. PASS if: camera opens fast, captures, and the result screen renders.
   FAIL if: hangs >3s, crashes, or shows raw 12MB image.

Verify the SA's downscaling guard: the `track('snap_captured', ...)` event
in PostHog should show `bytes` ~50-150 KB, NOT multiple megabytes.

### Test 2 -- Exit node (Marketplace Specialist's red-alert)

1. After Test 1 produces a result with an Amazon CTA, tap the green
   "Amazon UK" button.
2. PASS if: the native Amazon app opens (if installed) OR the user's
   default browser (Chrome) opens with the listing. User remains signed
   in to their Amazon account, ready to buy.
3. FAIL if: the URL opens inside an in-app browser embedded within the
   Savvey wrapper. Affiliate cookie drop fails. Conversion dies.

Logcat verification: filter by `cta_tapped_external` -- this PostHog event
fires only via the Capacitor App.openUrl() bridge.

## If either test fails

Report back with: which test failed, exact symptom, Logcat output filtered
by `savvey`, Android version + device model.

## Post-pass next moves

Once both tests pass on Android:
1. Cherry-pick the JS bridge changes from wrapper-spike-android into
   master. PWA users see no change. Wrapper users get the native handoff.
2. Sign the APK for Play Store submission ($25 one-time developer fee).
3. iOS path resumes when Mac access is available, OR cloud build via
   Codemagic.

## What this spike does NOT cover

- iOS WKWebView behavior (different Mac required)
- Play Store submission flow (separate $25 dev fee + listing)
- Long-running production stability
- Service Worker behavior inside Android WebView