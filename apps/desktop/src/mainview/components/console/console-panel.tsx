/**
 * Bottom-pinned collapsible console panel.
 *
 * Closed: a slim 22px strip across the bottom showing "Console" + a
 * count of new entries since last open.
 *
 * Open: a 240px panel (resizable later) with a header (label, clear,
 * close) and a scrollable list of timestamped log entries from Log nodes.
 *
 * Auto-scrolls to the bottom on new entries when already at the bottom,
 * but holds position if the user scrolled up to read history.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useConsole, type ConsoleEntry } from "../../lib/console-context";
import s from "./console-panel.module.css";

interface ConsolePanelProps {
  /**
   * Pixel inset from the right edge — App passes 356 when the inspector
   * panel is mounted (340 inspector width + 16 gap), 16 otherwise. Lets
   * the console live cleanly between the sidebar island and the inspector.
   */
  insetRight: number;
}

export function ConsolePanel({ insetRight }: ConsolePanelProps) {
  const { entries, isOpen, toggle, clear, close, open } = useConsole();

  // Backtick (`) toggles the console from anywhere. Don't
  // intercept when typing in inputs/textareas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable) return;
      if (e.key === "`" || e.key === "~") {
        e.preventDefault();
        if (isOpen) close();
        else open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, open, close]);

  // Track count of "unread" entries — entries appended while the panel
  // was closed. Resets when the user opens the panel.
  const [unreadCount, setUnreadCount] = useState(0);
  const lastReadCountRef = useRef(0);
  useEffect(() => {
    if (isOpen) {
      lastReadCountRef.current = entries.length;
      setUnreadCount(0);
    } else {
      setUnreadCount(entries.length - lastReadCountRef.current);
    }
  }, [isOpen, entries.length]);

  return isOpen ? (
    <OpenPanel
      entries={entries}
      onClose={close}
      onClear={clear}
      insetRight={insetRight}
    />
  ) : (
    <ClosedStrip
      total={entries.length}
      unread={unreadCount}
      onOpen={toggle}
      insetRight={insetRight}
    />
  );
}

// ─── Closed strip ─────────────────────────────────────────────

function ClosedStrip({
  total,
  unread,
  onOpen,
  insetRight,
}: {
  total: number;
  unread: number;
  onOpen: () => void;
  insetRight: number;
}) {
  return (
    <button
      className={s.strip}
      style={{ right: insetRight }}
      onClick={onOpen}
      title="Open console (` to toggle)"
    >
      <span className={s.stripLabel}>Console</span>
      {total > 0 && (
        <span className={s.stripCount}>
          {total} {total === 1 ? "entry" : "entries"}
          {unread > 0 ? ` · ${unread} new` : ""}
        </span>
      )}
      <span className={s.stripChevron}>▴</span>
    </button>
  );
}

// ─── Open panel ───────────────────────────────────────────────

function OpenPanel({
  entries,
  onClose,
  onClear,
  insetRight,
}: {
  entries: ConsoleEntry[];
  onClose: () => void;
  onClear: () => void;
  insetRight: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Track whether the user is scrolled to the bottom — if they are, new
  // entries auto-scroll. If they've scrolled up to read, we hold position.
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 24;
  };

  // After every render, if we should stick, scroll to bottom
  useEffect(() => {
    if (stickToBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className={s.panel} style={{ right: insetRight }}>
      <div className={s.header}>
        <span className={s.title}>Console</span>
        <span className={s.headerHint}>` to toggle</span>
        <span className={s.spacer} />
        <button className={s.headerBtn} onClick={onClear} title="Clear all entries">
          Clear
        </button>
        <button
          className={`${s.headerBtn} ${s.closeBtn}`}
          onClick={onClose}
          title="Close panel (`)"
        >
          ✕
        </button>
      </div>

      <div ref={listRef} className={s.list} onScroll={onScroll}>
        {entries.length === 0 ? (
          <div className={s.empty}>
            No entries yet. Add a Log node to your flow and pass it a value.
          </div>
        ) : (
          entries.map((e) => <Entry key={e.id} entry={e} />)
        )}
      </div>
    </div>
  );
}

function Entry({ entry }: { entry: ConsoleEntry }) {
  const time = useMemo(() => {
    const d = new Date(entry.timestamp);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  }, [entry.timestamp]);

  const formatted = useMemo(() => formatValue(entry.value), [entry.value]);

  return (
    <div className={s.entry}>
      <span className={s.entryTime}>{time}</span>
      <span className={s.entryLabel}>{entry.label}</span>
      <pre className={s.entryValue}>{formatted}</pre>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
