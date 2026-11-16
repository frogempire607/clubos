import type { CapacitorConfig } from "@capacitor/cli";
import { buildNativeConfig } from "./lib/nativeConfig";

// Everything is decided in lib/nativeConfig.ts so a test can hold a release
// build to its rules (scripts/native-config-tests.ts): no debug logging, no
// cleartext, no mixed content, navigation limited to our own host and the
// Stripe pages we send people to.
//
//   - Local dev (simulator):   http://127.0.0.1:3000        (the default)
//   - Real phone on your LAN:  http://<mac-lan-ip>:3000     via CAPACITOR_SERVER_URL
//   - Store build:             https://athletix-os.com      via CAPACITOR_SERVER_URL
//
// Use `npm run cap:dev:sim | cap:dev:iphone | cap:dev:prod` — they set the
// variable, regenerate the bundled shell's server-config.js and run `cap sync`
// together. See docs/native-launch-checklist.md for why 127.0.0.1 and port
// 3000 specifically.
const config: CapacitorConfig = buildNativeConfig({
  CAPACITOR_SERVER_URL: process.env.CAPACITOR_SERVER_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

export default config;
