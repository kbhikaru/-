import { NextRequest, NextResponse } from "next/server";
import { scrapeAvailability } from "@/lib/scrape";
import { intersectAll } from "@/lib/intersect";
import type { CalendarResult, CalendarSource, ScrapeResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const sources: CalendarSource[] | undefined = body?.sources;
  const days: number = Math.min(Math.max(Number(body?.days) || 14, 1), 60);

  if (!Array.isArray(sources) || sources.length < 2) {
    return NextResponse.json(
      { error: "予約ページのURLを2つ以上入力してください。" },
      { status: 400 }
    );
  }

  for (const source of sources) {
    try {
      const parsed = new URL(source.url);
      if (!parsed.hostname.endsWith("google.com")) {
        return NextResponse.json(
          { error: `Google カレンダーの予約ページのURLではありません: ${source.url}` },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: `無効なURLです: ${source.url}` },
        { status: 400 }
      );
    }
  }

  const scraped = await scrapeAvailability(
    sources.map((s) => s.url),
    days
  );

  const calendars: CalendarResult[] = scraped.map((result, i) => ({
    url: sources[i].url,
    label: sources[i].label?.trim() || `カレンダー${i + 1}`,
    timeZone: result.timeZoneLabel,
    slots: result.slots,
    error: result.error,
  }));

  const usable = calendars.filter((c) => !c.error);
  const common =
    usable.length >= 2 ? intersectAll(usable.map((c) => c.slots)) : [];

  const response: ScrapeResponse = { calendars, common };
  return NextResponse.json(response);
}
