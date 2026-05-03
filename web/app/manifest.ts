import { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AthletixOS Member Portal",
    short_name: "AthletixOS",
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
        src: "/brand/icon.png",
        sizes: "any",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/icon.png",
        sizes: "any",
        type: "image/png",
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
