import { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ClubOS Member Portal",
    short_name: "ClubOS",
    description: "Your club in your pocket — schedule, bookings, and more.",
    start_url: "/member",
    scope: "/member",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F5F3EE",
    theme_color: "#1C1917",
    categories: ["sports", "fitness", "lifestyle"],
    icons: [
      {
        src: "/icons/icon-192.svg",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
    screenshots: [],
    shortcuts: [
      {
        name: "My Bookings",
        short_name: "Bookings",
        description: "View your upcoming classes",
        url: "/member/bookings",
      },
      {
        name: "My Profile",
        short_name: "Profile",
        description: "View and edit your profile",
        url: "/member/profile",
      },
    ],
  };
}
