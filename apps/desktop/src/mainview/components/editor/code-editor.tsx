/**
 * Reusable Monaco code editor wrapper. Configured for TypeScript with
 * a dark theme that matches our app's design tokens.
 *
 * Used by:
 *   - Function node inspector (for the function body)
 *   - Potentially the Zod schema editor in the future (upgrade from textarea)
 *
 * Monaco is heavy (~5MB) but we're a desktop app so bundle size doesn't
 * matter. The UX improvement over a plain textarea is massive: syntax
 * highlighting, bracket matching, auto-indent, error squiggles, minimap.
 */

import { useRef, useCallback } from "react";
import Editor, { type OnMount, type OnChange } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Language mode. Defaults to "typescript". */
  language?: string;
  /** Height in pixels. Defaults to 200. */
  height?: number;
  /** Placeholder shown when the editor is empty (via aria-label). */
  placeholder?: string;
  /** Extra type declarations injected before the user code so Monaco
   *  can provide autocomplete for `inputs.*` fields etc. */
  extraLibs?: Array<{ content: string; filePath: string }>;
}

export function CodeEditor({
  value,
  onChange,
  language = "typescript",
  height = 200,
  placeholder = "",
  extraLibs,
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Define a dark theme that matches TwistedRest's design tokens
      monaco.editor.defineTheme("twistedrest-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "comment", foreground: "636366" },
          { token: "keyword", foreground: "c177ff" },
          { token: "string", foreground: "ff5fb1" },
          { token: "number", foreground: "7fff7f" },
          { token: "type", foreground: "4cc2ff" },
        ],
        colors: {
          "editor.background": "#0d1117",
          "editor.foreground": "#e8e8ed",
          "editor.lineHighlightBackground": "#1a1f2e",
          "editor.selectionBackground": "#264f78",
          "editorCursor.foreground": "#4cc2ff",
          "editorLineNumber.foreground": "#636366",
          "editorLineNumber.activeForeground": "#8e8e93",
          "editor.inactiveSelectionBackground": "#1a1f2e",
        },
      });
      monaco.editor.setTheme("twistedrest-dark");

      // Inject extra type declarations for autocomplete
      if (extraLibs) {
        for (const lib of extraLibs) {
          monaco.languages.typescript.typescriptDefaults.addExtraLib(
            lib.content,
            lib.filePath,
          );
        }
      }

      // Compact config for small editors (no minimap, no folding gutters)
      editor.updateOptions({
        minimap: { enabled: false },
        folding: false,
        lineNumbers: "on",
        lineNumbersMinChars: 3,
        glyphMargin: false,
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        fontSize: 12,
        fontFamily:
          "'SF Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 8, bottom: 8 },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
        },
      });
    },
    [extraLibs],
  );

  const handleChange: OnChange = useCallback(
    (val) => {
      onChange(val ?? "");
    },
    [onChange],
  );

  return (
    <div
      style={{
        height,
        borderRadius: 6,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <Editor
        height={height}
        language={language}
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        theme="vs-dark"
        loading={
          <div
            style={{
              height,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#636366",
              fontSize: 12,
            }}
          >
            Loading editor…
          </div>
        }
        options={{
          // Initial options — handleMount overrides with the full theme
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
