export type BrandedNavKey = "book" | "schedule" | "store" | "videos" | "more";

export type BrandedAppConfig = {
  appName: string;
  shortDescription: string;
  iconUrl: string | null;
  themeColor: string;
  splashColor: string;
  iosBundleId: string;
  androidPackage: string;
  enabled: boolean;
  appThumbnail: {
    iconUrl: string | null;
    backgroundImageUrl: string | null;
    backgroundColor: string;
    backgroundGradient: string;
  };
  splash: {
    logoUrl: string | null;
    backgroundImageUrl: string | null;
    backgroundColor: string;
    backgroundGradient: string;
  };
  signIn: {
    backgroundImageUrl: string | null;
    overlayColor: string;
    overlayGradient: string;
    cardBackground: string;
    buttonColor: string;
    buttonTextColor: string;
    fontStyle: string;
    logoPlacement: "top" | "inside";
    useDefaultBackground: boolean;
  };
  style: {
    primaryButtonColor: string;
    secondaryButtonColor: string;
    buttonTextColor: string;
    borderRadius: number;
    headerBackgroundColor: string;
    headerTextColor: string;
    fontWeight: "normal" | "medium" | "semibold" | "bold";
    iconColor: string;
  };
  navigation: {
    backgroundColor: string;
    activeIconColor: string;
    inactiveIconColor: string;
    items: { key: BrandedNavKey; label: string; enabled: boolean }[];
  };
  bookNow: {
    logoUrl: string | null;
    logoShape: "round" | "square" | "rounded";
    backgroundImageUrl: string | null;
    backgroundGradient: string;
    topIconColor: string;
    cardBackground: string;
    buttonStyle: "filled" | "outline" | "soft";
  };
  confirmation: {
    successIconUrl: string | null;
    message: string;
    buttonColor: string;
    buttonTextColor: string;
    backgroundColor: string;
    backgroundImageUrl: string | null;
    showAddToCalendar: boolean;
  };
  reviews: {
    title: string;
    message: string;
    buttonColor: string;
    buttonTextColor: string;
    googleReviewUrl: string;
    facebookReviewUrl: string;
  };
};

export function slugToReverseDomain(slug: string) {
  const clean = slug.replace(/[^a-z0-9]/gi, "").toLowerCase() || "club";
  return `com.athletixos.${clean}`;
}

export function defaultBrandedAppConfig(club: {
  name: string;
  slug: string;
  primaryColor: string | null;
  logoUrl: string | null;
}): BrandedAppConfig {
  const accent = club.primaryColor || "#1C1917";
  return {
    appName: club.name,
    shortDescription: `${club.name} member portal: bookings, documents, messages, and purchases.`,
    iconUrl: club.logoUrl,
    themeColor: accent,
    splashColor: "#FFFFFF",
    iosBundleId: slugToReverseDomain(club.slug),
    androidPackage: slugToReverseDomain(club.slug),
    enabled: false,
    appThumbnail: {
      iconUrl: club.logoUrl,
      backgroundImageUrl: null,
      backgroundColor: "#F5F5F4",
      backgroundGradient: "",
    },
    splash: {
      logoUrl: club.logoUrl,
      backgroundImageUrl: null,
      backgroundColor: "#FFFFFF",
      backgroundGradient: "",
    },
    signIn: {
      backgroundImageUrl: null,
      overlayColor: "rgba(28,25,23,0.22)",
      overlayGradient: "",
      cardBackground: "#FFFFFF",
      buttonColor: accent,
      buttonTextColor: "#FFFFFF",
      fontStyle: "system",
      logoPlacement: "top",
      useDefaultBackground: true,
    },
    style: {
      primaryButtonColor: accent,
      secondaryButtonColor: "#F5F5F4",
      buttonTextColor: "#FFFFFF",
      borderRadius: 12,
      headerBackgroundColor: accent,
      headerTextColor: "#FFFFFF",
      fontWeight: "semibold",
      iconColor: accent,
    },
    navigation: {
      backgroundColor: "#FFFFFF",
      activeIconColor: accent,
      inactiveIconColor: "#A8A29E",
      items: [
        { key: "book", label: "Book Now", enabled: true },
        { key: "schedule", label: "My Schedule", enabled: true },
        { key: "store", label: "Store", enabled: true },
        { key: "videos", label: "Videos", enabled: false },
        { key: "more", label: "More", enabled: true },
      ],
    },
    bookNow: {
      logoUrl: club.logoUrl,
      logoShape: "rounded",
      backgroundImageUrl: null,
      backgroundGradient: "",
      topIconColor: accent,
      cardBackground: "#FFFFFF",
      buttonStyle: "filled",
    },
    confirmation: {
      successIconUrl: null,
      message: "You're all set. We sent the confirmation to your account.",
      buttonColor: accent,
      buttonTextColor: "#FFFFFF",
      backgroundColor: "#F5F5F4",
      backgroundImageUrl: null,
      showAddToCalendar: false,
    },
    reviews: {
      title: `How was your experience with ${club.name}?`,
      message: "Your feedback helps the club improve and helps other families find the right program.",
      buttonColor: accent,
      buttonTextColor: "#FFFFFF",
      googleReviewUrl: "",
      facebookReviewUrl: "",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeObject<T extends Record<string, unknown>>(defaults: T, saved: unknown): T {
  if (!isRecord(saved)) return defaults;
  const next = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const defaultValue = defaults[key];
    const savedValue = saved[key as string];
    if (isRecord(defaultValue) && isRecord(savedValue)) {
      next[key] = mergeObject(defaultValue, savedValue) as T[keyof T];
    } else if (savedValue !== undefined) {
      next[key] = savedValue as T[keyof T];
    }
  }
  return next;
}

export function mergeBrandedAppConfig(
  defaults: BrandedAppConfig,
  saved: unknown,
): BrandedAppConfig {
  const merged = mergeObject(defaults as unknown as Record<string, unknown>, saved) as unknown as BrandedAppConfig;
  const defaultNav = defaults.navigation.items;
  const savedNav = isRecord(saved) && isRecord(saved.navigation) && Array.isArray(saved.navigation.items)
    ? saved.navigation.items
    : [];
  merged.navigation.items = defaultNav.map((item) => {
    const match = savedNav.find((raw) => isRecord(raw) && raw.key === item.key) as Record<string, unknown> | undefined;
    return {
      key: item.key,
      label: typeof match?.label === "string" ? match.label : item.label,
      enabled: typeof match?.enabled === "boolean" ? match.enabled : item.enabled,
    };
  });
  return merged;
}

export function contrastColor(hex: string) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return "#111111";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111111" : "#FFFFFF";
}
