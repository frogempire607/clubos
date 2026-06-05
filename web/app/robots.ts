import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://athletix-os.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/pricing", "/login", "/signup"],
        disallow: [
          "/api/",
          "/dashboard/",
          "/member/",
          "/onboarding",
          "/post-login",
          "/setup",
          "/reset-password",
          "/forgot-password",
          "/privates/partner/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
