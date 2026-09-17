import type { Slot } from "./types";

const DAY_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatSlotRange(slot: Slot): string {
  return `${TIME_FORMATTER.format(new Date(slot.startISO))} - ${TIME_FORMATTER.format(
    new Date(slot.endISO)
  )}`;
}

export function groupSlotsByDay(slots: Slot[]): { day: string; slots: Slot[] }[] {
  const groups = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = DAY_FORMATTER.format(new Date(slot.startISO));
    const list = groups.get(key) ?? [];
    list.push(slot);
    groups.set(key, list);
  }
  return Array.from(groups.entries())
    .sort(
      (a, b) =>
        Date.parse(a[1][0].startISO) - Date.parse(b[1][0].startISO)
    )
    .map(([day, slots]) => ({ day, slots }));
}

export function formatSlotsAsText(
  groups: { day: string; slots: Slot[] }[]
): string {
  return groups
    .map(
      (group) =>
        `${group.day}\n` +
        group.slots.map((s) => `  ${formatSlotRange(s)}`).join("\n")
    )
    .join("\n\n");
}
