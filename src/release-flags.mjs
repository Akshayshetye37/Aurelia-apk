export const RELEASE_FLAGS = Object.freeze({
  uiCutover: false,
  sync: false,
  gatewayPayments: false
});

if (typeof window !== "undefined") window.AURELIA_RELEASE_FLAGS = RELEASE_FLAGS;

export function assertReleaseFlagsOff(flags = RELEASE_FLAGS) {
  const enabled = Object.entries(flags)
    .filter(([name, value]) => ["uiCutover", "sync", "gatewayPayments"].includes(name) && value !== false)
    .map(([name]) => name);
  if (enabled.length) {
    throw new Error("R1 release safety flags must default OFF: " + enabled.join(", "));
  }
  for (const name of ["uiCutover", "sync", "gatewayPayments"]) {
    if (!Object.hasOwn(flags, name)) {
      throw new Error("Missing required R1 release safety flag: " + name);
    }
  }
  return true;
}
