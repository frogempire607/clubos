// Universal Links / App Links config + the in-app deep-link router. PURE.
//   npm run test:app-links
import { appleAppSiteAssociation, androidAssetLinks, APP_LINK_PATHS } from "../lib/appLinks";
import { pathForAppUrl } from "../components/NativeDeepLinks";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};
const aasa = appleAppSiteAssociation("J5TSB958YP");
ok("AASA app id = team.bundle", aasa.applinks.details[0].appIDs[0] === "J5TSB958YP.com.athletixos.app");
ok("AASA covers the door QR (/c/*)", aasa.applinks.details[0].components.some((c) => c["/"] === "/c/*"));
ok("AASA covers the check-in return (/member/*)", aasa.applinks.details[0].components.some((c) => c["/"] === "/member/*"));
ok("staff dashboard stays in the browser", !APP_LINK_PATHS.some((p) => p.startsWith("/dashboard") || p.startsWith("/kiosk")));
ok("assetlinks empty until the fingerprint is set", androidAssetLinks("").length === 0);
ok("assetlinks ignores junk", androidAssetLinks("not-a-fingerprint").length === 0);
const fp = Array.from({ length: 32 }, () => "ab").join(":");
const al = androidAssetLinks(`${fp}, ${fp.toUpperCase()}`);
ok("assetlinks with a fingerprint", al.length === 1 && al[0].target.package_name === "com.athletixos.app");
ok("… upper-cased", al[0]?.target.sha256_cert_fingerprints[0] === fp.toUpperCase());

ok("deep link: door QR", pathForAppUrl("https://athletix-os.com/c/abc123", "athletix-os.com") === "/c/abc123");
ok("deep link: www host", pathForAppUrl("https://www.athletix-os.com/member/checkin/x?paid=1", "athletix-os.com") === "/member/checkin/x?paid=1");
ok("deep link: foreign host ignored", pathForAppUrl("https://evil.example.com/c/abc", "athletix-os.com") === null);
ok("deep link: look-alike host ignored", pathForAppUrl("https://athletix-os.com.evil.io/c/abc", "athletix-os.com") === null);
ok("deep link: custom scheme ignored", pathForAppUrl("javascript:alert(1)", "athletix-os.com") === null);
ok("deep link: dev server host allowed", pathForAppUrl("http://127.0.0.1:3000/c/x", "127.0.0.1:3000") === "/c/x");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
