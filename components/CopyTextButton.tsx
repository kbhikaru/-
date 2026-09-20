"use client";

import { useState } from "react";

export default function CopyTextButton({
  text,
  label = "テキストでコピー",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境向けのフォールバック
      window.prompt("コピーしてください(Ctrl/Cmd+C):", text);
    }
  }

  return (
    <button type="button" onClick={handleClick}>
      {copied ? "コピーしました" : label}
    </button>
  );
}
