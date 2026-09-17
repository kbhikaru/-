import { decodeShare } from "@/lib/encode";
import { groupSlotsByDay, formatSlotRange } from "@/lib/format";

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>;
}) {
  const { d } = await searchParams;
  const payload = d ? decodeShare(d) : null;

  if (!payload) {
    return (
      <main>
        <h1>空き日程マッチ</h1>
        <p className="error">リンクが無効か、壊れています。</p>
      </main>
    );
  }

  const groups = groupSlotsByDay(payload.common);

  return (
    <main>
      <h1>共通の空き時間</h1>
      <p className="subtitle">
        {payload.labels.join(" / ")} の共通の空き時間です(すべて日本時間)。
      </p>

      <div className="panel">
        {groups.length === 0 && (
          <p className="empty">共通の空き時間が見つかりませんでした。</p>
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
      </div>
    </main>
  );
}
