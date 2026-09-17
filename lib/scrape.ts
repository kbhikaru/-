import { chromium, type Browser, type Page } from "playwright";
import type { Slot } from "./types";

/**
 * Google Calendar の「予約スケジュール」ページ (calendar.google.com/calendar/appointments/...)
 * は公開APIを持たないため、ここでは実際に画面をレンダリングして DOM からテキストを読み取っている。
 * Google 側の UI 変更で壊れる可能性が高い。壊れた場合は SCRAPE_DEBUG=1 で実行し、
 * 保存されるスクリーンショット/HTML (/tmp/avail-match-debug-*) を見てセレクタ/正規表現を調整すること。
 */

const DEBUG = process.env.SCRAPE_DEBUG === "1";

export type ScrapeOneResult = {
  slots: Slot[];
  timeZoneLabel: string | null;
  error?: string;
};

const TIME_RANGE_RE =
  /(\d{1,2}:\d{2})\s*(AM|PM|am|pm)?\s*[–—-]\s*(\d{1,2}:\d{2})\s*(AM|PM|am|pm)?/;

const GMT_OFFSET_RE = /GMT\s*([+-])(\d{1,2}):?(\d{2})/;

function to24h(hm: string, ampm?: string): { h: number; m: number } {
  const [hStr, mStr] = hm.split(":");
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (ampm) {
    const upper = ampm.toUpperCase();
    if (upper === "PM" && h !== 12) h += 12;
    if (upper === "AM" && h === 12) h = 0;
  }
  return { h, m };
}

/** Build a UTC ISO string from a local y/m/d h:m and a GMT offset in minutes (e.g. +540 for JST). */
function toUtcISO(
  year: number,
  month1to12: number,
  day: number,
  h: number,
  m: number,
  offsetMinutes: number
): string {
  const utcMs =
    Date.UTC(year, month1to12 - 1, day, h, m, 0) - offsetMinutes * 60_000;
  return new Date(utcMs).toISOString();
}

function parseGmtOffsetMinutes(pageText: string): number | null {
  const match = pageText.match(GMT_OFFSET_RE);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  return sign * (hours * 60 + minutes);
}

/** Try to read the "September 2026" / "2026年9月" style month heading currently shown. */
async function readVisibleMonthYear(
  page: Page
): Promise<{ year: number; month: number } | null> {
  const headingCandidates = await page
    .locator('[role="heading"], h1, h2')
    .allTextContents();
  for (const text of headingCandidates) {
    const jp = text.match(/(\d{4})年\s*(\d{1,2})月/);
    if (jp) return { year: parseInt(jp[1], 10), month: parseInt(jp[2], 10) };
    const en = text.match(
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
    );
    if (en) {
      const months = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
      ];
      const month = months.indexOf(en[1].toLowerCase()) + 1;
      return { year: parseInt(en[2], 10), month };
    }
  }
  return null;
}

async function clickNextMonth(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: /next month/i }),
    page.getByRole("button", { name: /翌月|次の月/ }),
  ];
  for (const locator of candidates) {
    if ((await locator.count()) > 0) {
      await locator.first().click();
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function saveDebugArtifacts(page: Page, tag: string) {
  if (!DEBUG) return;
  try {
    await page.screenshot({
      path: `/tmp/avail-match-debug-${tag}.png`,
      fullPage: true,
    });
    const html = await page.content();
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(`/tmp/avail-match-debug-${tag}.html`, html, "utf-8")
    );
  } catch {
    // best effort only
  }
}

async function scrapeOnePage(
  page: Page,
  url: string,
  days: number
): Promise<ScrapeOneResult> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1000);

  const pageText = await page.evaluate(() => document.body.innerText);
  const offsetMinutes = parseGmtOffsetMinutes(pageText) ?? 9 * 60; // default: JST
  const timeZoneLabel = pageText.match(GMT_OFFSET_RE)?.[0] ?? null;

  const today = new Date();
  const rangeEnd = new Date(today.getTime() + days * 86_400_000);

  const slots: Slot[] = [];
  const seenMonths = new Set<string>();

  for (let monthIndex = 0; monthIndex < 3; monthIndex++) {
    const visibleMonth = await readVisibleMonthYear(page);
    const monthKey = visibleMonth
      ? `${visibleMonth.year}-${visibleMonth.month}`
      : `unknown-${monthIndex}`;
    if (seenMonths.has(monthKey)) break;
    seenMonths.add(monthKey);

    // Day cells: Google's Material date-picker style renders each selectable day as a
    // role="button" or role="gridcell" element whose accessible name contains the day number.
    const dayButtons = page.locator(
      '[role="gridcell"] [role="button"], [role="grid"] [role="button"], td[role="gridcell"]'
    );
    const count = await dayButtons.count();

    for (let i = 0; i < count; i++) {
      const cell = dayButtons.nth(i);
      const disabled = await cell.getAttribute("aria-disabled");
      if (disabled === "true") continue;

      const label = (await cell.getAttribute("aria-label")) ?? "";
      const text = (await cell.textContent()) ?? "";
      const dayNumMatch = (label || text).match(/(\d{1,2})/);
      if (!dayNumMatch || !visibleMonth) continue;
      const day = parseInt(dayNumMatch[1], 10);

      const cellDate = new Date(
        Date.UTC(visibleMonth.year, visibleMonth.month - 1, day)
      );
      if (cellDate < new Date(today.toDateString()) || cellDate > rangeEnd) {
        continue;
      }

      try {
        await cell.click({ timeout: 5000 });
      } catch {
        continue;
      }
      await page.waitForTimeout(400);

      const slotButtons = page.getByRole("button");
      const slotCount = await slotButtons.count();
      for (let s = 0; s < slotCount; s++) {
        const slotText = (await slotButtons.nth(s).textContent()) ?? "";
        const match = slotText.match(TIME_RANGE_RE);
        if (!match) continue;
        const start = to24h(match[1], match[2]);
        const end = to24h(match[3], match[4]);
        slots.push({
          startISO: toUtcISO(
            visibleMonth.year,
            visibleMonth.month,
            day,
            start.h,
            start.m,
            offsetMinutes
          ),
          endISO: toUtcISO(
            visibleMonth.year,
            visibleMonth.month,
            day,
            end.h,
            end.m,
            offsetMinutes
          ),
        });
      }
    }

    if (cellDateExceedsRange(visibleMonth, rangeEnd)) break;
    const advanced = await clickNextMonth(page);
    if (!advanced) break;
  }

  await saveDebugArtifacts(page, new URL(url).pathname.replace(/\W+/g, "_"));

  return { slots, timeZoneLabel };
}

function cellDateExceedsRange(
  visibleMonth: { year: number; month: number } | null,
  rangeEnd: Date
): boolean {
  if (!visibleMonth) return false;
  const monthStart = new Date(
    Date.UTC(visibleMonth.year, visibleMonth.month - 1, 1)
  );
  return monthStart > rangeEnd;
}

export async function scrapeAvailability(
  urls: string[],
  days: number
): Promise<ScrapeOneResult[]> {
  const browser: Browser = await chromium.launch({ headless: !DEBUG });
  try {
    const results: ScrapeOneResult[] = [];
    for (const url of urls) {
      const context = await browser.newContext({
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
      });
      const page = await context.newPage();
      try {
        const result = await scrapeOnePage(page, url, days);
        results.push(result);
      } catch (err) {
        await saveDebugArtifacts(page, "error");
        results.push({
          slots: [],
          timeZoneLabel: null,
          error:
            err instanceof Error
              ? err.message
              : "予約ページの読み取りに失敗しました",
        });
      } finally {
        await context.close();
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}
