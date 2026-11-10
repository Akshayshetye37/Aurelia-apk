package com.aurelia.pms.debug;

import android.os.Process;

/**
 * Debug-variant-only crash injection hooks. This source is copied exclusively
 * to app/src/debug/java and is absent from release variants.
 */
public final class LocalPmsFaultInjection {
    private static volatile String armedCheckpoint;
    private static volatile boolean killProcess;

    private LocalPmsFaultInjection() {}

    public static void arm(String checkpoint, boolean kill) {
        armedCheckpoint = checkpoint;
        killProcess = kill;
    }

    public static void clear() {
        armedCheckpoint = null;
        killProcess = false;
    }

    public static void checkpoint(String checkpoint) {
        if (armedCheckpoint == null || !armedCheckpoint.equals(checkpoint)) return;
        clear();
        if (killProcess) Process.killProcess(Process.myPid());
        throw new IllegalStateException("debug_fault_injected:" + checkpoint);
    }
}
