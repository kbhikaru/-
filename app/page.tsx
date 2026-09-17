"use client";

import { useState } from "react";
import type { CalendarSource, ScrapeResponse } from "@/lib/types";
import { encodeShare } from "@/lib/encode";
import { groupSlotsByDay, formatSlotRange } from "@/lib/format";

type FormSource = CalendarSource & { id: number };

let nextId = 2;

export default function Home() {
  const [sources, setSources] = useState<FormSource[]>([
    { id: 0, url: "", label: "自分" },
    { id: 1, url: "", label: "相手" },
  ]);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScrapeResponse | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  function updateSource(id: number, patch: Partial<CalendarSource>) {
    setSources((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s))
    );
  }

  function addSource() {
    setSources((prev) => [
      ...prev,
      { id: nextId++, url: "", label: `カレンダー${prev.length + 1}` },
    ]);
  }

  function removeSource(id: number) {
    setSources((prev) =>
      prev.length > 2 ? prev.filter((s) => s.id !== id) : prev
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setShareUrl(null);

    const filled = sources.filter((s) => s.url.trim().length > 0);
    if (filled.length < 2) {
      setError("予約ページのURLを2つ以上入力してください。");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: filled.map(({ url, label }) => ({ url, label })),
          days,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "取得に失敗しました。");
        return;
      }
      setResult(data as ScrapeResponse);
    } catch {
      setError("通信エラーが発生しました。時間をおいて再度お試しください。");
    } finally {
      setLoading(false);
    }
  }

  function handleShare() {
    if (!result) return;
    const encoded = encodeShare({
      labels: result.calendars.map((c) => c.label),
      common: result.common,
      generatedAt: new Date().toISOString(),
    });
    const url = `${window.location.origin}/share?d=${encoded}`;
    setShareUrl(url);
    navigator.clipboard?.writeText(url).catch(() => {});
  }

  const groups = result ? groupSlotsByDay(result.common) : [];

  return (
    <main>
      <h1>空き日程マッチ</h1>
      <p className="subtitle">
        Google カレンダーの予約ページのリンクを2つ以上入力すると、共通の空き時間を計算して先方に共有できます。
      </p>

      <form className="panel" onSubmit={handleSubmit}>
        {sources.map((source, i) => (
          <div className="url-row" key={source.id}>
            <input
              type="text"
              placeholder={`名前 (例: 田中)`}
              style={{ maxWidth: 120 }}
              value={source.label ?? ""}
              onChange={(e) =>
                updateSource(source.id, { label: e.target.value })
              }
            />
            <input
              type="url"
              placeholder="https://calendar.google.com/calendar/appointments/..."
              value={source.url}
              onChange={(e) =>
                updateSource(source.id, { url: e.target.value })
              }
              required={i < 2}
            />
            <button
              type="button"
              className="ghost"
              onClick={() => removeSource(source.id)}
              disabled={sources.length <= 2}
              aria-label="削除"
            >
              ×
            </button>
          </div>
        ))}

        <button type="button" className="ghost" onClick={addSource}>
          + 予約ページを追加
        </button>

        <div className="row" style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="days">何日先まで調べるか</label>
            <input
              id="days"
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </div>
          <button className="primary" type="submit" disabled={loading}>
            {loading ? "空き時間を計算中…" : "共通の空き時間を計算"}
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </form>

      {result && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>各カレンダーの取得結果</h2>
          {result.calendars.map((c) => (
            <div key={c.url} style={{ marginBottom: 10 }}>
              <p className="calendar-status" style={{ marginBottom: 2 }}>
                {c.label}:{" "}
                {c.error
                  ? `取得エラー (${c.error})`
                  : `${c.slots.length} 件の空き枠を検出 / タイムゾーン: ${
                      c.timeZone ?? "検出できず(デフォルトのJSTで計算)"
                    }`}
              </p>
              {!c.error && c.slots.length > 0 && (
                <p className="calendar-status" style={{ marginBottom: 0 }}>
                  最初の枠の例:{" "}
                  {c.slots
                    .slice(0, 3)
                    .map((s) => formatSlotRange(s))
                    .join(" / ")}
                </p>
              )}
            </div>
          ))}

          <h2>共通の空き時間</h2>
          {groups.length === 0 && (
            <p className="empty">
              条件に合う共通の空き時間が見つかりませんでした。
            </p>
          )}
          <ul className="slot-list">
            {groups.map((group) => (
              <li key={group.day}>
                <div className="slot-day">{group.day}</div>
                {group.slots.map((slot, idx) => (
                  <div className="slot-item" key={idx}>
                    <span>{formatSlotRange(slot)}</span>
                  </div>
                ))}
              </li>
            ))}
          </ul>

          {groups.length > 0 && (
            <>
              <button className="primary" onClick={handleShare}>
                共有リンクを作成してコピー
              </button>
              {shareUrl && (
                <div className="share-box">
                  <input readOnly value={shareUrl} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}
