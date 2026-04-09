/**
 * Generate a curl command from the last HTTP request's metadata.
 *
 * Reads the `_request` field from the executor's result map and
 * assembles a copy-pasteable curl command with method, URL, headers,
 * and body.
 */

export interface RequestMeta {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  status?: number;
}

export function buildCurl(req: RequestMeta, body?: string): string {
  const parts: string[] = ["curl"];

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    parts.push(`-X ${method}`);
  }

  parts.push(`'${req.url ?? ""}'`);

  for (const [k, v] of Object.entries(req.headers ?? {})) {
    parts.push(`-H '${k}: ${v}'`);
  }

  if (body && method !== "GET" && method !== "HEAD") {
    // Escape single quotes in the body
    const escaped = body.replace(/'/g, "'\\''");
    parts.push(`-d '${escaped}'`);
  }

  return parts.join(" \\\n  ");
}

export async function copyCurlToClipboard(
  result: Record<string, unknown> | undefined,
  nodeData?: { body?: string },
): Promise<boolean> {
  if (!result?._request) return false;

  const req = result._request as RequestMeta;
  const curl = buildCurl(req, nodeData?.body);

  try {
    await navigator.clipboard.writeText(curl);
    return true;
  } catch {
    return false;
  }
}
