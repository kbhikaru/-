import type { Slot } from "./types";

export type SharePayload = {
  /** Labels of the calendars that were combined, for display only. */
  labels: string[];
  common: Slot[];
  generatedAt: string;
};

function base64UrlEncode(json: string): string {
  const base64 =
    typeof window === "undefined"
      ? Buffer.from(json, "utf-8").toString("base64")
      : btoa(unescape(encodeURIComponent(json)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const base64 =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  if (typeof window === "undefined") {
    return Buffer.from(base64, "base64").toString("utf-8");
  }
  return decodeURIComponent(escape(atob(base64)));
}

export function encodeShare(payload: SharePayload): string {
  return base64UrlEncode(JSON.stringify(payload));
}

export function decodeShare(encoded: string): SharePayload | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(encoded));
    if (!parsed || !Array.isArray(parsed.common)) return null;
    return parsed as SharePayload;
  } catch {
    return null;
  }
}
