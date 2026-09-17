import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { Slot } from "./types";

/**
 * Google Calendar の「予約スケジュール」ページ (calendar.google.com/calendar/appointments/...)
 * は公開APIを持たないため、実際に画面をレンダリングして DOM から読み取っている。
 *
 * 実ページの調査で分かったこと: 空き時間ボタンは `data-date-time` 属性に
 * 「その枠の開始時刻」を UTC のミリ秒 Unix タイムスタンプで持っている
 * (例: data-date-time="1789689600000", aria-label="09:00" は 2026-09-18 09:00 JST)。
 * これはテキストやページのタイムゾーン表示を解析するより遥かに正確なので、
 * テキストベースの時刻・タイムゾーン解析は行わず、この属性を直接使う。
 *
 * 日付選択カレンダー側のボタンも同じ内部コンポーネントを再利用しているとみられ、
 * 同様に `data-date-time`(その日の 0 時)を持つ想定で実装している。もし Google 側の
 * マークアップが変わって日付が拾えなくなった場合は、SCRAPE_DEBUG=1 で実行し
 * 保存される /tmp/avail-match-debug-*.png / .html を見ながら調整すること。
 */

const DEBUG = process.env.SCRAPE_DEBUG === "1";

// 時刻枠ボタンの aria-label は "9:00" / "09:00" のような時刻のみのテキストになっている。
// これで「日付セル(フルの日付ラベル)」と「時刻枠(時刻のみのラベル)」を区別する。
const TIME_ONLY_LABEL_RE = /^\d{1,2}:\d{2}$/;

const JST_OFFSET_MS = 9 * 60 * 60_000;
const DEFAULT_SLOT_DURATION_MS = 30 * 60_000;
const MAX_SLOT_DURATION_MS = 2 * 60 * 60_000;

export type ScrapeOneResult = {
  slots: Slot[];
  timeZoneLabel: string | null;
  error?: string;
};

/** "今日 0:00 JST" を絶対 UTC ミリ秒で返す。ホストサーバーのタイムゾーンに依存しない。 */
function jstTodayStartMs(): number {
  const jstNow = new Date(Date.now() + JST_OFFSET_MS);
  return (
    Date.UTC(
      jstNow.getUTCFullYear(),
      jstNow.getUTCMonth(),
      jstNow.getUTCDate()
    ) - JST_OFFSET_MS
  );
}

type DateButton = { locator: Locator; epochMs: number };

/** [data-date-time] を持つ要素のうち、aria-label が「日付」を表すもの(時刻のみではないもの)を集める。 */
async function collectDayButtons(page: Page): Promise<DateButton[]> {
  const all = page.locator("[data-date-time]");
  const count = await all.count();
  const days: DateButton[] = [];
  for (let i = 0; i < count; i++) {
    const el = all.nth(i);
    const label = ((await el.getAttribute("aria-label")) ?? "").trim();
    if (TIME_ONLY_LABEL_RE.test(label)) continue; // これは時刻枠ボタン

    const raw = await el.getAttribute("data-date-time");
    if (!raw) continue;
    const epochMs = Number(raw);
    if (Number.isNaN(epochMs)) continue;

    const ariaDisabled = (await el.getAttribute("aria-disabled")) === "true";
    if (ariaDisabled) continue;
    const isDisabled = await el.isDisabled().catch(() => false);
    if (isDisabled) continue;

    days.push({ locator: el, epochMs });
  }
  return days;
}

/** 現在表示中の時刻枠ボタン(aria-label が時刻のみ)の開始時刻(UTC ミリ秒)一覧を集める。 */
async function collectSlotEpochs(page: Page): Promise<number[]> {
  const all = page.locator("[data-date-time]");
  const count = await all.count();
  const epochs: number[] = [];
  for (let i = 0; i < count; i++) {
    const el = all.nth(i);
    const label = ((await el.getAttribute("aria-label")) ?? "").trim();
    if (!TIME_ONLY_LABEL_RE.test(label)) continue;
    const raw = await el.getAttribute("data-date-time");
    if (!raw) continue;
    const epochMs = Number(raw);
    if (!Number.isNaN(epochMs)) epochs.push(epochMs);
  }
  return epochs;
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

/** 連続する枠の最小間隔を「1枠の長さ」とみなす(例: 30分刻みなら30分)。 */
function inferSlotDurationMs(sortedEpochs: number[]): number {
  let minGap = Infinity;
  for (let i = 1; i < sortedEpochs.length; i++) {
    const gap = sortedEpochs[i] - sortedEpochs[i - 1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap) || minGap <= 0) return DEFAULT_SLOT_DURATION_MS;
  return Math.min(minGap, MAX_SLOT_DURATION_MS);
}

async function scrapeOnePage(
  page: Page,
  url: string,
  days: number
): Promise<ScrapeOneResult> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1000);

  const rangeStartMs = jstTodayStartMs() - 86_400_000; // 前日分の余裕
  const rangeEndMs = jstTodayStartMs() + days * 86_400_000;

  const slotEpochs = new Set<number>();
  const clickedDayEpochs = new Set<number>();

  for (let monthPage = 0; monthPage < 4; monthPage++) {
    const dayButtons = await collectDayButtons(page);
    if (dayButtons.length === 0) break;

    let maxEpochSeen = -Infinity;
    for (const day of dayButtons) {
      maxEpochSeen = Math.max(maxEpochSeen, day.epochMs);
      if (day.epochMs < rangeStartMs || day.epochMs > rangeEndMs) continue;
      if (clickedDayEpochs.has(day.epochMs)) continue;
      clickedDayEpochs.add(day.epochMs);

      try {
        await day.locator.click({ timeout: 5000 });
      } catch {
        continue;
      }
      await page.waitForTimeout(400);

      for (const epoch of await collectSlotEpochs(page)) {
        slotEpochs.add(epoch);
      }
    }

    if (maxEpochSeen >= rangeEndMs) break;
    const advanced = await clickNextMonth(page);
    if (!advanced) break;
  }

  await saveDebugArtifacts(page, new URL(url).pathname.replace(/\W+/g, "_"));

  const sortedEpochs = Array.from(slotEpochs).sort((a, b) => a - b);
  const durationMs = inferSlotDurationMs(sortedEpochs);
  const slots: Slot[] = sortedEpochs.map((epoch) => ({
    startISO: new Date(epoch).toISOString(),
    endISO: new Date(epoch + durationMs).toISOString(),
  }));

  return {
    slots,
    timeZoneLabel: "ページのタイムスタンプ(UTC)を直接使用",
  };
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
