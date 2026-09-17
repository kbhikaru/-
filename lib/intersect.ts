import type { Slot } from "./types";

/** Merge overlapping/adjacent slots (already sorted or not) into the minimal set of continuous intervals. */
export function mergeSlots(slots: Slot[]): Slot[] {
  if (slots.length === 0) return [];
  const sorted = [...slots].sort(
    (a, b) => Date.parse(a.startISO) - Date.parse(b.startISO)
  );
  const merged: Slot[] = [sorted[0]];
  for (const slot of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (Date.parse(slot.startISO) <= Date.parse(last.endISO)) {
      if (Date.parse(slot.endISO) > Date.parse(last.endISO)) {
        last.endISO = slot.endISO;
      }
    } else {
      merged.push({ ...slot });
    }
  }
  return merged;
}

/** Intersection of two lists of already-merged, sorted intervals. */
function intersectTwo(a: Slot[], b: Slot[]): Slot[] {
  const result: Slot[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const startA = Date.parse(a[i].startISO);
    const endA = Date.parse(a[i].endISO);
    const startB = Date.parse(b[j].startISO);
    const endB = Date.parse(b[j].endISO);

    const start = Math.max(startA, startB);
    const end = Math.min(endA, endB);
    if (start < end) {
      result.push({
        startISO: new Date(start).toISOString(),
        endISO: new Date(end).toISOString(),
      });
    }
    if (endA < endB) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

/** Intersection of N lists of slots (each list may be unsorted / unmerged). */
export function intersectAll(lists: Slot[][]): Slot[] {
  if (lists.length === 0) return [];
  let acc = mergeSlots(lists[0]);
  for (const list of lists.slice(1)) {
    acc = intersectTwo(acc, mergeSlots(list));
    if (acc.length === 0) break;
  }
  return acc;
}

/** Drop intervals shorter than `minMinutes`. */
export function filterByMinDuration(slots: Slot[], minMinutes: number): Slot[] {
  const minMs = minMinutes * 60_000;
  return slots.filter(
    (s) => Date.parse(s.endISO) - Date.parse(s.startISO) >= minMs
  );
}
