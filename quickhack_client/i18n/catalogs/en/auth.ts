import type { MessageShape } from "@/quickhack_shared/i18n/message-contract";
import type { authKo } from "../ko/auth.ts";

export const authEn = {
  sensitiveAction: {
    recoveryLabel: "Sensitive-menu OTP recovery codes", title: "Two-factor authentication required", description: "The {menu} menu affects channel products and order matching, so an OTP code is required. If OTP is not configured, enroll it on the right first.", code: "OTP code", checking: "Checking authentication", submitting: "Verifying", open: "Verify and open", recoveryRequired: "Store the OTP recovery codes safely and select 'Stored' first.",
    message: { authStatusFailed: "Failed to check the authentication status.", invalidMenu: "This menu is not a valid two-factor authentication target.", qrFailed: "Failed to create the QR code. Enter the authenticator enrollment key manually.", setupCodePrompt: "Enroll the OTP key in your authenticator app, then enter the six-digit code.", setupComplete: "OTP enrollment is complete. Use an OTP code for future two-factor authentication.", setupConfirmFailed: "Failed to verify the OTP code.", setupStartFailed: "Failed to start OTP enrollment.", statusFailed: "Failed to check OTP status.", verifyFailed: "OTP verification failed." },
    setup: { title: "OTP enrollment", description: "After enrollment, sensitive menus are verified with a six-digit authenticator code.", loading: "Checking OTP status", enabled: "OTP two-factor authentication is configured for this account.", unavailable: "Protected actions are blocked because the OTP security service is unavailable. An administrator must check OTP security status from the primary QuickHack server console.", password: "Current password", start: "Start OTP enrollment", qrAlt: "Google OTP enrollment QR code", qrLoading: "Creating QR code", qrHint: "Scan the QR code in Google Authenticator.", secret: "Authenticator enrollment key", uri: "Enrollment URI", code: "Six-digit authenticator code", confirm: "Complete OTP enrollment" },
    dialog: { cancel: "Cancel", busy: "Processing" }
  },
  login: {
    brandSubtitle: "Internal ERP/WMS",
    heroTitle: "Employee sign in",
    heroDescription: "Manage device, inbound, inspection, inventory, order, shipment and return data with your employee account.",
    title: "Sign in",
    description: "Use the employee account issued to you.",
    username: "Username",
    password: "Password",
    submit: "Sign in",
    pending: "Signing in...",
    testAccount: "Test accounts",
    errors: { failed: "Sign-in failed.", unavailable: "The server is unavailable.", timeout: "The server response timed out. Try again shortly.", invalidServerResponse: "The central server returned an invalid response.", invalidCredentials: "The username or password is incorrect.", bodyTooLarge: "The sign-in request is too large.", credentialsRequired: "Enter both username and password.", invalidRequest: "The sign-in request is invalid.", rateLimited: "Too many failed sign-in attempts. Try again in {seconds, plural, one {# second} other {# seconds}}." },
  },
  passwordChange: {
    title: "Change password", forcedTitle: "Set a new password", currentPassword: "Current password", nextPassword: "New password", confirmPassword: "Confirm new password",
    description: { forced: "Change the temporary password to one only you know before using the workspace.", normal: "After the change, all existing sessions, including sessions on other PCs, will be signed out." },
    minimum: "The new password must be at least {count, number} characters.", submitting: "Changing", success: "Password changed.", failed: "Could not change the password.",
    validation: { currentRequired: "Enter your current password.", tooShort: "The new password must be at least {count, number} characters.", mismatch: "The new password confirmation does not match.", unchanged: "Enter a new password that differs from the current password.", currentInvalid: "The current password is incorrect.", securityChanged: "Account security information was changed by another request. Sign in again and retry." },
  },
  passwordRequired: { subtitle: "Internal ERP/WMS", title: "Password change required", description: "The {name} account signed in with a temporary password. Work menus and other account settings remain unavailable until a new password is set.", logout: "Log out", logoutFailed: "Failed to log out." },
} as const satisfies MessageShape<typeof authKo>;
