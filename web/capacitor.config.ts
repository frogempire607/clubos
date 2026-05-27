import type { CapacitorConfig } from "@capacitor/cli";

const nativeServerUrl =
  process.env.CAPACITOR_SERVER_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL ||
  "http://localhost:3001";

function serverHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const config: CapacitorConfig = {
  appId: "com.athletixos.app",
  appName: "AthletixOS",
  webDir: "public/native-shell",
  backgroundColor: "#1F1F23",
  appendUserAgent: "AthletixOSNativeShell",
  loggingBehavior: "debug",
  server: {
    url: nativeServerUrl,
    appStartPath: "/member",
    cleartext: nativeServerUrl.startsWith("http://"),
    allowNavigation: [serverHost(nativeServerUrl)].filter(Boolean),
    errorPath: "native-shell-error.html",
  },
  ios: {
    path: "ios",
  },
  android: {
    path: "android",
  },
};

export default config;
