/**
 * Shared console state for the bottom workspace's Console tab.
 *
 * The Log node (an exec-chain node) calls into the executor's onLog
 * callback when reached; the callback in App.tsx pushes a new entry
 * here, and the bottom workspace console view reads from this context.
 *
 * Lives in App.tsx, not in FlowCanvas, because the workspace chrome is a
 * top-level UI surface that can be toggled independently of the
 * canvas state and persists across flow switches.
 */

import { createContext, useContext } from "react";

export interface ConsoleEntry {
  id: string;
  /** Unix ms */
  timestamp: number;
  /** Node id that emitted this entry. Used to navigate back to the source. */
  nodeId: string;
  /** Display label — usually the node's configured label, fallback "Log". */
  label: string;
  /** The value passed in. Can be anything. */
  value: unknown;
}

export interface ConsoleContextValue {
  entries: ConsoleEntry[];
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
  clear: () => void;
  /** Called by the executor's onLog callback. */
  append: (entry: Omit<ConsoleEntry, "id" | "timestamp">) => void;
}

export const ConsoleContext = createContext<ConsoleContextValue>({
  entries: [],
  isOpen: false,
  toggle: () => {},
  open: () => {},
  close: () => {},
  clear: () => {},
  append: () => {},
});

export function useConsole(): ConsoleContextValue {
  return useContext(ConsoleContext);
}
