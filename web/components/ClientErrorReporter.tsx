"use client";

// Mounted once in the root layout: reports errors nothing else caught
// (lib/clientErrorReporter.ts). Draws nothing.
import { useEffect } from "react";
import { installClientErrorReporter } from "@/lib/clientErrorReporter";

export default function ClientErrorReporter() {
  useEffect(() => installClientErrorReporter(window), []);
  return null;
}
