/**
 * In-app updates.
 *
 * Checks the GitHub Releases `latest.json` feed (tauri-plugin-updater),
 * surfaces an "Update available" chip in the titlebar, and installs on click.
 * All failures are non-fatal: no endpoint / no network / dev builds simply
 * mean no chip.
 */

import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isActive, useStore } from "../store";

let pending: Update | null = null;

export async function checkForUpdates(opts: { silent: boolean }): Promise<void> {
  const st = useStore.getState();
  try {
    const update = await check();
    if (update) {
      pending = update;
      st.setUpdateAvailable({ version: update.version, notes: update.body ?? undefined });
    } else {
      pending = null;
      st.setUpdateAvailable(undefined);
      if (!opts.silent) {
        await message("You're on the latest version.", { title: "The Orchestrator" });
      }
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // A signature failure is not "offline" — it means the feed served an
    // artifact that does not verify against our pinned key. Silent mode must
    // not swallow that; it is the one updater error worth interrupting for.
    if (/signature|minisign|verif/i.test(msg)) {
      st.setEngineError({
        kind: "configuration",
        message: `Update signature verification failed — the update was NOT installed. (${msg})`,
      } as never);
      return;
    }
    // Everything else is expected in dev builds and before the feed exists.
    if (!opts.silent) {
      await message(`Could not check for updates: ${msg}`, {
        title: "The Orchestrator",
        kind: "warning",
      });
    }
  }
}

export async function installUpdate(): Promise<void> {
  const st = useStore.getState();
  if (!pending || st.updateBusy) return;
  st.setUpdateBusy(true);
  try {
    // The chip may be hours old and more releases may have shipped since.
    // Re-check at click time so one install always lands on the LATEST
    // version — never a stale middle release that asks for a second update.
    // check() resolving null is AUTHORITATIVE (nothing to install — yanked or
    // already current) and must not fall back to the stale pending update;
    // only a rejected check (offline) keeps it.
    let update = pending;
    try {
      const fresh = await check();
      if (fresh === null) {
        pending = null;
        st.setUpdateAvailable(undefined);
        st.setUpdateBusy(false);
        return;
      }
      update = fresh;
    } catch {
      /* could not re-check — proceed with the update we already know about */
    }
    pending = update;
    st.setUpdateAvailable({ version: update.version, notes: update.body ?? undefined });
    await update.downloadAndInstall();
    st.setUpdateBusy(false);
    // Count running sessions NOW — the download took a while and the
    // function-start snapshot is stale.
    const running = Object.values(useStore.getState().sessions).filter((v) =>
      isActive(v.summary.runState),
    ).length;
    const restart = await ask(
      running > 0
        ? `Update ${update.version} is installed. Restarting now will stop ${running} running session${running === 1 ? "" : "s"}. Restart?`
        : `Update ${update.version} is installed. Restart now?`,
      { title: "The Orchestrator", kind: "info" },
    );
    if (restart) await relaunch();
  } catch (e) {
    st.setUpdateBusy(false);
    await message(`Update failed: ${String((e as Error)?.message ?? e)}`, {
      title: "The Orchestrator",
      kind: "error",
    });
  }
}
