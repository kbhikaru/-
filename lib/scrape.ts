import { chromium, type Browser, type Page } from "playwright";
import type { Slot } from "./types";

/**
 * Google Calendar の「予約スケジュール」ページ (calendar.google.com/calendar/appointments/...)
 * は公開APIを持たないため、実際に画面をレンダリングして DOM から読み取っている。
 *
 * 実ページの調査(利用者が DevTools で確認)で分かったこと:
 * - ページは「小さいカレンダーで日付をクリックして枠を切り替える」形式ではなく、
 *   日付ごとのセクション (`<div role="list" aria-label="2026年 9月 18日 ...">`) が
 *   縦に並んだリスト形式。クリック操作は不要で、下にスクロールすると
 *   さらに先の日付のセクションが読み込まれる。
 * - 各時刻枠は `<button data-date-time="1789686000000" aria-label="08:00">` のように、
 *   開始時刻を **UTC ミリ秒の Unix タイムスタンプ** で持っている
 *   (1789686000000 は 2026-09-18T08:00 JST)。テキストやページのタイムゾーン表示を
 *   解析するより遥かに正確なので、この属性を直接使う。
 *
 * もし Google 側のマークアップが変わってこの方式が通用しなくなった場合は、
 * SCRAPE_DEBUG=1 で実行し保存される /tmp/avail-match-debug-*.png / .html を
 * 見ながら `collectSlotEpochs` / `scrollForMore` を調整すること。
 */

const DEBUG = process.env.SCRAPE_DEBUG === "1";

// 時刻枠ボタンの aria-label は "9:00" / "09:00" のような時刻のみのテキストになっている。
const TIME_ONLY_LABEL_RE = /^\d{1,2}:\d{2}$/;

const JST_OFFSET_MS = 9 * 60 * 60_000;
const DEFAULT_SLOT_DURATION_MS = 30 * 60_000;
const MAX_SLOT_DURATION_MS = 2 * 60 * 60_000;
const MAX_SCROLL_ITERATIONS = 25;
const MAX_STALE_SCROLLS = 3;

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

/** ページ上に現在レンダリングされている時刻枠ボタンの開始時刻(UTC ミリ秒)一覧を集める。 */
async function collectSlotEpochs(page: Page): Promise<number[]> {
  return page.evaluate((timeOnlyPattern) => {
    const re = new RegExp(timeOnlyPattern);
    const epochs: number[] = [];
    for (const el of Array.from(document.querySelectorAll("[data-date-time]"))) {
      const label = (el.getAttribute("aria-label") ?? "").trim();
      if (!re.test(label)) continue;
      const raw = el.getAttribute("data-date-time");
      if (!raw) continue;
      const epochMs = Number(raw);
      if (!Number.isNaN(epochMs)) epochs.push(epochMs);
    }
    return epochs;
  }, TIME_ONLY_LABEL_RE.source);
}

/**
 * さらに先の日付を読み込ませるためにスクロールする。ウィンドウ全体だけでなく、
 * 内部にスクロール可能な要素があればそれも一番下までスクロールしておく
 * (実際の予約ページのスクロールコンテナが不明なため、両方試す)。
 */
async function scrollForMore(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      if (el.scrollHeight > el.clientHeight + 80) {
        el.scrollTop = el.scrollHeight;
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.mouse.wheel(0, 1200);
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

/** 連続する枠の最小間隔を「1枠の長さ」とみなす(例: 1時間刻みなら1時間)。 */
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

  const rangeEndMs = jstTodayStartMs() + days * 86_400_000;

  const slotEpochs = new Set<number>();
  let staleScrolls = 0;

  for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
    const before = slotEpochs.size;
    for (const epoch of await collectSlotEpochs(page)) {
      slotEpochs.add(epoch);
    }

    const maxEpochSoFar = slotEpochs.size
      ? Math.max(...slotEpochs)
      : -Infinity;
    if (maxEpochSoFar >= rangeEndMs) break;

    if (slotEpochs.size === before) {
      staleScrolls++;
      if (staleScrolls >= MAX_STALE_SCROLLS) break; // これ以上増えない = 読み込み終わり
    } else {
      staleScrolls = 0;
    }

    await scrollForMore(page);
    await page.waitForTimeout(600);
  }

  await saveDebugArtifacts(page, new URL(url).pathname.replace(/\W+/g, "_"));

  const sortedEpochs = Array.from(slotEpochs)
    .filter((epoch) => epoch < rangeEndMs)
    .sort((a, b) => a - b);
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
