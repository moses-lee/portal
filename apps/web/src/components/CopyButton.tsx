"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

export default function CopyButton({
  text,
  label = "Copy",
  className,
  iconOnly = false,
}: {
  text: string;
  label?: string;
  className?: string;
  /** Keep the idle button compact, showing text only for success or failure feedback. */
  iconOnly?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    setStatus((await copyText(text)) ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 1800);
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      onClick={() => void copy()}
      aria-label={label}
      title={label}
    >
      {status === "copied" ? <Check /> : <Copy />}
      <span
        aria-live="polite"
        className={iconOnly && status === "idle" ? "sr-only" : "text-xs"}
      >
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copy failed"
            : label}
      </span>
    </Button>
  );
}
