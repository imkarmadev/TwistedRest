/**
 * Title bar drag region for the gap between the sidebar island and the
 * inspector island. Empty div with `data-tauri-drag-region` so dragging
 * anywhere in this strip moves the window. Sidebar/inspector handle
 * dragging in their own corners via their internal drag handles.
 */

import s from "./title-bar.module.css";

export function TitleBar() {
  return <div data-tauri-drag-region className={s.titleBar} />;
}
