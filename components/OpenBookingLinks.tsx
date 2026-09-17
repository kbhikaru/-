type Source = { label: string; url: string };

export default function OpenBookingLinks({ sources }: { sources: Source[] }) {
  return (
    <span className="booking-links">
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {source.label}の予約ページを開く
        </a>
      ))}
    </span>
  );
}
