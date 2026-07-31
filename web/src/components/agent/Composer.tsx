import { useEffect, useRef, useState } from "react";

const COMMANDS = [
  { cmd: "/watch", hint: "set a new objective and cadence" },
  { cmd: "/mode", hint: "change autonomy mode and limits" },
  { cmd: "/graph", hint: "open the live composition graph" },
  { cmd: "/ledger", hint: "show what has been spent" },
  { cmd: "/halt", hint: "stop everything immediately" },
];

export function Composer({
  onSend,
  disabled,
  accountLabel,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  accountLabel?: string;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const showPalette = value.startsWith("/") && !value.includes(" ");

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
    ref.current?.focus();
  };

  return (
    <div className="relative">
      {showPalette && (
        <ul className="absolute bottom-full mb-2 w-full max-w-sm overflow-hidden rounded-lg border border-line bg-card shadow-lg">
          {COMMANDS.filter((c) => c.cmd.startsWith(value)).map((c) => (
            <li key={c.cmd}>
              <button
                type="button"
                onClick={() => {
                  setValue(`${c.cmd} `);
                  ref.current?.focus();
                }}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-hover"
              >
                <span className="font-mono text-[12px] text-ink">{c.cmd}</span>
                <span className="text-[11.5px] text-ink-3">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-lg border border-line bg-card p-2 transition-colors focus-within:border-ink-3">
        <textarea
          ref={ref}
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Tell the agent what to watch, or type / for commands"
          className="w-full resize-none bg-transparent px-1.5 py-1 text-[13px] text-ink outline-none placeholder:text-ink-3"
        />
        <div className="flex items-center justify-between px-1.5">
          <span className="font-mono text-[11px] text-ink-3">
            {accountLabel || "No account connected"}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="rounded-control bg-ink px-3 py-1.5 text-[12px] font-medium text-background transition-opacity disabled:opacity-30"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
