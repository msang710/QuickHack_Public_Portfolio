import type { MessageShape } from "@/quickhack_shared/i18n/message-contract";
import type { desktopKo } from "../ko/desktop.ts";

export const desktopEn = {
  commandPalette: { title: "QuickHack commands", description: "Shows only authorized menus and safe desktop actions.", search: "Search menus or actions", output: { title: "Output preview window", description: "Monitor the current output task on another display" }, adb: { title: "ADB device tools window", description: "Keep connected-device status visible in a separate window" }, empty: "No menus match the current search." },
  outputWindow: { loading: "Checking output status.", loadFailed: "Could not load output status.", blocker: "Blocking reason", title: "Output preview", description: "This is a read-only window. Confirm output and change inventory or tracking information only in the main window.", revision: "Revision {revision, number}", count: "{count, plural, one {# item} other {# items}}", verified: "The current batch was revalidated against the server.", select: "Select a preview batch from the tracking-output screen in the main window.", status: { NOT_PRINTED: "Not printed", SPOOLED: "Sent to print queue", PARTIAL: "Partially printed", CONFIRMED: "Print confirmed", FAILED: "Print failed", UNKNOWN: "Print result unknown" }, blockerCode: { ISSUE_ITEM_NOT_ALLOCATED: "The tracking item is not allocated for output.", CARRIER_SHIPMENT_MISSING: "The current carrier shipment is not connected.", INVALID_TRACKING_NUMBER: "The Logen tracking-number format is invalid.", PACKAGE_GROUP_NOT_READY: "The combined package is not ready for output.", LOGEN_REGISTRATION_NOT_READY: "Logen shipment registration is not complete.", LABEL_SNAPSHOT_INCOMPLETE: "Information required for label output is missing.", ISSUE_BATCH_NOT_ALLOCATED: "The tracking batch is not allocated for output.", ISSUE_BATCH_EMPTY: "The tracking batch contains no output items.", LABEL_BATCH_TOO_LARGE: "The batch exceeds the number of labels allowed per print.", SHIPMENT_RETURN_CONFLICT: "The shipment includes an active return workflow." } },
  adbWindow: { title: "ADB device tools", description: "Selected actions are rejected if the list revision changes.", refresh: "Refresh", empty: "No devices are connected.", check: "Check status", loadFailed: "Could not load the ADB device list.", checkFailed: "Could not check device status", checkResult: "{serial}: {state}" },
  updateStatus: { desktop: "Desktop", apply: "Apply update", checkAgain: "Check again", checking: "Checking for updates.", latest: "You are using the latest version.", downloading: "Downloading the update.", ready: "The update is ready to apply.", applying: "Applying the update.", failed: "The update operation failed.", unavailable: "Updates are not available in this package.", unknown: "The update status is unavailable.", nativeStartFailureTitle: "QuickHack failed to start", nativeStartFailureBody: "QuickHack could not start. Review the runtime logs." },
  notificationCenter: { aria: "{count, plural, one {# notification} other {# notifications}}", empty: "No new notifications.", messages: {
    inspectionComplete: { title: "Inspection saved", body: "Inspection results for {pgNo} were saved." },
    inspectionCompleteGrouped: { title: "{count, plural, one {# inspection completed} other {# inspections completed}}", body: "{count, plural, one {# inspection result was saved} other {# inspection results were saved}}." },
    shipmentAddressChange: { title: "Shipping-address change request", body: "A sales-channel shipping-address change request was received." },
    returnRequest: { title: "Return request received", body: "A sales-channel return request was synchronized." },
  } },
  appearance: {
    title: "Display and desktop",
    theme: "Theme",
    font: "Font",
    fontSize: "Base font size · {size}px",
    scale: "UI scale · {percent}%",
    system: "System setting",
    light: "Light",
    dark: "Dark",
    systemFont: "System default",
    compactFont: "Compact workspace",
    browser: "Development web",
    reset: "Restore defaults",
    note: "These settings are stored on this PC and do not affect label or invoice print sizes.",
  },
  windows: { output: "Output tasks", adb: "ADB device tools" },
} as const satisfies MessageShape<typeof desktopKo>;
