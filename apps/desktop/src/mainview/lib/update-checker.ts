/**
 * Lightweight update checker — no Tauri updater plugin needed.
 *
 * On startup, fetches the latest release tag from GitHub Releases API.
 * Compares with the current app version (from tauri.conf.json via import).
 * If a newer version exists, returns the release URL so the UI can show
 * a "New version available" banner.
 *
 * No auto-download, no signing, no binary replacement. Just a nudge.
 */

const REPO = "imkarmadev/TwistedFlow";
const CURRENT_VERSION = "1.2.0"; // keep in sync with tauri.conf.json

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github.v3+json" } },
    );
    if (!resp.ok) return null;

    const data = await resp.json();
    const latestTag = (data.tag_name as string) ?? "";
    const latestVersion = latestTag.replace(/^v/, "");

    if (!latestVersion || !isNewer(latestVersion, CURRENT_VERSION)) {
      return null;
    }

    return {
      currentVersion: CURRENT_VERSION,
      latestVersion,
      releaseUrl: data.html_url as string,
    };
  } catch {
    // Network error, rate limit, etc. — silently ignore
    return null;
  }
}

/** True if `a` is newer than `b` (semver comparison). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}
