/**
 * Phase 0 stand-in for the React Flow canvas. Renders a grid background
 * and a hint card so the shell looks alive. Phase 2 replaces this with
 * the real <ReactFlow /> instance plus node renderers.
 */

import s from "./canvas-placeholder.module.css";

interface CanvasPlaceholderProps {
  projectName: string;
}

export function CanvasPlaceholder({ projectName }: CanvasPlaceholderProps) {
  return (
    <div className={s.canvas}>
      <div className={s.grid} />
      <div className={s.card}>
        <div className={s.cardTitle}>{projectName}</div>
        <div className={s.cardDesc}>Canvas coming in Phase 2 — drop nodes here.</div>
      </div>
    </div>
  );
}
