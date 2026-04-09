/**
 * Searchable node palette — UE-style "right-click → search → enter".
 *
 * Floats at a viewport position (the click point), search input on top,
 * categorized list of node defs underneath. Keyboard nav ↑↓, Enter spawns,
 * Escape closes. The palette knows nothing about React Flow — the parent
 * passes in a filter (used by drag-pin-drop to restrict to compatible
 * targets) and an onSelect callback that handles spawning.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  NODE_REGISTRY,
  listCategories,
  type NodeCategory,
  type NodeTypeDef,
} from "../../lib/node-registry";
import s from "./node-palette.module.css";

export interface NodePaletteProps {
  /** Viewport-coordinate anchor point (where the user clicked or dropped). */
  position: { x: number; y: number };

  /**
   * Optional filter to restrict the visible node defs. Used by the
   * drag-pin-drop spawner to show only nodes that have a compatible input
   * pin for the dragged source.
   */
  filter?: (def: NodeTypeDef) => boolean;

  /** Called when the user picks a node. */
  onSelect: (def: NodeTypeDef) => void;

  /** Called when the user dismisses the palette (Escape, click outside). */
  onClose: () => void;

  /** Optional header label, e.g. "Compatible nodes" when filtering. */
  title?: string;
}

export function NodePalette({
  position,
  filter,
  onSelect,
  onClose,
  title = "Add Node",
}: NodePaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Apply the optional filter, then the search query
  const filtered = useMemo(() => {
    const base = filter ? NODE_REGISTRY.filter(filter) : NODE_REGISTRY;
    if (!query.trim()) return base;
    const q = query.toLowerCase();
    return base.filter(
      (def) =>
        def.label.toLowerCase().includes(q) ||
        def.description.toLowerCase().includes(q) ||
        def.category.toLowerCase().includes(q),
    );
  }, [filter, query]);

  // Group filtered list by category, preserving registry order
  const grouped = useMemo(() => {
    const out: Array<{ category: NodeCategory; items: NodeTypeDef[] }> = [];
    for (const cat of listCategories()) {
      const items = filtered.filter((d) => d.category === cat);
      if (items.length > 0) out.push({ category: cat, items });
    }
    return out;
  }, [filtered]);

  // Flatten the grouped list so the keyboard navigation has a single index space
  const flatList = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // Reset selection when the visible list changes
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered]);

  // Autofocus search on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keyboard navigation
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const def = flatList[activeIndex];
      if (def) onSelect(def);
    }
  };

  // Clamp the palette to the viewport so it never overflows the right/bottom edges
  const PALETTE_W = 320;
  const PALETTE_H_MAX = 420;
  const x = Math.min(position.x, window.innerWidth - PALETTE_W - 8);
  const y = Math.min(position.y, window.innerHeight - PALETTE_H_MAX - 8);

  return (
    <>
      {/* invisible click-outside catcher */}
      <div className={s.backdrop} onClick={onClose} />
      <div
        className={s.palette}
        style={{ left: x, top: y, width: PALETTE_W }}
        onKeyDown={onKeyDown}
        // Stop React Flow from grabbing keys / pointer events
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={s.header}>
          <span className={s.title}>{title}</span>
        </div>
        <input
          ref={inputRef}
          className={s.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes…"
          spellCheck={false}
        />
        <div className={s.list}>
          {grouped.length === 0 && (
            <div className={s.empty}>No matching nodes</div>
          )}
          {grouped.map((g) => (
            <div key={g.category} className={s.group}>
              <div className={s.groupLabel}>{g.category}</div>
              {g.items.map((def) => {
                const flatIdx = flatList.indexOf(def);
                const active = flatIdx === activeIndex;
                return (
                  <button
                    key={def.type}
                    className={`${s.item} ${active ? s.itemActive : ""}`}
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onClick={() => onSelect(def)}
                  >
                    <div className={s.itemLabel}>{def.label}</div>
                    <div className={s.itemDesc}>{def.description}</div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
