/**
 * Runtime-only OMP setting overrides for the one session this worker owns.
 *
 * `Settings.init` is a memoized process singleton and each worker holds
 * exactly one session, so an override here is a per-session override that is
 * never written to the user's OMP config.
 *
 * OMP 18.4 removed `Settings.override(path, value)` in favour of per-setting
 * handles from its settings registry (`lookup(id).override(settings, value)`).
 * The worker used to probe for the old method and silently skip when it was
 * missing — which, for `tools.approvalMode` (default "yolo"), would have
 * quietly turned "always ask" into full access. Every path here therefore
 * throws when an override cannot be applied, and `overrideVerified` reads the
 * value back so a caller enforcing a security setting can fail closed.
 */

/** The slice of an OMP settings-registry handle this module uses. */
export interface SettingHandle {
  override(scope: unknown, value: unknown): void;
  get(scope: unknown): unknown;
}

/** `lookup` from `@oh-my-pi/pi-coding-agent/config/registry`. */
export type SettingLookup = (id: string) => SettingHandle | undefined;

export interface SettingOverrides {
  /** Apply a runtime override. Throws when OMP offers no way to apply it. */
  override(id: string, value: unknown): void;
  /** Current effective value, or undefined when the setting is unknown. */
  read(id: string): unknown;
  /** Override, then confirm the effective value equals `value`. Throws otherwise. */
  overrideVerified(id: string, value: unknown): void;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function settingOverrides(
  settings: unknown,
  lookup: SettingLookup | undefined,
): SettingOverrides {
  const legacy = settings as {
    override?: (id: string, value: unknown) => void;
    get?: (id: string) => unknown;
  };

  const override = (id: string, value: unknown): void => {
    const handle = lookup?.(id);
    if (handle) {
      handle.override(settings, value);
      return;
    }
    // Pre-18.4 OMP: path-addressed override on the Settings instance.
    if (typeof legacy?.override === "function") {
      legacy.override.call(settings, id, value);
      return;
    }
    throw new Error(`The embedded OMP offers no way to override the setting "${id}".`);
  };

  const read = (id: string): unknown => {
    const handle = lookup?.(id);
    if (handle) return handle.get(settings);
    return typeof legacy?.get === "function" ? legacy.get.call(settings, id) : undefined;
  };

  return {
    override,
    read,
    overrideVerified(id, value) {
      override(id, value);
      const actual = read(id);
      if (!sameValue(actual, value)) {
        throw new Error(
          `The setting "${id}" did not take effect: wanted ${JSON.stringify(value)}, OMP reports ${JSON.stringify(actual)}.`,
        );
      }
    },
  };
}

/** Load OMP's settings-registry lookup, or undefined on an OMP without one. */
export async function loadSettingLookup(): Promise<SettingLookup | undefined> {
  try {
    const registry = (await import("@oh-my-pi/pi-coding-agent/config/registry")) as {
      lookup?: SettingLookup;
    };
    return typeof registry.lookup === "function" ? registry.lookup : undefined;
  } catch {
    return undefined;
  }
}
