# Native Asset Placeholders

Use this folder for source artwork before generating platform-specific assets.

- `athletixos-icon-1024.png` is the master 1024×1024 PNG used for iOS.
  It is regenerated from `public/brand/circle.PNG` via:
      sips -z 1024 1024 public/brand/circle.PNG \
        --out assets/native/athletixos-icon-1024.png -s format png
  and copied to `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.
- The previous icon had heavy black padding around a small A mark; the
  current version uses the full brand circle so the logo fills the iOS
  rounded badge correctly.
- Android icons live in `android/app/src/main/res/mipmap-*/` and must be
  regenerated separately (e.g. via `npx @capacitor/assets generate
  --android` or Android Studio Image Asset Studio) when the source
  changes. Not auto-synced by `cap sync`.
- Keep club-specific logos in the web app and member portal branding
  settings, not in the native shell.
