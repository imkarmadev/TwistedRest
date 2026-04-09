/**
 * Modal for inferring a Zod schema from a sample JSON response.
 *
 * Paste any JSON value, hit Generate, the walker in @twistedrest/core converts
 * it to Zod source code, and clicking Apply replaces the node's schema.
 *
 * The preview pane is read-only — users review the generated source before
 * committing it. Faster than hand-writing schemas for any non-trivial API.
 */

import { useState } from "react";
import { zodFromJsonString } from "@twistedrest/core";
import s from "./json-to-zod-modal.module.css";

interface JsonToZodModalProps {
  onApply: (zodSource: string) => void;
  onClose: () => void;
}

export function JsonToZodModal({ onApply, onClose }: JsonToZodModalProps) {
  const [json, setJson] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    setError(null);
    const result = zodFromJsonString(json);
    if (result === null) {
      setError("Could not parse — make sure this is valid JSON.");
      setGenerated(null);
      return;
    }
    setGenerated(result);
  };

  const apply = () => {
    if (!generated) return;
    onApply(generated);
    onClose();
  };

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <span className={s.title}>Generate schema from JSON</span>
          <button className={s.closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        <div className={s.body}>
          <div className={s.field}>
            <label className={s.label}>Sample JSON</label>
            <textarea
              className={s.textarea}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{ "id": 1, "name": "Alice", "active": true }'
              spellCheck={false}
              rows={10}
              autoFocus
            />
            {error && <div className={s.error}>{error}</div>}
            <div className={s.hint}>
              Paste any response body. Arrays infer the element type from the
              first item; null fields become <code>z.null()</code>.
            </div>
          </div>

          {generated && (
            <div className={s.field}>
              <label className={s.label}>Generated schema</label>
              <pre className={s.preview}>{generated}</pre>
            </div>
          )}
        </div>

        <div className={s.actions}>
          <button className={s.secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={s.secondaryBtn} onClick={generate}>
            Generate
          </button>
          <button
            className={s.primaryBtn}
            onClick={apply}
            disabled={!generated}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
