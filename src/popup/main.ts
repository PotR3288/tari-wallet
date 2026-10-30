import "./styles.css";
import type { AccountSummary, DaemonAccountOption, PendingApproval, PopupRequest, TransactionHistoryEntry, TransactionPreview, WalletStatus } from "../lib/messages";
import { LANGUAGE_LABELS, getLanguage, setLanguage, t, type Language } from "../lib/i18n";
import { isPlausibleMnemonic } from "../lib/cipherSeed";
import { AUTO_LOCK_OPTIONS, formatAutoLockOption } from "../lib/autoLock";
import { summarizeArgs, summarizeInstruction } from "../lib/instructionSummary";
import { avatarSvg } from "../lib/avatar";
import { estimatePasswordStrength, isBlockedPassword } from "../lib/passwordStrength";
import { qrCodeSvg } from "../lib/qr";
import {
  type Balance,
  MAX_DAEMON_LABEL_LENGTH,
  TARI_RESOURCE_ADDRESS,
  deriveWebUiApiKeysUrl,
  formatBalanceAmount,
  formatBalanceAmountGrouped,
  isValidComponentAddress,
  isValidOotleWalletAddress,
  normalizeDaemonUrl,
  parseDecimalToRaw,
  resourceLabel,
  shortAddr,
  tokenInitial,
} from "./format";

const app = document.getElementById("app")!;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendOnce<T>(message: PopupRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: { ok: boolean; result?: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) reject(new Error(response?.error ?? t("common.unknownError")));
      else resolve(response.result as T);
    });
  });
}

// A freshly-opened popup can win the race against the background service worker waking from a
// cold start (Chrome tears MV3 workers down after ~30s idle) — the very first message sent can
// fail with "Could not establish connection. Receiving end does not exist." even though the
// worker comes up a beat later. Retrying that specific, transient failure a couple of times
// (not other errors, which are real and should surface immediately) rides out the gap invisibly.
async function send<T = unknown>(message: PopupRequest, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce<T>(message);
    } catch (e) {
      const isColdStartRace = e instanceof Error && e.message.includes("Receiving end does not exist");
      if (!isColdStartRace || attempt >= retries) throw e;
      await sleep(200 * (attempt + 1));
    }
  }
}

/** Every screen that fetches wallet status goes through this instead of calling `send` directly --
 * the popup's display language lives in `WalletStatus.language`, and `t()` (see src/lib/i18n) reads
 * a module-level "current language" that has no other natural way to stay in sync across every
 * render function down the call stack. */
async function getStatus(): Promise<WalletStatus> {
  const status = await send<WalletStatus>({ kind: "popup-get-status" });
  setLanguage(status.language);
  return status;
}

// Feather Icons (MIT) path data, inlined as raw SVG markup — `h()` can't build real SVG elements
// (document.createElement has no SVG namespace), but the HTML parser used by innerHTML handles
// inline <svg> fine, and these are fixed, non-user-controlled strings.
const ICON_ARROW_UP = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
const ICON_ARROW_DOWN = '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>';
const ICON_PLUS = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
const ICON_CHEVRON_RIGHT = '<polyline points="9 18 15 12 9 6"/>';
const ICON_CHEVRON_LEFT = '<polyline points="15 18 9 12 15 6"/>';
const ICON_CHEVRON_DOWN = '<polyline points="6 9 12 15 18 9"/>';
const ICON_COPY =
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const ICON_SETTINGS =
  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
const ICON_CLOCK = '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>';
const ICON_REFRESH =
  '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>';
const ICON_LOCK = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
const ICON_UNLOCK = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
const ICON_EXTERNAL_LINK =
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>';
const ICON_USER_PLUS =
  '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="17" y1="11" x2="23" y2="11"/>';
const ICON_SERVER = '<rect x="2" y="3" width="20" height="8" rx="2" ry="2"/><rect x="2" y="13" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>';
const ICON_GLOBE =
  '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
const ICON_BOOK =
  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>';
const ICON_KEY =
  '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>';
const ICON_INBOX = '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>';

function icon(paths: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "icon-svg";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span;
}

// Deterministic per-address avatar (see src/lib/avatar.ts for why) -- innerHTML here is safe the
// same way `icon()` above is: the SVG markup comes entirely from our own generator over data this
// extension already computed (the account's own address), never from a page or dApp.
function accountAvatar(address: string | null, size = 44): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "avatar";
  div.style.width = `${size}px`;
  div.style.height = `${size}px`;
  if (address) {
    div.innerHTML = avatarSvg(address, size);
  } else {
    div.textContent = "T";
  }
  return div;
}

/** A "nothing here yet" placeholder with a supporting icon, not just flat centered text -- used
 * everywhere a list can legitimately be empty (history, balances, address book, ...). */
function emptyState(message: string, iconPaths: string): HTMLElement {
  return h("div", { class: "empty-state" }, [
    h("div", { class: "empty-state-icon", "aria-hidden": "true" }, [icon(iconPaths)]),
    h("div", { class: "muted" }, [message]),
  ]);
}

function skeletonBalanceRow(): HTMLElement {
  return h("div", { class: "balance-row" }, [
    h("div", { class: "balance-left" }, [
      h("span", { class: "token-avatar skeleton", style: "width:28px;height:28px" }, [""]),
      h("span", { class: "skeleton", style: "display:inline-block;width:64px;height:13px" }, [""]),
    ]),
    h("span", { class: "skeleton", style: "display:inline-block;width:46px;height:13px" }, [""]),
  ]);
}

/** A title+subtitle shimmer row, matching skeletonBalanceRow's convention -- for any list-row-info
 * screen fetching data after its first paint (history, connected sites), instead of a plain
 * "Loading…" line that gives no sense of the eventual layout. */
function skeletonListRow(): HTMLElement {
  return h("div", { class: "balance-row" }, [
    h("span", { class: "skeleton", style: "width:28px;height:28px;border-radius:50%;flex-shrink:0" }, [""]),
    h("div", { class: "list-row-info", style: "display:flex;flex-direction:column;gap:5px" }, [
      h("span", { class: "skeleton", style: "display:inline-block;width:90px;height:13px" }, [""]),
      h("span", { class: "skeleton", style: "display:inline-block;width:140px;height:11px" }, [""]),
    ]),
  ]);
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

/** A labeled two-state sliding toggle (see .switch-label/.switch-track/.switch-thumb in
 * styles.css) for a strictly binary choice, e.g. fee privacy. The side labels' highlighting is
 * pure CSS (a sibling selector off the checkbox's own :checked state), so it stays in sync with
 * no re-render. Returns the `<label>`; the nested `<input type=checkbox>` gets `id` so the
 * caller can attach its own `change` listener the same way every other control here does. */
function switchControl(id: string, checked: boolean, offLabel: string, onLabel: string): HTMLLabelElement {
  return h("label", { class: "switch-label" }, [
    h("input", { type: "checkbox", id, ...(checked ? { checked: "true" } : {}) }),
    h("span", { class: "switch-side switch-side-off" }, [offLabel]),
    h("span", { class: "switch-track" }, [h("span", { class: "switch-thumb" }, [])]),
    h("span", { class: "switch-side switch-side-on" }, [onLabel]),
  ]);
}

// Every screen swap replays a short fade/slide-in on #app — restarting a CSS animation requires a
// reflow between removing and re-adding its class, since re-adding the same class name alone is a
// no-op as far as the browser's style engine is concerned.
function render(...nodes: (Node | string)[]) {
  app.replaceChildren(...nodes);
  app.classList.remove("view-enter");
  void app.offsetWidth;
  app.classList.add("view-enter");
}

/** Copies `text` and flashes `label`'s text to "Copied!" for a beat, then restores it. */
async function copyToClipboard(text: string, label: HTMLElement) {
  // Clipboard permission denied/unavailable is rare in an extension's own popup, but silently
  // doing nothing on click reads as a broken button, not a failed copy -- flash a clear message
  // either way rather than only on success. aria-live so a screen-reader user actually hears the
  // outcome, not just sighted users watching the text change.
  label.setAttribute("aria-live", "polite");
  let message: string;
  try {
    await navigator.clipboard.writeText(text);
    message = t("common.copied");
  } catch {
    message = t("common.copyFailed");
  }
  const original = label.textContent;
  label.textContent = message;
  label.classList.remove("copy-flash");
  void label.offsetWidth;
  label.classList.add("copy-flash");
  setTimeout(() => {
    label.textContent = original;
    label.classList.remove("copy-flash");
  }, 1200);
}

/** Binds a `(msg, cls) => void` status-line setter to `statusEl` -- the exact 3-line body
 * (`display`/`className`/`textContent`) was hand-repeated as its own `showStatus` closure in every
 * screen with a status line; this is the one place that shape lives now. */
function bindStatus(statusEl: HTMLElement): (msg: string, cls: "err" | "ok") => void {
  return (msg, cls) => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };
}

/** Swaps a submit button's own label to `busyLabel` and disables it while an async action runs,
 * restoring the original label after -- previously every submit button just grayed out while a
 * separate status line below said "Submitting…", so the button itself looked inert rather than
 * busy. Assumes a plain-text button (no icon children) -- every submit button this is used on is. */
function setBusy(btn: HTMLButtonElement, busy: boolean, busyLabel = t("common.working")) {
  if (busy) {
    btn.dataset.label ??= btn.textContent ?? "";
    btn.disabled = true;
    btn.textContent = busyLabel;
  } else {
    btn.disabled = false;
    if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label;
  }
}

/**
 * Replaces `button` with an inline "are you sure?" prompt on its first click, only calling
 * `action` if the user then confirms -- Cancel restores `button` exactly as it was. For actions
 * that previously fired on a single click (remove address-book entry, disconnect daemon/site):
 * easy to redo, but a stray click shouldn't be able to do them with zero friction either.
 */
function confirmThenRun(button: HTMLButtonElement, message: string, confirmLabel: string, action: () => void | Promise<void>) {
  button.addEventListener("click", () => {
    const yes = h("button", { class: "primary btn-compact" }, [confirmLabel]);
    const no = h("button", { class: "secondary btn-compact" }, [t("common.cancel")]);
    const prompt = h("div", { class: "inline-confirm" }, [
      h("div", { class: "muted", style: "margin-bottom:6px" }, [message]),
      h("div", { class: "row", style: "gap:8px" }, [yes, no]),
    ]);
    yes.addEventListener("click", () => void action());
    no.addEventListener("click", () => prompt.replaceWith(button));
    button.replaceWith(prompt);
  });
}

/** Toggles a green/red border on `input` as the user types, once there's something to judge — a
 * wrong recipient address here is unrecoverable-funds territory, so catching it before submit
 * (rather than only on click) is worth the couple of lines. Empty stays neutral (no judgment on a
 * field nobody's touched yet). */
function wireLiveValidation(input: HTMLInputElement, isValid: (value: string) => boolean) {
  const update = () => {
    const value = input.value.trim();
    input.classList.toggle("input-valid", value.length > 0 && isValid(value));
    input.classList.toggle("input-invalid", value.length > 0 && !isValid(value));
  };
  input.addEventListener("input", update);
  update();
}

/**
 * The first status/account fetch after unlocking (or creating a wallet, or adding an account)
 * triggers on-chain key derivation the background service worker hasn't done yet — a lazy-loaded
 * ~1.4MB WASM signing module has to load and instantiate before it resolves. Without this, that
 * gap between click and the next screen looks identical to the extension being stuck.
 */
function renderLoading(message = "Loading…") {
  render(h("div", { class: "loading" }, [h("div", { class: "spinner" }), h("div", { class: "muted" }, [message])]));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function main() {
  const hash = window.location.hash; // "#/approve/<id>"
  const approveMatch = hash.match(/^#\/approve\/(.+)$/);
  if (approveMatch) {
    await renderApprovalFlow(approveMatch[1]!);
    return;
  }

  renderLoading();
  const status = await getStatus();
  if (!status.hasWallet) renderWelcome();
  else if (!status.isUnlocked) renderUnlock(status.backupPending ? () => void main() : undefined, status.lastKnownAddress);
  else if (status.backupPending) await resumeBackup();
  else await renderHome(status);
}

/**
 * The popup was closed (or the wallet locked) between creating the wallet and passing the phrase
 * check. The vault already exists, so show the phrase again instead of dropping into a wallet whose
 * owner never confirmed they can recover it.
 */
async function resumeBackup() {
  try {
    const { mnemonic } = await send<{ mnemonic: string }>({ kind: "popup-get-pending-mnemonic" });
    renderBackupMnemonic(mnemonic);
  } catch {
    // The browser was restarted since the wallet was created, so the phrase is no longer held in
    // memory. The password proves ownership and brings it back from the vault.
    renderBackupPasswordPrompt();
  }
}

function renderBackupPasswordPrompt() {
  const statusEl = h("div", { class: "status err", id: "status", style: "display:none" });
  render(
    h("h1", {}, [t("backupMnemonic.title")]),
    h("p", { class: "muted" }, [t("backupMnemonic.resumeDescription")]),
    h("label", {}, [t("common.password")]),
    h("input", { type: "password", id: "pw", maxlength: "256", autofocus: "true" }),
    statusEl,
    h("button", { class: "primary", id: "show" }, [t("backupMnemonic.resumeButton")])
  );
  const pw = document.getElementById("pw") as HTMLInputElement;
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("show")!.click();
  });
  document.getElementById("show")!.addEventListener("click", async () => {
    try {
      const { mnemonic } = await send<{ mnemonic: string }>({ kind: "popup-reveal-mnemonic", password: pw.value });
      renderBackupMnemonic(mnemonic);
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.style.display = "block";
    }
  });
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function renderWelcome() {
  render(
    h("div", { class: "welcome-hero" }, [
      h("img", { src: "icons/icon128.png", width: "56", height: "56", alt: "" }),
      h("h1", {}, ["Sapient", h("span", {}, [" Wallet"])]),
      h("p", { class: "muted" }, [t("welcome.description")]),
    ]),
    h("button", { class: "primary", id: "create" }, [t("welcome.createButton")]),
    h("button", { class: "secondary", id: "import" }, [t("welcome.importButton")])
  );
  document.getElementById("create")!.addEventListener("click", () => renderSetPassword("create"));
  document.getElementById("import")!.addEventListener("click", () => renderSetPassword("import"));
}

function renderSetPassword(mode: "create" | "import") {
  const title = mode === "create" ? t("setPassword.titleCreate") : t("setPassword.titleImport");
  const wrap = h("div", {}, [
    h("h1", {}, [title]),
    h("p", { class: "muted" }, [t("setPassword.description")]),
  ]);

  let mnemonicTextarea: HTMLTextAreaElement | null = null;
  const mnemonicField =
    mode === "import"
      ? (() => {
          const label = h("label", {}, [t("setPassword.mnemonicLabel")]);
          const ta = h("textarea", { id: "mnemonic", placeholder: t("setPassword.mnemonicPlaceholder"), maxlength: "1000" }) as HTMLTextAreaElement;
          mnemonicTextarea = ta;
          return [label, ta];
        })()
      : [];

  const pwLabel = h("label", {}, [t("common.password")]);
  const pw = h("input", { type: "password", id: "pw", maxlength: "256" });
  const meterBar = h("div", { class: "strength-meter-fill" }, []);
  const meterLabel = h("div", { class: "muted", style: "font-size:12px;margin-top:2px" }, [""]);
  const meter = h("div", { class: "strength-meter", style: "display:none" }, [meterBar]);
  const pw2Label = h("label", {}, [t("setPassword.confirmPasswordLabel")]);
  const pw2 = h("input", { type: "password", id: "pw2", maxlength: "256" });
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const submit = h("button", { class: "primary", id: "submit" }, [mode === "create" ? t("setPassword.submitCreate") : t("setPassword.submitImport")]);
  const back = h("button", { class: "secondary", id: "back" }, [t("common.back")]);

  wrap.append(...mnemonicField, pwLabel, pw, meter, meterLabel, pw2Label, pw2, statusEl, submit, back);
  render(wrap);

  // Focus the first field the user actually needs to fill in -- the mnemonic textarea for
  // Import (it comes first in the form), otherwise the password field.
  (mnemonicTextarea ?? (pw as HTMLInputElement)).focus();
  const submitOnEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") document.getElementById("submit")!.click();
  };
  pw.addEventListener("keydown", submitOnEnter);
  pw2.addEventListener("keydown", submitOnEnter);

  // Live, advisory-only feedback (SECURITY_AUDIT.md §7) — the actual gate against a known-common
  // or trivially-patterned password happens at submit time in isBlockedPassword(), below.
  const STRENGTH_COLORS = ["var(--bad)", "var(--bad)", "var(--fair)", "var(--highlight)", "var(--good)"];
  pw.addEventListener("input", () => {
    const value = (pw as HTMLInputElement).value;
    if (!value) {
      meter.style.display = "none";
      meterLabel.textContent = "";
      return;
    }
    const { score, label, feedback } = estimatePasswordStrength(value);
    meter.style.display = "block";
    meterBar.style.width = `${((score + 1) / 5) * 100}%`;
    meterBar.style.background = STRENGTH_COLORS[score]!;
    meterLabel.textContent = feedback.length > 0 ? `${label} — ${feedback[0]}` : label;
  });

  document.getElementById("back")!.addEventListener("click", renderWelcome);
  document.getElementById("submit")!.addEventListener("click", async () => {
    const password = (document.getElementById("pw") as HTMLInputElement).value;
    const password2 = (document.getElementById("pw2") as HTMLInputElement).value;
    const showStatus = (msg: string) => {
      statusEl.textContent = msg;
      statusEl.className = "status err";
      statusEl.style.display = "block";
    };
    if (password.length < 8) return showStatus(t("setPassword.errTooShort"));
    // PBKDF2's cost scales with iteration count, not input length, but hashing a pathologically
    // long input (e.g. an accidentally-pasted file) still means a real multi-second UI stall for no
    // security benefit past a reasonable length — 256 chars is generous for an actual passphrase.
    if (password.length > 256) return showStatus(t("setPassword.errTooLong"));
    if (isBlockedPassword(password)) {
      return showStatus(t("setPassword.errCommon"));
    }
    if (password !== password2) return showStatus(t("setPassword.errMismatch"));

    try {
      if (mode === "create") {
        const { mnemonic } = await send<{ mnemonic: string }>({ kind: "popup-create-wallet", password });
        renderBackupMnemonic(mnemonic);
      } else {
        const mnemonic = (document.getElementById("mnemonic") as HTMLTextAreaElement).value.trim();
        if (!isPlausibleMnemonic(mnemonic)) return showStatus(t("setPassword.errInvalidMnemonic"));
        await send({ kind: "popup-import-wallet", password, mnemonic });
        renderLoading(t("common.derivingAccount"));
        const status = await getStatus();
        await renderHome(status);
      }
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    }
  });
}

function renderBackupMnemonic(mnemonic: string) {
  const words = mnemonic.split(" ");
  const grid = h(
    "div",
    { class: "mnemonic-grid" },
    words.map((w, i) => h("div", { class: "mnemonic-word" }, [h("span", {}, [String(i + 1)]), w]))
  );
  const confirm = h("button", { class: "primary", id: "confirm" }, [t("backupMnemonic.confirmButton")]);
  render(h("h1", {}, [t("backupMnemonic.title")]), h("p", { class: "muted" }, [t("backupMnemonic.description")]), grid, confirm);
  document.getElementById("confirm")!.addEventListener("click", () => renderVerifyMnemonic(mnemonic));
}

/**
 * A spot-check before finishing wallet creation: this is the single highest-consequence screen in
 * the whole app (lose this phrase, lose the funds, permanently), and the previous flow trusted the
 * user's unverified claim that they'd saved it. Every major wallet (MetaMask, Phantom, Rainbow)
 * gates past their equivalent screen the same way. Import needs no equivalent check -- typing the
 * full 24 words back in from the user's own records already proves they have it saved elsewhere.
 */
function renderVerifyMnemonic(mnemonic: string) {
  const words = mnemonic.split(" ");
  const indices = new Set<number>();
  while (indices.size < 3) indices.add(Math.floor(Math.random() * words.length));
  // Sorted so the fields read in phrase order -- easier to answer in one pass than a shuffled order.
  const fields = [...indices].sort((a, b) => a - b).map((i) => ({
    index: i,
    input: h("input", { type: "text", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement,
  }));

  const statusEl = h("div", { class: "status err", id: "status", style: "display:none" });
  const back = h("button", { class: "secondary", id: "back" }, [t("verifyMnemonic.backButton")]);
  const confirm = h("button", { class: "primary", id: "confirm" }, [t("common.confirm")]);

  render(
    h("h1", {}, [t("verifyMnemonic.title")]),
    h("p", { class: "muted" }, [t("verifyMnemonic.description")]),
    ...fields.flatMap(({ index, input }) => [h("label", {}, [t("verifyMnemonic.wordLabel", { n: index + 1 })]), input]),
    statusEl,
    confirm,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderBackupMnemonic(mnemonic));
  document.getElementById("confirm")!.addEventListener("click", async () => {
    const allCorrect = fields.every(({ index, input }) => input.value.trim().toLowerCase() === words[index]!.toLowerCase());
    if (!allCorrect) {
      statusEl.textContent = t("verifyMnemonic.errMismatch");
      statusEl.style.display = "block";
      return;
    }
    renderLoading(t("common.derivingAccount"));
    try {
      await send({ kind: "popup-confirm-backup" });
      const status = await getStatus();
      await renderHome(status);
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    }
  });
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

function renderUnlock(onUnlocked?: () => void, lastKnownAddress?: string | null) {
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const forgotLink = h("button", { class: "link-btn", id: "forgot" }, [t("unlock.forgotPassword")]);
  render(
    // The real per-account identicon when known (cached in plaintext from the last unlock -- see
    // WalletState.lastKnownAddress's doc comment), so a returning user can spot "wrong
    // wallet/device" the same way MetaMask's lock screen lets them -- otherwise a generic
    // placeholder, since the address genuinely can't be known before the seed is decrypted (a
    // fresh install, or a wallet that's never been unlocked in this browser instance yet).
    h("div", { class: "hero" }, [accountAvatar(lastKnownAddress ?? null)]),
    h("h1", { style: "text-align:center" }, [t("unlock.title")]),
    h("label", {}, [t("common.password")]),
    h("input", { type: "password", id: "pw", maxlength: "256", autofocus: "true" }),
    statusEl,
    h("button", { class: "primary", id: "unlock" }, [t("unlock.unlockButton")]),
    forgotLink
  );
  const pw = document.getElementById("pw") as HTMLInputElement;
  pw.focus();
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("unlock")!.click();
  });
  document.getElementById("unlock")!.addEventListener("click", async () => {
    try {
      await send({ kind: "popup-unlock", password: pw.value });
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.className = "status err";
      statusEl.style.display = "block";
      return;
    }
    // Past this point the password was correct, so failures are no longer about this form —
    // `statusEl` is about to be replaced by renderLoading() and can't show them anymore.
    renderLoading(t("common.derivingAccount"));
    try {
      if (onUnlocked) {
        onUnlocked();
      } else {
        const status = await getStatus();
        await renderHome(status);
      }
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    }
  });
  forgotLink.addEventListener("click", renderForgotPassword);
}

// A locked wallet with a forgotten password was previously a dead end — `popup-reset-wallet`
// existed (wired from Settings) but nothing reachable from the lock screen itself could ever
// call it, so there was no way back in without knowing devtools/chrome://extensions storage
// wiping. This is the escape hatch, gated behind a typed confirmation (not just a click) since
// it's irreversible and destroys the local seed if it isn't backed up elsewhere.
function renderForgotPassword() {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const confirmInput = h("input", { type: "text", id: "confirm", placeholder: "RESET", maxlength: "16" });
  const resetBtn = h("button", { class: "danger", id: "reset", disabled: "true" }, [t("forgotPassword.eraseButton")]);
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });

  render(
    h("h1", {}, [t("unlock.forgotPassword")]),
    h("p", { class: "muted" }, [
      t("forgotPassword.desc1"),
      h("b", {}, [t("forgotPassword.descBold")]),
      t("forgotPassword.desc2"),
    ]),
    h("label", {}, [t("forgotPassword.typeResetLabel", { word: "RESET" })]),
    confirmInput,
    statusEl,
    resetBtn,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderUnlock());
  confirmInput.addEventListener("input", () => {
    (resetBtn as HTMLButtonElement).disabled = (confirmInput as HTMLInputElement).value !== "RESET";
  });
  resetBtn.addEventListener("click", async () => {
    try {
      await send({ kind: "popup-reset-wallet" });
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.className = "status err";
      statusEl.style.display = "block";
      return;
    }
    renderWelcome();
  });
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function activeAccountSummary(status: WalletStatus): AccountSummary | undefined {
  return status.accounts.find((a) => a.id === status.activeAccountId);
}

/**
 * The common "Back"/"Done" action after a screen finishes: refetch status and go home. Pulled out
 * once since several screens repeated this exact two-line block with no error handling at all --
 * a refetch failure there made the button look broken (no visible error, no way to retry, just a
 * click that silently did nothing). On failure, shows the error with a retry button instead.
 */
function goHome(): void {
  void (async () => {
    try {
      const status = await getStatus();
      await renderHome(status);
    } catch (e) {
      const retryBtn = h("button", { class: "primary" }, [t("common.tryAgain")]);
      retryBtn.addEventListener("click", goHome);
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]), retryBtn);
    }
  })();
}

async function renderHome(status: WalletStatus) {
  const activeLabel = activeAccountSummary(status)?.label ?? t("home.accountFallback");
  const accountPill = h("button", { class: "account-pill", "aria-label": t("home.switchAccountAria", { label: activeLabel }) }, [
    activeLabel,
    icon(ICON_CHEVRON_DOWN),
  ]);
  const settingsBtn = h(
    "button",
    { class: "secondary", id: "settingsBtn", style: "width:auto;padding:6px 10px;margin-top:0", "aria-label": t("home.settingsAria") },
    [icon(ICON_SETTINGS)]
  );
  const nav = h("div", { class: "top-nav" }, [
    h("h1", {}, ["Sapient", h("span", {}, [" Wallet"])]),
    h("div", { class: "row", style: "gap:6px" }, [accountPill, settingsBtn]),
  ]);
  accountPill.addEventListener("click", () => renderAccountSwitcher(status));
  settingsBtn.addEventListener("click", () => renderSettings(status));

  // Chrome has a newer version downloaded and waiting -- see background/index.ts's
  // onUpdateAvailable listener. Reloading is the user's call (it interrupts anything in progress
  // in this popup), so this only ever informs; it never reloads on its own.
  let updateBanner: HTMLElement | null = null;
  if (status.updateAvailable) {
    const reloadBtn = h("button", { class: "secondary" }, [t("home.reload")]);
    reloadBtn.addEventListener("click", () => void send({ kind: "popup-reload-extension" }));
    updateBanner = h("div", { class: "update-banner" }, [h("span", {}, [t("home.updateReady", { version: status.updateAvailable })]), reloadBtn]);
  }

  if (status.activeAccountError) {
    const switchBtn = h("button", { class: "primary", id: "switchAccount" }, [t("home.switchAccount")]);
    render(
      nav,
      ...(updateBanner ? [updateBanner] : []),
      h("div", { class: "status err" }, [t("home.couldntReach", { label: activeLabel, error: status.activeAccountError })]),
      switchBtn
    );
    switchBtn.addEventListener("click", () => renderAccountSwitcher(status));
    return;
  }

  // The wallet (otl_esm_...) address, not the component address -- same reasoning as the Receive
  // screen: it's the one safe to publish/reuse (stealth payments derive a fresh one-time on-chain
  // key per payment off it), and it's now sufficient for a sender to use for a plain send too (see
  // componentAddressFromWalletAddress). The component address stays reachable from Receive's
  // "Advanced" disclosure for anything that still needs it.
  const copyLabel = h("span", {}, [shortAddr(status.receiveAddress ?? "", 8)]);
  const addrPill = h("button", { class: "addr-pill", id: "addrPill", "aria-label": t("home.copyAddressAria") }, [
    copyLabel,
    h("span", { class: "icon", "aria-hidden": "true" }, [icon(ICON_COPY)]),
  ]);
  addrPill.addEventListener("click", () => copyToClipboard(status.receiveAddress ?? "", copyLabel));
  const heroBalanceAmount = h("span", { class: "hero-balance-amount skeleton", style: "display:inline-block;width:96px;height:30px" }, [""]);
  const heroBalance = h("div", { class: "hero-balance" }, [heroBalanceAmount, h("span", { class: "hero-balance-unit" }, ["TARI"])]);
  // Hidden until updateHeroBalance() knows whether there's actually a private balance to show --
  // a permanent "Private: 0" line under every account would just be noise for one that's never
  // shielded anything.
  const heroPrivateBalance = h("div", { class: "private-balance", style: "display:none;margin-top:2px" }, [""]);
  const summaryHead = h("div", { class: "summary-head" }, [accountAvatar(status.address, 32), addrPill]);
  // Not "Total Balance" -- heroBalance below is only ever the public/revealed TARI amount
  // (updateHeroBalance() reads xtr.amount, never confidentialAmount), and heroPrivateBalance is a
  // separate figure shown underneath, not summed into it. Calling that a "total" reads as "this is
  // everything," which for an account holding shielded funds is actively wrong -- an asset row or
  // hero number that's really "public only" needs to say so.
  const summaryBalance = h("div", { class: "summary-balance" }, [
    h("div", { class: "summary-label" }, [t("home.publicBalance")]),
    heroBalance,
    heroPrivateBalance,
  ]);
  const hero = h("div", { class: "account-summary card" }, [summaryHead, summaryBalance]);

  const sendActionBtn = h("button", { class: "action-btn", id: "sendAction" }, [h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_ARROW_UP)]), t("home.send")]);
  const receiveActionBtn = h("button", { class: "action-btn", id: "receiveAction" }, [
    h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_ARROW_DOWN)]),
    t("home.receive"),
  ]);
  const shieldActionBtn = h("button", { class: "action-btn", id: "shieldAction" }, [
    h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_LOCK)]),
    t("home.shield"),
  ]);
  const unshieldActionBtn = h("button", { class: "action-btn", id: "unshieldAction" }, [
    h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_UNLOCK)]),
    t("home.unshield"),
  ]);
  const historyActionBtn = h("button", { class: "action-btn", id: "historyAction" }, [
    h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_CLOCK)]),
    t("home.history"),
  ]);
  // Rescanning needs this account's own view key (see OotleAccount.scanForPrivatePayments()) --
  // unavailable for a daemon-relayed account, same gating Shield/Unshield/Send-privately use.
  const isLocalAccount = activeAccountSummary(status)?.kind !== "daemon" && !!activeAccountSummary(status);
  // Claiming an L1 burn seals with a key derived from this account's own secret, so it is local-only too.
  const burnActionBtn = isLocalAccount
    ? h("button", { class: "action-btn", id: "burnAction" }, [
        h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_ARROW_DOWN)]),
        t("home.claimL1Burn"),
      ])
    : null;
  // History shares the last row with Claim L1 burn, or takes it alone when there's no burn button.
  if (!burnActionBtn) historyActionBtn.classList.add("action-btn-wide");
  const actionRow = h("div", { class: "action-row" }, [
    sendActionBtn,
    receiveActionBtn,
    shieldActionBtn,
    unshieldActionBtn,
    historyActionBtn,
    ...(burnActionBtn ? [burnActionBtn] : []),
  ]);

  const homeStatusEl = h("div", { class: "status", id: "homeStatus", style: "display:none" });
  const rescanControl = isLocalAccount ? buildRescanControl() : null;
  const balancesTitleRow = h("div", { class: "row", style: "justify-content:space-between;align-items:center;margin:2px 0 0" }, [
    h("div", { class: "section-title", style: "margin:0" }, [t("home.assets")]),
    ...(rescanControl ? [rescanControl.button] : []),
  ]);
  const balancesCard = h("div", { class: "card balances-card" }, [skeletonBalanceRow(), skeletonBalanceRow()]);

  render(
    nav,
    ...(updateBanner ? [updateBanner] : []),
    hero,
    actionRow,
    homeStatusEl,
    balancesTitleRow,
    ...(rescanControl ? [rescanControl.statusEl] : []),
    balancesCard
  );

  const updateHeroBalance = (balances: Balance[]) => {
    const xtr = balances.find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS);
    heroBalanceAmount.className = "hero-balance-amount";
    heroBalanceAmount.removeAttribute("style");
    heroBalanceAmount.textContent = formatBalanceAmountGrouped(xtr?.amount ?? "0", xtr?.divisibility ?? 6);

    const privateAmount = BigInt(xtr?.confidentialAmount ?? "0");
    if (privateAmount > 0n) {
      heroPrivateBalance.style.display = "inline-flex";
      heroPrivateBalance.textContent = t("home.privateSuffix", {
        amount: formatBalanceAmountGrouped(privateAmount.toString(), xtr?.divisibility ?? 6),
        symbol: "TARI",
      });
    } else {
      heroPrivateBalance.style.display = "none";
    }
  };

  sendActionBtn.addEventListener("click", async () => {
    try {
      const balances = await send<Balance[]>({ kind: "popup-get-balances" });
      renderSend(status, balances);
    } catch (e) {
      homeStatusEl.style.display = "block";
      homeStatusEl.className = "status err";
      homeStatusEl.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  receiveActionBtn.addEventListener("click", () => renderReceive(status));
  historyActionBtn.addEventListener("click", () => renderHistory(status));
  burnActionBtn?.addEventListener("click", () => renderClaimBurn(status));
  // Shield/Unshield TARI straight from Home: the same screens a token's detail page opens, fed
  // TARI's current balance.
  const openTariPrivacy = async (open: (status: WalletStatus, balance: Balance) => void, needs: "public" | "private") => {
    try {
      const balances = await send<Balance[]>({ kind: "popup-get-balances" });
      const xtr = balances.find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS);
      const held = needs === "public" ? BigInt(xtr?.amount ?? "0") : BigInt(xtr?.confidentialAmount ?? "0");
      if (!xtr || held === 0n) {
        homeStatusEl.style.display = "block";
        homeStatusEl.className = "status err";
        homeStatusEl.textContent = t(needs === "public" ? "home.nothingToShield" : "home.nothingToUnshield");
        return;
      }
      open(status, xtr);
    } catch (e) {
      homeStatusEl.style.display = "block";
      homeStatusEl.className = "status err";
      homeStatusEl.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  shieldActionBtn.addEventListener("click", () => void openTariPrivacy(renderShield, "public"));
  unshieldActionBtn.addEventListener("click", () => void openTariPrivacy(renderUnshield, "private"));

  // Fired here rather than awaited before this point (or blocking buildStatus() the way it used
  // to) so the home screen it's shown alongside is already interactive -- see the removed call in
  // background/index.ts's buildStatus() for why that mattered, and
  // popup-auto-scan-private-payments's own doc comment for the freshly-created-wallet fast path.
  // Silent when it finds nothing (the common case, every single open) -- only surfaced when there's
  // something to actually tell the user about.
  if (rescanControl) {
    void (async () => {
      try {
        const { claimed } = await send<{ claimed: number }>({ kind: "popup-auto-scan-private-payments" });
        if (claimed > 0) {
          rescanControl.statusEl.style.display = "block";
          rescanControl.statusEl.textContent = t("rescan.found", { count: claimed, word: claimed === 1 ? "payment" : "payments" });
          const balances = await send<Balance[]>({ kind: "popup-get-balances" });
          renderBalances(balancesCard, balances, status);
          updateHeroBalance(balances);
        }
      } catch {
        // Best-effort background check -- an indexer hiccup here shouldn't interrupt anything the
        // user is already doing on the home screen.
      }
    })();
  }

  try {
    const balances = await send<Balance[]>({ kind: "popup-get-balances" });
    renderBalances(balancesCard, balances, status);
    updateHeroBalance(balances);
  } catch (e) {
    balancesCard.replaceChildren(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    heroBalanceAmount.className = "hero-balance-amount";
    heroBalanceAmount.removeAttribute("style");
    heroBalanceAmount.textContent = "—";
  }
}

function settingsRow(id: string, label: string, leadingIcon: string, trailing?: string): HTMLButtonElement {
  return h("button", { class: "settings-row", id }, [
    h("span", { class: "settings-row-left" }, [icon(leadingIcon), label]),
    h("span", { class: "settings-row-right" }, [
      trailing ? h("span", { class: "settings-row-trailing" }, [trailing]) : "",
      icon(ICON_CHEVRON_RIGHT),
    ]),
  ]);
}

/** Adds a second recovery phrase as its own account. The phrase is encrypted under this wallet's seed, so it needs no extra password. */
function renderImportAccount(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const label = h("input", { type: "text", id: "importLabel", placeholder: t("importAccount.labelPlaceholder"), maxlength: "40" }) as HTMLInputElement;
  const ta = h("textarea", { id: "importMnemonic", placeholder: t("setPassword.mnemonicPlaceholder"), maxlength: "1000", autocomplete: "off", spellcheck: "false" }) as HTMLTextAreaElement;
  const submit = h("button", { class: "primary", id: "importSubmit" }, [t("importAccount.submit")]) as HTMLButtonElement;
  const msg = h("div", { class: "status", id: "importStatus" }, []);
  render(h("h1", {}, [t("importAccount.title")]), h("p", { class: "muted" }, [t("importAccount.description")]), h("label", {}, [t("importAccount.labelLabel")]), label, ta, msg, submit, back);
  back.addEventListener("click", () => renderSettings(status));
  submit.addEventListener("click", async () => {
    const mnemonic = ta.value.trim();
    if (!isPlausibleMnemonic(mnemonic)) {
      msg.className = "status err";
      msg.textContent = t("setPassword.errInvalidMnemonic");
      return;
    }
    submit.disabled = true;
    try {
      await send({ kind: "popup-import-account", mnemonic, label: label.value });
      ta.value = "";
      await renderHome(await getStatus());
    } catch (e) {
      submit.disabled = false;
      msg.className = "status err";
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  });
}

function renderSettings(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const addAccountBtn = settingsRow("addAccount", t("settings.addAccount"), ICON_USER_PLUS);
  const importAccountBtn = settingsRow("importAccount", t("settings.importAccount"), ICON_USER_PLUS);
  const connectDaemonBtn = settingsRow("connectDaemon", t("settings.connectDaemon"), ICON_SERVER);
  const daemonsBtn = settingsRow("daemons", t("settings.daemonConnections"), ICON_SERVER, String(status.daemonConnections.length));
  const sitesBtn = settingsRow("sites", t("settings.connectedSites"), ICON_GLOBE);
  const addressBookBtn = settingsRow("addressBook", t("settings.addressBook"), ICON_BOOK, String(status.addressBook.length));
  const backupBtn = settingsRow("backup", t("settings.revealMnemonic"), ICON_KEY);
  const lockBtn = h("button", { class: "danger", id: "lock" }, [t("settings.lockWallet")]);

  const autoLockSelect = h(
    "select",
    { id: "autoLock", class: "settings-row-select", "aria-label": t("settings.autoLockAfter") },
    AUTO_LOCK_OPTIONS.map((minutes) =>
      h("option", { value: String(minutes), ...(minutes === status.autoLockMinutes ? { selected: "true" } : {}) }, [
        formatAutoLockOption(minutes),
      ])
    )
  );
  const autoLockRow = h("div", { class: "settings-row settings-row-static" }, [
    h("span", {}, [t("settings.autoLockAfter")]),
    autoLockSelect,
  ]);

  const NETWORK_OPTIONS: { value: "esmeralda" | "igor"; label: string }[] = [
    { value: "esmeralda", label: "Esmeralda" },
    { value: "igor", label: "Igor" },
  ];
  const networkSelect = h(
    "select",
    { id: "network", class: "settings-row-select", "aria-label": t("settings.network") },
    NETWORK_OPTIONS.map((opt) =>
      h("option", { value: opt.value, ...(opt.value === status.network ? { selected: "true" } : {}) }, [opt.label])
    )
  );
  const networkRow = h("div", { class: "settings-row settings-row-static" }, [h("span", {}, [t("settings.network")]), networkSelect]);
  const networkConfirmEl = h("div", { class: "status", style: "display:none" });

  // Language names are never translated -- "English"/"中文" always shows its own name regardless
  // of which language is currently active, matching every other app's language picker (a Chinese
  // reader who accidentally lands on English still needs to recognize "中文" to get back).
  const languageSelect = h(
    "select",
    { id: "language", class: "settings-row-select", "aria-label": t("settings.language") },
    (Object.entries(LANGUAGE_LABELS) as [Language, string][]).map(([value, label]) =>
      h("option", { value, ...(value === getLanguage() ? { selected: "true" } : {}) }, [label])
    )
  );
  const languageRow = h("div", { class: "settings-row settings-row-static" }, [h("span", {}, [t("settings.language")]), languageSelect]);

  const feePrivacySwitch = switchControl(
    "feePrivacyDefault",
    status.feePrivacyDefault === "private",
    t("settings.feePrivacyTransparent"),
    t("settings.feePrivacyPrivate")
  );
  const feePrivacyRow = h("div", { class: "settings-row settings-row-static" }, [
    h("span", {}, [t("settings.defaultFeePrivacy")]),
    feePrivacySwitch,
  ]);

  render(
    h("h1", {}, [t("settings.title")]),
    back,
    h("div", { class: "card settings-card" }, [
      addAccountBtn,
      importAccountBtn,
      connectDaemonBtn,
      daemonsBtn,
      sitesBtn,
      addressBookBtn,
      backupBtn,
      autoLockRow,
      networkRow,
      languageRow,
      feePrivacyRow,
    ]),
    networkConfirmEl,
    lockBtn
  );

  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
  document.getElementById("lock")!.addEventListener("click", async () => {
    try {
      await send({ kind: "popup-lock" });
      renderUnlock(undefined, status.address);
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]), h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]));
      document.getElementById("back")!.addEventListener("click", () => renderSettings(status));
    }
  });
  languageSelect.addEventListener("change", async () => {
    const chosen = (languageSelect as HTMLSelectElement).value as Language;
    setLanguage(chosen);
    await send({ kind: "popup-set-language", language: chosen });
    // Full re-render (not just swapping visible text) -- the settings screen the user is looking
    // at right now is itself full of strings that need to flip languages too, and re-fetching
    // status is cheap enough that a bespoke "just relabel these nodes" path isn't worth the extra
    // code path only this one control would ever use.
    renderSettings({ ...status, language: chosen });
  });
  autoLockSelect.addEventListener("change", () => {
    void send({ kind: "popup-set-auto-lock-minutes", minutes: Number((autoLockSelect as HTMLSelectElement).value) });
  });
  document.getElementById("feePrivacyDefault")!.addEventListener("change", (e) => {
    const feeType = (e.target as HTMLInputElement).checked ? "private" : "transparent";
    void send({ kind: "popup-set-fee-privacy-default", feeType });
  });
  networkSelect.addEventListener("change", () => {
    const chosen = (networkSelect as HTMLSelectElement).value as "esmeralda" | "igor";
    if (chosen === status.network) {
      networkConfirmEl.style.display = "none";
      return;
    }
    // .primary, not .danger -- switching networks is a reversible settings change, not a
    // destructive action (unlike Lock/Reset, which genuinely warrant the red danger styling).
    const confirmBtn = h("button", { class: "primary btn-compact", style: "margin-right:8px" }, [t("settings.switchButton")]);
    const cancelBtn = h("button", { class: "secondary btn-compact" }, [t("common.cancel")]);
    networkConfirmEl.className = "status";
    networkConfirmEl.style.display = "block";
    networkConfirmEl.replaceChildren(
      h("p", { style: "margin:0 0 8px" }, [t("settings.networkSwitchWarning", { from: status.network, to: chosen })]),
      confirmBtn,
      cancelBtn
    );
    cancelBtn.addEventListener("click", () => {
      (networkSelect as HTMLSelectElement).value = status.network;
      networkConfirmEl.style.display = "none";
    });
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.setAttribute("disabled", "true");
      cancelBtn.setAttribute("disabled", "true");
      try {
        await send({ kind: "popup-set-network", network: chosen });
      } catch (e) {
        // Still on this screen (renderLoading hasn't fired yet) -- re-enable rather than leaving
        // both buttons permanently disabled with no way to retry or cancel.
        networkConfirmEl.className = "status err";
        networkConfirmEl.textContent = e instanceof Error ? e.message : String(e);
        confirmBtn.removeAttribute("disabled");
        cancelBtn.removeAttribute("disabled");
        return;
      }
      renderLoading(t("settings.switchingNetwork"));
      try {
        const newStatus = await getStatus();
        renderSettings(newStatus);
      } catch (e) {
        // The network switch itself already succeeded server-side -- only the status refetch
        // failed. Offer a retry rather than stranding the user on a loading screen forever.
        const retryBtn = h("button", { class: "primary" }, [t("common.tryAgain")]);
        retryBtn.addEventListener("click", async () => {
          try {
            const newStatus = await getStatus();
            renderSettings(newStatus);
          } catch (e2) {
            render(h("div", { class: "status err" }, [e2 instanceof Error ? e2.message : String(e2)]), retryBtn);
          }
        });
        render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]), retryBtn);
      }
    });
  });
  document.getElementById("addAccount")!.addEventListener("click", async () => {
    renderLoading(t("common.derivingAccount"));
    try {
      await send({ kind: "popup-add-account" });
      const newStatus = await getStatus();
      await renderHome(newStatus);
    } catch (e) {
      render(
        h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]),
        h("button", { class: "secondary", id: "back" }, [t("common.backArrow")])
      );
      document.getElementById("back")!.addEventListener("click", () => renderSettings(status));
    }
  });
  document.getElementById("importAccount")!.addEventListener("click", () => renderImportAccount(status));
  document.getElementById("connectDaemon")!.addEventListener("click", () => renderConnectDaemon(status));
  document.getElementById("daemons")!.addEventListener("click", () => renderDaemonConnections(status));
  document.getElementById("sites")!.addEventListener("click", renderConnectedSites);
  document.getElementById("addressBook")!.addEventListener("click", () => renderAddressBook(status));
  document.getElementById("backup")!.addEventListener("click", renderRevealMnemonic);
}

// ---------------------------------------------------------------------------
// Send / Receive
// ---------------------------------------------------------------------------

function renderReceive(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);

  // The wallet address (otl_...) is the one to hand out: any sender can derive this account's
  // component address from it for a plain send (see componentAddressFromWalletAddress), AND it's
  // the address stealth-type payments (shield/sendPrivately) key off of -- for those, the network
  // derives a fresh one-time on-chain spend key per payment (payTo defaults to
  // { StealthPublicKey: {} } in createOutput), so this same address can be reused forever without
  // ever letting a chain observer link two payments to each other or to this account. There is no
  // reason to publish the raw component_ address instead -- it buys nothing a sender using this
  // wallet (or anything doing the same otl_-address derivation) needs, and it actively costs
  // privacy for plain sends, which record it on-chain exactly as given.
  const walletLabel = h("span", {}, [t("common.copy")]);
  const walletCopyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), walletLabel]);
  const walletRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [status.receiveAddress ?? "—"]), walletCopyBtn]);
  walletCopyBtn.addEventListener("click", () => copyToClipboard(status.receiveAddress ?? "", walletLabel));

  const qrCard = h("div", { class: "card qr-card" }, []);
  if (status.receiveAddress) {
    qrCard.innerHTML = qrCodeSvg(status.receiveAddress);
    qrCard.classList.add("qr-card-filled");
  } else {
    qrCard.textContent = t("receive.noAddress");
  }

  const componentLabel = h("span", {}, [t("common.copy")]);
  const componentCopyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), componentLabel]);
  const componentRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [status.address ?? "—"]), componentCopyBtn]);
  componentCopyBtn.addEventListener("click", () => copyToClipboard(status.address ?? "", componentLabel));
  const componentDetails = h("div", { class: "card" }, [
    h("details", { class: "raw-details" }, [
      h("summary", {}, [t("receive.advancedComponentAddress")]),
      h("p", { class: "muted", style: "margin:6px 0 10px" }, [t("receive.advancedComponentDescription")]),
      componentRow,
    ]),
  ]);

  const isLocalAccount = activeAccountSummary(status)?.kind !== "daemon" && !!activeAccountSummary(status);
  const claimCard = isLocalAccount ? buildClaimPrivatePaymentCard(status) : null;

  render(
    h("h1", {}, [t("receive.title")]),
    h("p", { class: "muted" }, [t("receive.description")]),
    h("div", { class: "hero" }, [accountAvatar(status.address)]),
    qrCard,
    h("div", { class: "card" }, [h("div", { class: "muted", style: "margin-bottom:8px" }, [t("receive.walletAddressLabel")]), walletRow]),
    componentDetails,
    ...(claimCard ? [claimCard] : []),
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

/**
 * `scanForPrivatePayments()` already runs opportunistically on every popup open (see
 * `buildStatus()`'s doc comment), but only over a shallow, cheap window (3 pages of 50
 * transactions). This triggers the same scan with a much deeper lookback (20×50 = 1000) on
 * demand -- for catching up after the wallet's been closed a while, or just confirming "did that
 * stealth transfer actually arrive" without waiting for the next popup open to notice it.
 */
/**
 * A small icon-button next to the "Assets" title on the home screen (see renderHome) rather than
 * its own screen -- rescanning is something people want to try right where they're already looking
 * at their balance, not a few taps away. `scanForPrivatePayments()` already runs opportunistically
 * on every popup open (see buildStatus()'s doc comment) but only over a shallow window (150
 * transactions); this triggers the same scan with a much deeper lookback (1000) on demand, for
 * catching up after the wallet's been closed a while or just confirming a stealth transfer arrived
 * without waiting for the next popup open to notice it. Returns `{ button, statusEl }` so the
 * caller can lay both out next to the title and under it respectively.
 */
function buildRescanControl(): { button: HTMLElement; statusEl: HTMLElement } {
  const button = h("button", { class: "icon-btn", "aria-label": t("rescan.ariaLabel"), title: t("rescan.ariaLabel") }, [
    icon(ICON_REFRESH),
  ]);
  const statusEl = h("div", { class: "muted", style: "display:none;font-size:12px;margin:-4px 0 8px" }, [""]);
  const showStatus = (msg: string) => {
    statusEl.style.display = "block";
    statusEl.textContent = msg;
  };

  button.addEventListener("click", async () => {
    button.setAttribute("disabled", "true");
    showStatus(t("rescan.scanning"));
    try {
      const { claimed } = await send<{ claimed: number }>({ kind: "popup-rescan-private-payments" });
      showStatus(claimed === 0 ? t("rescan.noneFound") : t("rescan.found", { count: claimed, word: claimed === 1 ? "payment" : "payments" }));
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e));
    } finally {
      button.removeAttribute("disabled");
    }
  });

  return { button, statusEl };
}

/**
 * A private send has no scan-by-view-key discovery (see `sendPrivately()`'s doc comment) -- the
 * recipient can only find it by being handed the commitment out of band. This is that hand-off's
 * landing spot: given a resource address + commitment, `claimPrivatePayment()` fetches the
 * on-chain output and tries to decrypt it with this account's own view secret, which both proves
 * ownership and recovers the exact amount in one step -- no need to be told the amount separately,
 * and no risk of typing it wrong. Once claimed, it behaves exactly like a self-shielded output:
 * it shows up in the private balance and in Unshield/Send-privately's picker.
 */
function buildClaimPrivatePaymentCard(status: WalletStatus) {
  const resourceInput = h("input", { type: "text", placeholder: "resource_…", maxlength: "80" }) as HTMLInputElement;
  resourceInput.value = TARI_RESOURCE_ADDRESS;
  const commitmentInput = h("input", { type: "text", placeholder: "64 hex characters", maxlength: "64" });
  const claimBtn = h("button", { class: "secondary" }, [t("claimPrivate.claimButton")]);
  const statusEl = h("div", { class: "status", style: "display:none" });
  const showStatus = bindStatus(statusEl);

  claimBtn.addEventListener("click", async () => {
    const resourceAddress = resourceInput.value.trim();
    const commitment = (commitmentInput as HTMLInputElement).value.trim();
    if (!/^[0-9a-f]{64}$/i.test(commitment)) {
      showStatus(t("claimPrivate.errInvalidCommitment"), "err");
      return;
    }
    setBusy(claimBtn as HTMLButtonElement, true, t("claimPrivate.checking"));
    showStatus(t("claimPrivate.checking"), "ok");
    try {
      await send({ kind: "popup-claim-private-payment", resourceAddress, commitment });
      showStatus(t("claimPrivate.claimedSuccess"), "ok");
      (commitmentInput as HTMLInputElement).value = "";
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(claimBtn as HTMLButtonElement, false);
    }
  });

  return h("div", { class: "card" }, [
    h("div", { class: "muted", style: "margin-bottom:8px" }, [t("claimPrivate.title")]),
    h("p", { class: "muted", style: "margin:0 0 8px" }, [t("claimPrivate.description")]),
    h("label", {}, [t("claimPrivate.resourceAddressLabel")]),
    resourceInput,
    h("label", {}, [t("claimPrivate.commitmentLabel")]),
    commitmentInput,
    statusEl,
    claimBtn,
  ]);
}

function renderClaimBurn(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  render(h("h1", {}, [t("claimBurn.title")]), buildClaimBurnCard(), back);
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

/**
 * Minotari (L1) burns arrive by claim, not by transfer: an L1 wallet burns XTM to this account's
 * public key, and the resulting proof file is claimed here. The key is shown so it can be pasted
 * into the L1 wallet; the claimed funds land in the private balance as a stealth output.
 */
function buildClaimBurnCard() {
  const keyLabel = h("span", {}, [t("common.copy")]);
  const keyCopyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), keyLabel]);
  const keyText = h("div", { class: "addr" }, ["…"]);
  const keyRow = h("div", { class: "copy-row" }, [keyText, keyCopyBtn]);
  let claimKey = "";
  keyCopyBtn.addEventListener("click", () => claimKey && copyToClipboard(claimKey, keyLabel));
  send<{ publicKey: string }>({ kind: "popup-get-burn-claim-key" })
    .then(({ publicKey }) => {
      claimKey = publicKey;
      keyText.textContent = publicKey;
    })
    .catch(() => {
      keyText.textContent = "—";
    });

  const proofInput = h("textarea", { rows: "4", spellcheck: "false", placeholder: '{"claim_proof": { … }, "encrypted_data": "…"}' }) as HTMLTextAreaElement;
  const fileInput = h("input", { type: "file", accept: "application/json,.json" }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) proofInput.value = await file.text();
  });
  const claimBtn = h("button", { class: "secondary" }, [t("claimBurn.claimButton")]);
  const statusEl = h("div", { class: "status", style: "display:none" });
  const showStatus = bindStatus(statusEl);

  claimBtn.addEventListener("click", async () => {
    const proofJson = proofInput.value.trim();
    if (!proofJson) {
      showStatus(t("claimBurn.errNoProof"), "err");
      return;
    }
    setBusy(claimBtn as HTMLButtonElement, true, t("claimBurn.claiming"));
    showStatus(t("claimBurn.claiming"), "ok");
    try {
      await send({ kind: "popup-claim-burn", proofJson });
      showStatus(t("claimBurn.claimedSuccess"), "ok");
      proofInput.value = "";
      fileInput.value = "";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      showStatus(/block header not found/i.test(message) ? t("claimBurn.notYetObserved") : message, "err");
    } finally {
      setBusy(claimBtn as HTMLButtonElement, false);
    }
  });

  return h("div", { class: "card" }, [
    h("p", { class: "muted", style: "margin:0 0 8px" }, [t("claimBurn.description")]),
    h("label", {}, [t("claimBurn.claimKeyLabel")]),
    keyRow,
    h("label", {}, [t("claimBurn.proofLabel")]),
    proofInput,
    fileInput,
    statusEl,
    claimBtn,
  ]);
}

// A function, not a module-level Record built once -- the labels have to reflect whichever
// language is active *at render time* (the user can switch languages mid-session), not whichever
// was current when this module first evaluated.
function historyKindLabel(kind: TransactionHistoryEntry["kind"]): string {
  const KEYS: Record<TransactionHistoryEntry["kind"], Parameters<typeof t>[0]> = {
    send: "history.kindSend",
    shield: "history.kindShield",
    unshield: "history.kindUnshield",
    "send-privately": "history.kindSendPrivately",
    claim: "history.kindClaim",
    "private-payment-received": "history.kindPrivatePaymentReceived",
    received: "history.kindReceived",
    "burn-claim": "history.kindBurnClaim",
    "dapp-transaction": "history.kindDappTransaction",
  };
  return t(KEYS[kind]);
}

// Lock/unlock for shield/unshield (a state change in privacy, not a transfer direction) and for
// send-privately/private-payment-received (reinforces which entries are private at a glance,
// rather than relying on reading the label text) -- direction arrows stay reserved for the two
// plain-balance kinds so "money left" vs. "money arrived" is still the first thing that reads.
const HISTORY_KIND_ICON: Record<TransactionHistoryEntry["kind"], string> = {
  send: ICON_ARROW_UP,
  shield: ICON_LOCK,
  unshield: ICON_UNLOCK,
  "send-privately": ICON_LOCK,
  claim: ICON_PLUS,
  "private-payment-received": ICON_UNLOCK,
  received: ICON_ARROW_DOWN,
  "burn-claim": ICON_ARROW_DOWN,
  "dapp-transaction": ICON_EXTERNAL_LINK,
};

/**
 * Transaction history is recorded client-side, starting from when this feature shipped -- it's
 * not a retroactive reconstruction of everything this account has ever done on-chain (see
 * TransactionHistoryEntry's doc comment in storage.ts for why). Fetches current balances
 * alongside the history list purely for display formatting (symbol/divisibility) — an entry for
 * a resource this account no longer holds still renders, just without those niceties.
 */
/** Ootle explorer for a network, or null where none exists (Igor) -- the id is still shown. */
const EXPLORER_BASE: Record<WalletStatus["network"], string | null> = {
  esmeralda: "https://explorer.tari.mw",
  igor: null,
};

/** "Tx 1a2b3c4d…5e6f7a8b · View on explorer ↗", with the full id on hover. */
function historyTransactionLine(transactionId: string, network: WalletStatus["network"]): HTMLElement {
  const base = EXPLORER_BASE[network];
  const linkable = base !== null && /^[0-9a-f]{64}$/i.test(transactionId);
  return h("div", { class: "list-row-subtitle history-tx", title: transactionId }, [
    `${t("history.txLabel")} ${shortAddr(transactionId, 8)}`,
    linkable ? " · " : "",
    linkable
      ? h("a", { href: `${base}/tx/${transactionId}`, target: "_blank", rel: "noopener noreferrer" }, [t("history.viewOnExplorer")])
      : "",
  ]);
}

async function renderHistory(status: WalletStatus) {
  // Back sits beside the title rather than after the list: History can run long, and the way out
  // shouldn't be at the bottom of it.
  const header = () =>
    h("div", { class: "page-header" }, [
      h("button", { class: "icon-btn", id: "back", "aria-label": t("common.back"), title: t("common.back") }, [icon(ICON_CHEVRON_LEFT)]),
      h("h1", {}, [t("history.title")]),
    ]);
  // History has the whole popup to itself, so its list fills the page (scrolling with it) instead of the 220px box it gets elsewhere.
  const skeleton = h("div", { class: "card history-list history-list-full" }, [skeletonListRow(), skeletonListRow(), skeletonListRow()]);
  render(header(), skeleton);
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));

  const [entries, balances] = await Promise.all([
    send<TransactionHistoryEntry[]>({ kind: "popup-get-transaction-history" }),
    send<Balance[]>({ kind: "popup-get-balances" }).catch(() => [] as Balance[]),
  ]);
  const balanceByResource = new Map(balances.map((b) => [b.resourceAddress, b]));
  // Newest first; receipts found with no known time (createdAt 0) go last.
  entries.sort((a, b) => b.createdAt - a.createdAt);

  const list =
    entries.length === 0
      ? emptyState(t("history.empty"), ICON_CLOCK)
      : h(
          "div",
          { class: "card history-list history-list-full" },
          entries.map((entry) => {
            // Prefer what was persisted with the entry itself (see TransactionHistoryEntry's doc
            // comment) -- only fall back to a current-balance lookup for an entry recorded before
            // that field existed. A resource this account no longer holds at all still renders
            // correctly via the persisted value; only the (rare, pre-migration) fallback case can
            // still show a wrong divisibility if the resource has since dropped out of the balance
            // list entirely -- there's no other source of truth left to recover it from then.
            const b = entry.resourceAddress ? balanceByResource.get(entry.resourceAddress) : undefined;
            const divisibility = entry.divisibility ?? b?.divisibility ?? 0;
            const symbol = entry.symbol !== undefined ? entry.symbol : (b?.symbol ?? null);
            const amountText =
              entry.amount && entry.resourceAddress
                ? `${formatBalanceAmountGrouped(entry.amount, divisibility)} ${resourceLabel(entry.resourceAddress, symbol)}`
                : null;
            const when = entry.createdAt > 0 ? new Date(entry.createdAt).toLocaleString() : t("history.earlier");
            // dapp-transaction's counterparty is a human sentence ("origin: summary") -- shortAddr()
            // (first-N…last-N) would garble it. Every other kind's counterparty is a real address,
            // where shortAddr() is exactly right. Either way, list-row-subtitle's CSS still wraps
            // instead of overflowing, as a safety net against one unbroken token being too long.
            const counterpartyText = entry.counterparty
              ? entry.kind === "dapp-transaction"
                ? entry.counterparty
                : shortAddr(entry.counterparty)
              : null;
            return h("div", { class: `balance-row${entry.status === "failed" ? " status-failed" : ""}` }, [
              h("div", { class: "history-icon", "aria-hidden": "true" }, [icon(HISTORY_KIND_ICON[entry.kind])]),
              h("div", { class: "list-row-info" }, [
                h("div", {}, [
                  historyKindLabel(entry.kind),
                  entry.status === "failed"
                    ? t("history.failedSuffix")
                    : // The sign-only claim sealed a payload without touching the chain -- never
                      // let history read as a completed spend.
                      entry.status === "signed-unbroadcast"
                      ? t("history.signedUnbroadcastSuffix")
                      : "",
                ]),
                h("div", { class: "muted" }, [amountText ? `${amountText} · ${when}` : when]),
                counterpartyText ? h("div", { class: "list-row-subtitle", title: entry.counterparty ?? "" }, [counterpartyText]) : "",
                entry.memo ? h("div", { class: "list-row-subtitle" }, [`"${entry.memo}"`]) : "",
                entry.transactionId ? historyTransactionLine(entry.transactionId, status.network) : "",
              ]),
            ]);
          })
        );

  render(header(), list);
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

/**
 * The single "Send" screen, covering both a plain revealed-balance transfer and a private
 * (stealth-to-stealth) send from behind one tab toggle -- previously two separate screens
 * (renderSend/renderSendPrivately) reached from two separate entry points. The private tab is
 * shown for local *and* daemon-relayed accounts (see popup-send-privately's own comment in
 * background/index.ts) -- same gating Shield/Unshield use.
 */
function renderSend(
  status: WalletStatus,
  balances: Balance[],
  options?: { initialTab?: "public" | "private"; initialResourceAddress?: string; onBack?: () => void }
) {
  const onBack = options?.onBack ?? (() => renderHome(status));
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);

  if (balances.length === 0) {
    render(h("h1", {}, [t("send.title")]), h("p", { class: "muted" }, [t("send.noTokensYet")]), back);
    document.getElementById("back")!.addEventListener("click", onBack);
    return;
  }

  const accountKind = activeAccountSummary(status)?.kind;
  const isLocalAccount = accountKind === "local";
  const isDaemonAccount = accountKind === "daemon";

  const publicSection = h("div", {});
  const privateSection = h("div", { style: "display:none" });

  if (!isLocalAccount && !isDaemonAccount) {
    render(h("h1", {}, [t("send.title")]), publicSection, back);
    document.getElementById("back")!.addEventListener("click", onBack);
    buildPublicSendForm(publicSection, balances, status.addressBook);
    return;
  }

  const publicTabBtn = h("button", { class: "tab-btn", role: "tab", "aria-selected": "true" }, [t("send.tabSend")]);
  const privateTabBtn = h("button", { class: "tab-btn", role: "tab", "aria-selected": "false" }, [t("send.tabSendPrivately")]);
  const tabRow = h("div", { class: "tab-row", role: "tablist" }, [publicTabBtn, privateTabBtn]);

  const setTab = (tab: "public" | "private") => {
    publicTabBtn.classList.toggle("active", tab === "public");
    publicTabBtn.setAttribute("aria-selected", String(tab === "public"));
    privateTabBtn.classList.toggle("active", tab === "private");
    privateTabBtn.setAttribute("aria-selected", String(tab === "private"));
    publicSection.style.display = tab === "public" ? "" : "none";
    privateSection.style.display = tab === "private" ? "" : "none";
  };
  publicTabBtn.addEventListener("click", () => setTab("public"));
  privateTabBtn.addEventListener("click", () => setTab("private"));

  render(h("h1", {}, [t("send.title")]), tabRow, publicSection, privateSection, back);
  document.getElementById("back")!.addEventListener("click", onBack);

  buildPublicSendForm(publicSection, balances, status.addressBook);
  const activeIsLocal = status.accounts.find((a) => a.id === status.activeAccountId)?.kind !== "daemon";
  buildPrivateSendForm(privateSection, balances, status.addressBook, activeIsLocal, options?.initialResourceAddress);
  setTab(options?.initialTab ?? "public");
}

/** A picker of saved address-book entries matching `isMatch`, or `null` if there are none worth
 * showing — selecting an option fills `targetInput`'s value but leaves it freely editable, so
 * manual entry still works exactly as before. */
function buildAddressPicker(
  entries: { id: string; label: string; address: string }[],
  isMatch: (address: string) => boolean,
  targetInput: HTMLElement
): HTMLElement | null {
  const matching = entries.filter((e) => isMatch(e.address));
  if (matching.length === 0) return null;
  const select = h("select", { class: "settings-row-select", style: "margin-bottom:8px", "aria-label": t("send.chooseFromAddressBookAria") }, [
    h("option", { value: "" }, [t("send.chooseFromAddressBook")]),
    ...matching.map((e) => h("option", { value: e.address }, [`${e.label} (${shortAddr(e.address)})`])),
  ]);
  select.addEventListener("change", () => {
    const value = (select as HTMLSelectElement).value;
    if (value) (targetInput as HTMLInputElement).value = value;
  });
  return select;
}

function buildPublicSendForm(container: HTMLElement, balances: Balance[], addressBook: { id: string; label: string; address: string }[]) {
  // NonFungible resources are excluded: this form sends a decimal amount of a divisible resource,
  // and an NFT holding's `amount` is a token count with no divisibility to parse a decimal against
  // -- sending a specific token id is a different flow, out of scope here.
  const balances_ = balances.filter((b) => b.kind !== "NonFungible");
  // renderSend()'s own `balances.length === 0` guard only catches holding nothing at all -- an
  // all-NFT wallet reaches here with a nonempty `balances` but an empty `balances_`, which used to
  // build a `<select>` with zero `<option>`s and then crash the first time `selected()` (the
  // `!`-asserted `.find()` below) actually ran against it, since there was nothing left to select.
  if (balances_.length === 0) {
    container.replaceChildren(emptyState(t("send.onlyNftsYet"), ICON_INBOX));
    return;
  }
  const tokenSelect = h(
    "select",
    {},
    balances_.map((b) => h("option", { value: b.resourceAddress }, [resourceLabel(b.resourceAddress, b.symbol)]))
  );
  const balanceHint = h("div", { class: "muted", style: "margin-top:6px" }, [""]);

  const toInput = h("input", { type: "text", placeholder: "otl_…", maxlength: "200" });
  wireLiveValidation(toInput as HTMLInputElement, isValidOotleWalletAddress);
  const addressPicker = buildAddressPicker(addressBook, isValidOotleWalletAddress, toInput);
  const amountInput = h("input", { type: "text", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
  const maxBtn = h("button", { class: "max-btn" }, [t("send.max")]);
  const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);

  const statusEl = h("div", { class: "status", style: "display:none" });
  const sendBtn = h("button", { class: "primary" }, [t("send.reviewAndSend")]);

  container.replaceChildren(
    h("label", {}, [t("send.assetLabel")]),
    tokenSelect,
    balanceHint,
    h("label", {}, [t("send.recipientAddressLabel")]),
    ...(addressPicker ? [addressPicker] : []),
    toInput,
    h("label", {}, [t("send.amountLabel")]),
    amountField,
    statusEl,
    sendBtn
  );

  const selected = () => balances_.find((b) => b.resourceAddress === (tokenSelect as HTMLSelectElement).value)!;
  const updateHint = () => {
    const b = selected();
    balanceHint.textContent = t("send.available", {
      amount: formatBalanceAmountGrouped(b.amount, b.divisibility),
      symbol: resourceLabel(b.resourceAddress, b.symbol),
    });
  };
  updateHint();
  tokenSelect.addEventListener("change", updateHint);

  maxBtn.addEventListener("click", () => {
    const b = selected();
    (amountInput as HTMLInputElement).value = formatBalanceAmount(b.amount, b.divisibility);
  });

  const showStatus = bindStatus(statusEl);

  sendBtn.addEventListener("click", async () => {
    const b = selected();
    const toAddress = (toInput as HTMLInputElement).value.trim();
    if (!isValidOotleWalletAddress(toAddress)) {
      showStatus(t("send.errInvalidAddress"), "err");
      return;
    }
    let raw: bigint;
    try {
      raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, b.divisibility);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      return;
    }
    if (raw > BigInt(b.amount)) {
      showStatus(t("send.errExceedsBalance"), "err");
      return;
    }

    setBusy(sendBtn as HTMLButtonElement, true, t("send.sending"));
    showStatus(t("send.submitting"), "ok");
    try {
      await send({ kind: "popup-send", recipientWalletAddress: toAddress, resourceAddress: b.resourceAddress, amount: raw.toString() });
      showStatus(t("send.sent"), "ok");
      setTimeout(async () => {
        const newStatus = await getStatus();
        await renderHome(newStatus);
      }, 700);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(sendBtn as HTMLButtonElement, false);
    }
  });
}

/**
 * Sends some of this account's total private balance for a resource directly to someone else's
 * Ootle wallet address — private the whole way (unlike Shield, which always targets this same
 * account, and Unshield, which always reveals back to this same account). Which specific shielded
 * output(s) get spent is chosen by the wallet itself (largest-first coin selection — see
 * `resolveSendPrivatelyPlan`), combining more than one into a single transaction if no single
 * output covers the amount, so the user only ever thinks in terms of a total balance and an
 * amount, never individual UTXOs/commitments.
 *
 * Only offers resources with an actual private balance to send from (`confidentialAmount > 0n`)
 * *and* whose resource kind is "Stealth" -- a real Confidential-vault resource (a distinct engine
 * type, see renderTokenDetail's isStealthResource comment) can also carry a nonzero
 * confidentialAmount, but sendPrivately()'s StealthTransfer pipeline only works for Stealth
 * resources and would fail on-chain for one of those. If none exist, shows a hint to shield first
 * rather than an empty picker.
 */
function buildPrivateSendForm(
  container: HTMLElement,
  balances: Balance[],
  addressBook: { id: string; label: string; address: string }[],
  canPayPrivateFee: boolean,
  initialResourceAddress?: string
) {
  const privateBalances = balances.filter((b) => b.kind === "Stealth" && BigInt(b.confidentialAmount) > 0n);
  if (privateBalances.length === 0) {
    container.replaceChildren(h("p", { class: "muted" }, [t("send.noPrivateBalanceYet")]));
    return;
  }

  const resourceSelect = h(
    "select",
    {},
    privateBalances.map((b) => h("option", { value: b.resourceAddress }, [resourceLabel(b.resourceAddress, b.symbol)]))
  );
  if (initialResourceAddress && privateBalances.some((b) => b.resourceAddress === initialResourceAddress)) {
    (resourceSelect as HTMLSelectElement).value = initialResourceAddress;
  }

  const formSection = h("div", { style: "margin-top:10px" });
  const statusEl = h("div", { class: "status", style: "display:none" });
  const showStatus = bindStatus(statusEl);

  // There's no scan-by-view-key API, so the recipient has no way to notice this payment on their
  // own -- surface the new output's commitment so it can be handed to them out of band (they
  // paste it into their own wallet's Receive -> "Claim a private payment" card).
  const showResultSection = (recipientCommitment: string) => {
    statusEl.style.display = "none";
    const copyLabel = h("span", {}, [t("common.copy")]);
    const copyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), copyLabel]);
    copyBtn.addEventListener("click", () => copyToClipboard(recipientCommitment, copyLabel));
    const doneBtn = h("button", { class: "primary" }, [t("send.done")]);
    doneBtn.addEventListener("click", goHome);
    formSection.replaceChildren(
      h("div", { class: "status ok" }, [t("send.sentPrivately")]),
      h("p", { class: "muted" }, [t("send.recipientCannotDiscover")]),
      h("label", {}, [t("send.commitmentLabel")]),
      h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [recipientCommitment]), copyBtn]),
      doneBtn
    );
  };

  container.replaceChildren(h("label", {}, [t("send.assetLabel")]), resourceSelect, formSection, statusEl);

  const buildForm = (balance: Balance, label: string, maxAmount: bigint) => {
    const recipientInput = h("input", { type: "text", placeholder: "otl_…", maxlength: "200" });
    wireLiveValidation(recipientInput as HTMLInputElement, isValidOotleWalletAddress);
    const addressPicker = buildAddressPicker(addressBook, isValidOotleWalletAddress, recipientInput);
    const amountInput = h("input", { type: "text", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
    const maxBtn = h("button", { class: "max-btn" }, [t("send.max")]);
    const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);
    const hint = h("div", { class: "muted", style: "margin-top:6px" }, [
      t("send.privateBalanceHint", { amount: formatBalanceAmountGrouped(maxAmount.toString(), balance.divisibility), symbol: label }),
    ]);
    const memoInput = h("input", { type: "text", placeholder: "e.g. Payment for invoice #42", maxlength: "200" });
    const submitBtn = h("button", { class: "primary" }, [t("send.sendPrivatelyButton", { symbol: label })]);
    // On by default: a transparent fee is paid from the account's vault and names this account
    // on-chain, undoing the privacy of the send itself. Daemon accounts can't pay one (no local
    // stealth-fee support), so they get no switch and the background falls back to transparent.
    const feeSwitch = canPayPrivateFee
      ? switchControl("privateSendFeePrivate", true, t("settings.feePrivacyTransparent"), t("settings.feePrivacyPrivate"))
      : null;
    const feeHint = h("p", { class: "muted", style: "margin:4px 0 0" }, [
      canPayPrivateFee ? t("send.privateFeeHint") : t("send.privateFeeUnavailable"),
    ]);

    maxBtn.addEventListener("click", () => {
      (amountInput as HTMLInputElement).value = formatBalanceAmount(maxAmount.toString(), balance.divisibility);
    });

    submitBtn.addEventListener("click", async () => {
      const recipientWalletAddress = (recipientInput as HTMLInputElement).value.trim();
      if (!isValidOotleWalletAddress(recipientWalletAddress)) {
        showStatus(t("send.errInvalidAddress"), "err");
        return;
      }
      let raw: bigint;
      try {
        raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, balance.divisibility);
      } catch (e) {
        showStatus(e instanceof Error ? e.message : String(e), "err");
        return;
      }
      if (raw <= 0n) {
        showStatus(t("send.errZeroAmount"), "err");
        return;
      }
      if (raw > maxAmount) {
        showStatus(t("send.errExceedsPrivateBalance"), "err");
        return;
      }
      setBusy(submitBtn as HTMLButtonElement, true, t("send.sending"));
      showStatus(t("send.submitting"), "ok");
      const memo = (memoInput as HTMLInputElement).value.trim();
      try {
        const { recipientCommitment } = await send<{ transactionId: string; recipientCommitment: string }>({
          kind: "popup-send-privately",
          resourceAddress: balance.resourceAddress,
          recipientWalletAddress,
          amount: raw.toString(),
          memo: memo || undefined,
          feeType: feeSwitch ? ((feeSwitch.querySelector("input") as HTMLInputElement).checked ? "private" : "transparent") : "transparent",
        });
        showResultSection(recipientCommitment);
      } catch (e) {
        showStatus(e instanceof Error ? e.message : String(e), "err");
        setBusy(submitBtn as HTMLButtonElement, false);
      }
    });

    return [
      h("label", {}, [t("send.recipientWalletAddressLabel")]),
      ...(addressPicker ? [addressPicker] : []),
      recipientInput,
      h("label", {}, [t("send.amountLabel")]),
      amountField,
      hint,
      h("label", {}, [t("send.memoLabel")]),
      memoInput,
      h("p", { class: "muted", style: "margin:4px 0 0" }, [t("send.memoHint")]),
      h("label", {}, [t("send.feeLabel")]),
      ...(feeSwitch ? [feeSwitch] : []),
      feeHint,
      submitBtn,
    ];
  };

  const loadForm = () => {
    const balance = privateBalances.find((b) => b.resourceAddress === (resourceSelect as HTMLSelectElement).value)!;
    const label = resourceLabel(balance.resourceAddress, balance.symbol);
    formSection.replaceChildren(...buildForm(balance, label, BigInt(balance.confidentialAmount)));
  };

  resourceSelect.addEventListener("change", loadForm);
  loadForm();
}

/**
 * Shields (revealed → private) some amount of one token, always to a NEW stealth output owned
 * by this same account — not a transfer to someone else. Local accounts only: shielding needs
 * this account's own view key/stealth signing, which a daemon-relayed account can't provide (see
 * background/index.ts's popup-shield handler), so this screen should only ever be reached from a
 * local account's token detail.
 */
function renderShield(status: WalletStatus, balance: Balance) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const label = resourceLabel(balance.resourceAddress, balance.symbol);

  const amountInput = h("input", { type: "text", id: "amount", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
  const maxBtn = h("button", { class: "max-btn", id: "max" }, [t("send.max")]);
  const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);
  const balanceHint = h("div", { class: "muted", style: "margin-top:6px" }, [
    t("shield.revealedBalance", { amount: formatBalanceAmountGrouped(balance.amount, balance.divisibility), symbol: label }),
  ]);
  const memoInput = h("input", { type: "text", id: "memo", placeholder: "e.g. Savings", maxlength: "200" });

  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const shieldBtn = h("button", { class: "primary", id: "submit" }, [t("shield.submitButton", { symbol: label })]);

  render(
    h("h1", {}, [t("shield.title")]),
    h("p", { class: "muted" }, [t("shield.description", { symbol: label })]),
    h("label", {}, [t("send.amountLabel")]),
    amountField,
    balanceHint,
    h("label", {}, [t("send.memoLabel")]),
    memoInput,
    h("p", { class: "muted", style: "margin:4px 0 0" }, [t("shield.memoNote")]),
    statusEl,
    shieldBtn,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderTokenDetail(status, balance));

  maxBtn.addEventListener("click", () => {
    (amountInput as HTMLInputElement).value = formatBalanceAmount(balance.amount, balance.divisibility);
  });

  const showStatus = bindStatus(statusEl);

  shieldBtn.addEventListener("click", async () => {
    let raw: bigint;
    try {
      raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, balance.divisibility);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      return;
    }
    if (raw <= 0n) {
      showStatus(t("send.errZeroAmount"), "err");
      return;
    }
    if (raw > BigInt(balance.amount)) {
      showStatus(t("shield.errExceedsRevealed"), "err");
      return;
    }

    setBusy(shieldBtn as HTMLButtonElement, true, t("shield.shielding"));
    showStatus(t("send.submitting"), "ok");
    const memo = (memoInput as HTMLInputElement).value.trim();
    try {
      await send({ kind: "popup-shield", resourceAddress: balance.resourceAddress, amount: raw.toString(), memo: memo || undefined });
      showStatus(t("shield.shielded"), "ok");
      setTimeout(async () => {
        const newStatus = await getStatus();
        await renderHome(newStatus);
      }, 700);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(shieldBtn as HTMLButtonElement, false);
    }
  });
}

/**
 * Unshields (private → revealed) some of this account's total private balance for a resource.
 * Which specific shielded output(s) get spent is chosen by the wallet itself (largest-first coin
 * selection — see `resolveUnshieldPlan`), combining more than one into a single transaction if no
 * single output covers the amount, so the user only ever thinks in terms of a total balance and
 * an amount, never individual UTXOs/commitments.
 *
 * The protocol has no way to reveal a shielded balance's *entire* value in one step (confirmed
 * against the SDK's own builder validation, see `OotleAccount.unshield()`'s doc comment) — at
 * least the smallest unit must remain private as change, so MAX caps just under the full balance.
 */
function renderUnshield(status: WalletStatus, balance: Balance) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const label = resourceLabel(balance.resourceAddress, balance.symbol);
  const maxAmount = BigInt(balance.confidentialAmount);

  const amountInput = h("input", { type: "text", id: "amount", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
  const maxBtn = h("button", { class: "max-btn", id: "max" }, [t("send.max")]);
  const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);
  const balanceHint = h("div", { class: "muted", style: "margin-top:6px" }, [
    t("send.privateBalanceHint", { amount: formatBalanceAmountGrouped(maxAmount.toString(), balance.divisibility), symbol: label }),
  ]);
  const memoInput = h("input", { type: "text", id: "memo", placeholder: "e.g. Remaining savings", maxlength: "200" });

  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const submitBtn = h("button", { class: "primary", id: "submit" }, [t("unshield.submitButton", { symbol: label })]);

  render(
    h("h1", {}, [t("unshield.title")]),
    h("p", { class: "muted" }, [t("unshield.description", { symbol: label })]),
    h("label", {}, [t("unshield.amountToRevealLabel")]),
    amountField,
    balanceHint,
    h("label", {}, [t("unshield.memoLabel")]),
    memoInput,
    h("p", { class: "muted", style: "margin:4px 0 0" }, [t("unshield.memoNote")]),
    statusEl,
    submitBtn,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderTokenDetail(status, balance));

  maxBtn.addEventListener("click", () => {
    const revealMax = maxAmount - 1n;
    (amountInput as HTMLInputElement).value = revealMax > 0n ? formatBalanceAmount(revealMax.toString(), balance.divisibility) : "";
  });

  const showStatus = bindStatus(statusEl);

  submitBtn.addEventListener("click", async () => {
    let raw: bigint;
    try {
      raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, balance.divisibility);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      return;
    }
    if (raw <= 0n) {
      showStatus(t("send.errZeroAmount"), "err");
      return;
    }
    if (raw >= maxAmount) {
      showStatus(t("unshield.errMustStayPrivate"), "err");
      return;
    }
    setBusy(submitBtn as HTMLButtonElement, true, t("unshield.unshielding"));
    showStatus(t("send.submitting"), "ok");
    const memo = (memoInput as HTMLInputElement).value.trim();
    try {
      await send({
        kind: "popup-unshield",
        resourceAddress: balance.resourceAddress,
        revealedAmount: raw.toString(),
        memo: memo || undefined,
      });
      showStatus(t("unshield.unshielded"), "ok");
      setTimeout(async () => {
        const newStatus = await getStatus();
        await renderHome(newStatus);
      }, 700);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(submitBtn as HTMLButtonElement, false);
    }
  });
}

function renderBalances(balancesCard: HTMLElement, balances: Balance[], status: WalletStatus) {
  if (balances.length === 0) {
    balancesCard.replaceChildren(emptyState(t("balances.empty"), ICON_INBOX));
  } else {
    balancesCard.replaceChildren(
      ...balances.map((b) => {
        const label = resourceLabel(b.resourceAddress, b.symbol);
        // Indivisible by definition -- the raw token count, never run through
        // formatBalanceAmountGrouped()'s divisibility math (that produced "0" here before this
        // vault kind was handled: NonFungible has no `.amount`/`.revealed_amount` field at all).
        const amountText =
          b.kind === "NonFungible"
            ? `${b.amount} ${BigInt(b.amount) === 1n ? t("balances.nft") : t("balances.nfts")}`
            : formatBalanceAmountGrouped(b.amount, b.divisibility);
        // A Stealth resource held entirely as shielded funds has `amount === "0"` (nothing
        // revealed) -- without this, the row reads as an empty balance instead of "everything
        // here is private," the exact gap renderTokenDetail() already handles one screen deeper.
        const hasPrivate = b.kind !== "NonFungible" && BigInt(b.confidentialAmount) > 0n;
        const amountCol = h("span", { class: "token-amount-col" }, [
          h("span", { class: "token-amount" }, [amountText]),
          ...(hasPrivate
            ? [
                h("span", { class: "token-amount-private" }, [
                  t("balances.plusPrivate", { amount: formatBalanceAmountGrouped(b.confidentialAmount, b.divisibility) }),
                ]),
              ]
            : []),
        ]);
        const row = h(
          "button",
          {
            class: "balance-row clickable",
            "aria-label": t("balances.rowAria", {
              label,
              amount: amountText,
              privateAria: hasPrivate
                ? t("balances.rowAriaPrivateSuffix", { amount: formatBalanceAmountGrouped(b.confidentialAmount, b.divisibility) })
                : "",
            }),
          },
          [
            h("div", { class: "balance-left" }, [
              tokenAvatar(b.resourceAddress, b.symbol),
              h("span", { class: "token-symbol" }, [label]),
            ]),
            amountCol,
          ]
        );
        row.addEventListener("click", () => renderTokenDetail(status, b));
        return row;
      })
    );
  }
}

/**
 * A token has no on-chain icon (resource metadata is just SYMBOL/name), so TARI gets the wallet's own
 * logo and every other resource a letter on a colour derived from its address -- distinct tokens look
 * distinct instead of all being the same grey circle. No network fetch.
 */
function tokenAvatar(resourceAddress: string, symbol: string | null, large = false): HTMLElement {
  const size = large ? 64 : 28;
  if (resourceAddress === TARI_RESOURCE_ADDRESS) {
    return h("img", { class: "token-avatar token-logo", src: chrome.runtime.getURL("icons/icon48.png"), alt: "", width: String(size), height: String(size), style: `width:${size}px;height:${size}px` });
  }
  let hash = 0;
  for (const ch of resourceAddress) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return h("span", { class: "token-avatar", "aria-hidden": "true", style: `width:${size}px;height:${size}px;font-size:${large ? 26 : 12}px;background:hsl(${hue},45%,28%);color:hsl(${hue},80%,85%);border-color:hsl(${hue},45%,40%)` }, [tokenInitial(resourceAddress, symbol)]);
}

function renderTokenDetail(status: WalletStatus, balance: Balance) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);

  const addrLabel = h("span", {}, [t("common.copy")]);
  const addrCopyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), addrLabel]);
  const addrRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [balance.resourceAddress]), addrCopyBtn]);
  addrCopyBtn.addEventListener("click", () => copyToClipboard(balance.resourceAddress, addrLabel));

  const isXtr = balance.resourceAddress === TARI_RESOURCE_ADDRESS;
  const displayName = isXtr ? t("tokenDetail.tariDisplayName") : (balance.name ?? "—");
  const displaySymbol = resourceLabel(balance.resourceAddress, balance.symbol);

  // Whether to show the private-balance row/Unshield button: NOT `balance.kind === "Confidential"`
  // -- shielding a plain Fungible vault's revealed balance creates a freestanding stealth UTXO
  // substate, which never changes the vault's own on-chain kind. Basing this on the vault kind
  // would hide a real private balance behind a "Fungible" vault forever. Base it on whether there's
  // actually something to show instead.
  const isConfidential = BigInt(balance.confidentialAmount) > 0n || balance.confidentialDecryptFailures > 0;
  const failures = balance.confidentialDecryptFailures;
  // Shield/Unshield/Send-privately are all available for both a seed-derived local account and
  // a daemon-relayed one -- the daemon does the actual spend server-side (see background/index.ts's
  // popup-shield/popup-unshield/popup-send-privately handlers).
  const activeAccountKind = activeAccountSummary(status)?.kind;
  const hasPrivacyActions = activeAccountKind === "local" || activeAccountKind === "daemon";

  // Of the engine's three resource kinds (Fungible, Confidential, Stealth — see
  // demo_token/src/lib.rs's ResourceBuilder usage and StealthTransfer.prepare()'s source for how
  // these are confirmed distinct and fixed at resource-creation time, never convertible), only
  // Stealth resources support shield()/unshield()/sendPrivately()'s StealthTransfer pipeline at
  // all -- attempting it against a Fungible resource (e.g. a plain DemoToken like tUSD) or a real
  // Confidential-vault resource fails on-chain with "Stealth transfer is only allowed for stealth
  // resources". Gate every privacy action on this instead of just `hasPrivacyActions`.
  const isStealthResource = balance.kind === "Stealth";

  const shieldBtn =
    hasPrivacyActions && isStealthResource ? h("button", { class: "secondary" }, [t("tokenDetail.shieldButton", { symbol: displaySymbol })]) : null;
  if (shieldBtn) shieldBtn.addEventListener("click", () => renderShield(status, balance));

  const unshieldBtn =
    hasPrivacyActions && isConfidential && isStealthResource
      ? h("button", { class: "secondary" }, [t("tokenDetail.unshieldButton", { symbol: displaySymbol })])
      : null;
  if (unshieldBtn) unshieldBtn.addEventListener("click", () => renderUnshield(status, balance));

  const sendPrivatelyBtn =
    hasPrivacyActions && isConfidential && isStealthResource
      ? h("button", { class: "secondary" }, [t("tokenDetail.sendPrivatelyButton", { symbol: displaySymbol })])
      : null;

  // A real Confidential-vault resource (distinct from Stealth -- see above) can genuinely carry a
  // nonzero confidential balance that this wallet correctly *displays* (sumConfidentialCommitments
  // in getBalances()), but has no send/unshield pipeline implemented for at all. Silently dropping
  // the buttons here would look like a bug; say so instead. Plain Fungible/NonFungible resources
  // have no private balance to begin with, so isConfidential is already false for them and no note
  // is shown.
  const noPrivacyActionsNote =
    hasPrivacyActions && !isStealthResource && isConfidential
      ? h("div", { class: "muted", style: "margin-top:10px;font-size:13px" }, [t("tokenDetail.noPrivacyActionsNote")])
      : null;
  if (sendPrivatelyBtn) {
    sendPrivatelyBtn.addEventListener("click", async () => {
      sendPrivatelyBtn.setAttribute("disabled", "true");
      try {
        const balances = await send<Balance[]>({ kind: "popup-get-balances" });
        renderSend(status, balances, {
          initialTab: "private",
          initialResourceAddress: balance.resourceAddress,
          onBack: () => renderTokenDetail(status, balance),
        });
      } catch (e) {
        // Otherwise a failed fetch here (e.g. a daemon connection that just dropped) makes this
        // button look broken -- it visibly does nothing at all, with no error anywhere on screen.
        sendPrivatelyBtn.removeAttribute("disabled");
        const original = sendPrivatelyBtn.textContent;
        sendPrivatelyBtn.textContent = e instanceof Error ? e.message : String(e);
        setTimeout(() => {
          sendPrivatelyBtn.textContent = original;
        }, 2500);
      }
    });
  }

  // One card per NFT: the id first, then whatever attributes its on-chain data carries (the chain
  // stores no image -- art, where a collection has any, is generated off-chain from these).
  const nftList = h("div", { style: "font-size:12px;word-break:break-all;max-height:260px;overflow-y:auto" }, [t("tokenDetail.nftLoading")]);
  if (balance.kind === "NonFungible" && balance.nonFungibleTokenIds && balance.nonFungibleTokenIds.length > 0) {
    send<{ tokenId: string; attributes: Array<[string, string]> }[]>({
      kind: "popup-get-nft-details",
      resourceAddress: balance.resourceAddress,
      tokenIds: balance.nonFungibleTokenIds,
    })
      .then((details) => {
        nftList.replaceChildren(
          ...details.map((d) =>
            h("div", { class: "card", style: "margin:6px 0;padding:8px" }, [
              h("div", { class: "muted" }, [d.tokenId]),
              ...(d.attributes.length === 0
                ? [h("div", {}, [t("tokenDetail.nftNoAttributes")])]
                : d.attributes.map(([k, v]) => h("div", {}, [h("span", { class: "muted" }, [`${k}: `]), v]))),
            ])
          )
        );
      })
      .catch(() => nftList.replaceChildren(balance.nonFungibleTokenIds!.join(", ")));
  }

  render(
    h("h1", {}, [t("tokenDetail.title")]),
    h("div", { class: "hero" }, [tokenAvatar(balance.resourceAddress, balance.symbol, true)]),
    h("div", { class: "card" }, [
      h("div", { class: "muted" }, [t("tokenDetail.name")]),
      h("div", { class: "detail-value" }, [displayName]),
      h("div", { class: "muted" }, [t("tokenDetail.symbol")]),
      h("div", { class: "detail-value" }, [displaySymbol]),
      h("div", { class: "muted" }, [isConfidential ? t("tokenDetail.revealedBalanceLabel") : t("tokenDetail.balanceLabel")]),
      h("div", { class: "detail-value" }, [
        balance.kind === "NonFungible"
          ? `${balance.amount} ${BigInt(balance.amount) === 1n ? t("balances.nft") : t("balances.nfts")}`
          : formatBalanceAmountGrouped(balance.amount, balance.divisibility),
      ]),
      ...(balance.kind === "NonFungible" && balance.nonFungibleTokenIds && balance.nonFungibleTokenIds.length > 0
        ? [
            h("div", { class: "muted" }, [t("tokenDetail.tokenIds")]),
            nftList,
          ]
        : []),
      ...(isConfidential
        ? [
            h("div", { class: "muted private-label" }, [icon(ICON_LOCK), t("tokenDetail.privateBalanceLabel")]),
            h("div", { class: "detail-value", style: "color:var(--highlight)" }, [
              formatBalanceAmountGrouped(balance.confidentialAmount, balance.divisibility),
            ]),
            ...(failures > 0
              ? [
                  h("div", { class: "muted", style: "color:var(--bad)" }, [
                    t("tokenDetail.decryptFailures", { count: failures, word: failures === 1 ? "output" : "outputs" }),
                  ]),
                ]
              : []),
          ]
        : []),
      h("div", { class: "muted" }, [t("tokenDetail.resourceAddressLabel")]),
      h("div", { style: "margin-top:4px" }, [addrRow]),
    ]),
    ...(shieldBtn ? [shieldBtn] : []),
    ...(unshieldBtn ? [unshieldBtn] : []),
    ...(sendPrivatelyBtn ? [sendPrivatelyBtn] : []),
    ...(noPrivacyActionsNote ? [noPrivacyActionsNote] : []),
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

function renderAccountSwitcher(status: WalletStatus) {
  const rows = status.accounts.map((account) => {
    const isActive = account.id === status.activeAccountId;
    // .settings-row (a flat list item with hover/active states), not .primary/.secondary -- the
    // previous version rendered every account as a stacked full-width CTA button, with the active
    // one filled solid, reading as "4 buttons" rather than "a list, one item selected."
    const row = h("button", { class: "settings-row", "aria-current": String(isActive) }, [
      h("div", { class: "row", style: "gap:10px;align-items:center" }, [
        accountAvatar(account.address, 28),
        h("div", {}, [
          h("div", { style: "font-weight:600;font-size:13.5px" }, [account.label]),
          account.kind === "daemon" ? h("div", { class: "muted", style: "font-size:11px" }, [t("accountSwitcher.daemonTag")]) : account.kind === "imported" ? h("div", { class: "muted", style: "font-size:11px" }, [t("accountSwitcher.importedTag")]) : "",
        ]),
      ]),
      isActive ? h("span", { class: "settings-row-right" }, [t("accountSwitcher.current")]) : "",
    ]);
    row.addEventListener("click", async () => {
      if (isActive) return;
      await send({ kind: "popup-set-active-account", accountId: account.id });
      renderLoading(t("accountSwitcher.switchingAccount"));
      try {
        const newStatus = await getStatus();
        await renderHome(newStatus);
      } catch (e) {
        render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
      }
    });
    return row;
  });
  const connectDaemonBtn = h("button", { class: "secondary", id: "connectDaemon" }, [t("accountSwitcher.connectDaemonButton")]);
  const back = h("button", { class: "secondary", id: "back" }, [t("common.back")]);
  // .account-switch-list bounds a long account list to a scrollable max-height (same convention
  // as .balances-card/.history-list) instead of growing the popup unboundedly.
  const list = h("div", { class: "card settings-card account-switch-list" }, rows);
  render(h("h1", {}, [t("accountSwitcher.title")]), list, connectDaemonBtn, back);
  connectDaemonBtn.addEventListener("click", () => renderConnectDaemon(status));
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

function renderDaemonConnections(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const list =
    status.daemonConnections.length === 0
      ? emptyState(t("daemonConnections.empty"), ICON_SERVER)
      : h(
          "div",
          {},
          status.daemonConnections.map((c) => {
            const info = h("div", { class: "list-row-info" }, [
              h("div", { class: "list-row-title" }, [c.label]),
              h("div", { class: "list-row-subtitle", title: c.url }, [c.url]),
            ]);
            const removeBtn = h("button", { class: "secondary btn-compact" }, [t("daemonConnections.disconnectButton")]) as HTMLButtonElement;
            confirmThenRun(
              removeBtn,
              t("daemonConnections.disconnectConfirm", { label: c.label }),
              t("daemonConnections.disconnectButton"),
              async () => {
                await send({ kind: "popup-remove-daemon-connection", connectionId: c.id });
                renderLoading(t("daemonConnections.removing"));
                const newStatus = await getStatus();
                // Switching away is only necessary if the removed connection owned the active
                // account — `popup-get-status` already reflects accounts being gone either way.
                if (!newStatus.accounts.some((a) => a.id === newStatus.activeAccountId)) {
                  await send({ kind: "popup-set-active-account", accountId: "local:0" });
                  await renderHome(await getStatus());
                } else {
                  renderDaemonConnections(newStatus);
                }
              }
            );
            const row = h("div", { class: "balance-row" }, [info, removeBtn]);
            return row;
          })
        );
  render(h("h1", {}, [t("daemonConnections.title")]), list, back);
  document.getElementById("back")!.addEventListener("click", () => renderSettings(status));
}

// ---------------------------------------------------------------------------
// Address book
// ---------------------------------------------------------------------------

function renderAddressBook(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const list =
    status.addressBook.length === 0
      ? emptyState(t("addressBook.empty"), ICON_BOOK)
      : h(
          "div",
          {},
          status.addressBook.map((entry) => {
            const info = h("div", { class: "list-row-info" }, [
              h("div", { class: "list-row-title" }, [entry.label]),
              h("div", { class: "list-row-subtitle", title: entry.address }, [entry.address]),
            ]);
            const removeBtn = h("button", { class: "secondary btn-compact" }, [t("addressBook.removeButton")]) as HTMLButtonElement;
            confirmThenRun(removeBtn, t("addressBook.removeConfirm", { label: entry.label }), t("addressBook.removeButton"), async () => {
              await send({ kind: "popup-remove-address-book-entry", id: entry.id });
              renderAddressBook(await getStatus());
            });
            return h("div", { class: "balance-row" }, [info, removeBtn]);
          })
        );

  const labelInput = h("input", { type: "text", placeholder: "e.g. Alice", maxlength: "40" });
  const addressInput = h("input", { type: "text", placeholder: "component_… or otl_…", maxlength: "200" });
  wireLiveValidation(addressInput as HTMLInputElement, (v) => isValidComponentAddress(v) || isValidOotleWalletAddress(v));
  const statusEl = h("div", { class: "status", style: "display:none" });
  const addBtn = h("button", { class: "primary" }, [t("addressBook.saveButton")]);
  const showStatus = bindStatus(statusEl);
  addBtn.addEventListener("click", async () => {
    const label = (labelInput as HTMLInputElement).value.trim();
    const address = (addressInput as HTMLInputElement).value.trim();
    if (!label) {
      showStatus(t("addressBook.errEnterLabel"), "err");
      return;
    }
    if (!isValidComponentAddress(address) && !isValidOotleWalletAddress(address)) {
      showStatus(t("addressBook.errInvalidAddress"), "err");
      return;
    }
    setBusy(addBtn as HTMLButtonElement, true, t("addressBook.saving"));
    try {
      await send({ kind: "popup-add-address-book-entry", label, address });
      renderAddressBook(await getStatus());
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(addBtn as HTMLButtonElement, false);
    }
  });

  render(
    h("h1", {}, [t("addressBook.title")]),
    list,
    h("label", {}, [t("addressBook.labelField")]),
    labelInput,
    h("label", {}, [t("addressBook.addressField")]),
    addressInput,
    statusEl,
    addBtn,
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderSettings(status));
}

// ---------------------------------------------------------------------------
// Connect daemon wallet (the "hardware wallet" flow — connect, then pick accounts to add)
// ---------------------------------------------------------------------------

// Opening the daemon's web UI in a new tab (see below) steals focus, and an extension popup closes
// the instant it loses focus — so whatever the user already typed here would otherwise vanish the
// moment they go mint their API key, the exact point of the button that sends them there. Not the
// API key itself (that's sensitive and short-lived to copy-paste in one sitting); just the two
// fields that are annoying to retype. chrome.storage.session (not .local) so this never persists
// past a full browser restart.
const DAEMON_DRAFT_KEY = "daemonConnectDraft";

async function loadDaemonConnectDraft(): Promise<{ url: string; label: string }> {
  const stored = await chrome.storage.session.get(DAEMON_DRAFT_KEY);
  return (stored[DAEMON_DRAFT_KEY] as { url: string; label: string } | undefined) ?? { url: "", label: "" };
}

function saveDaemonConnectDraft(draft: { url: string; label: string }): void {
  void chrome.storage.session.set({ [DAEMON_DRAFT_KEY]: draft });
}

function clearDaemonConnectDraft(): void {
  void chrome.storage.session.remove(DAEMON_DRAFT_KEY);
}

async function renderConnectDaemon(status: WalletStatus) {
  const draft = await loadDaemonConnectDraft();
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);
  const urlInput = h("input", { type: "text", id: "url", placeholder: "http://127.0.0.1:5100", maxlength: "512" }) as HTMLInputElement;
  urlInput.value = draft.url;
  const keyInput = h("input", { type: "password", id: "apiKey", placeholder: t("connectDaemon.apiKeyPlaceholder"), maxlength: "4096" });
  const labelInput = h("input", {
    type: "text",
    id: "label",
    placeholder: "e.g. Local walletd",
    maxlength: String(MAX_DAEMON_LABEL_LENGTH),
  }) as HTMLInputElement;
  labelInput.value = draft.label;
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const openWebUiBtn = h("button", { class: "secondary", id: "openWebUi", style: "margin-top:8px" }, [t("connectDaemon.openWebUiButton")]);
  const connectBtn = h("button", { class: "primary", id: "connect" }, [t("connectDaemon.connectButton")]);

  render(
    h("h1", {}, [t("connectDaemon.title")]),
    h("p", { class: "muted" }, [t("connectDaemon.description1")]),
    h("p", { class: "muted" }, [
      t("connectDaemon.description2a"),
      h("b", {}, [t("connectDaemon.description2Bold")]),
      t("connectDaemon.description2b"),
    ]),
    h("label", {}, [t("connectDaemon.daemonUrlLabel")]),
    urlInput,
    openWebUiBtn,
    h("label", {}, [t("connectDaemon.apiKeyLabel")]),
    keyInput,
    h("label", {}, [t("addressBook.labelField")]),
    labelInput,
    statusEl,
    connectBtn,
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderAccountSwitcher(status));

  const saveDraft = () => saveDaemonConnectDraft({ url: urlInput.value, label: labelInput.value });
  urlInput.addEventListener("input", saveDraft);
  labelInput.addEventListener("input", saveDraft);

  openWebUiBtn.addEventListener("click", () => {
    saveDraft();
    window.open(deriveWebUiApiKeysUrl(urlInput.value), "_blank");
  });

  const showStatus = bindStatus(statusEl);

  connectBtn.addEventListener("click", async () => {
    let url: string;
    try {
      url = normalizeDaemonUrl(urlInput.value);
    } catch (e) {
      return showStatus(e instanceof Error ? e.message : String(e), "err");
    }
    const apiKey = (keyInput as HTMLInputElement).value.trim();
    if (!apiKey) return showStatus(t("connectDaemon.errPasteApiKey"), "err");
    const label = labelInput.value.trim() || url;
    if (label.length > MAX_DAEMON_LABEL_LENGTH) {
      return showStatus(t("connectDaemon.errLabelTooLong", { max: MAX_DAEMON_LABEL_LENGTH }), "err");
    }

    // manifest.json's `host_permissions` only covers localhost/127.0.0.1 -- a remote daemon (a
    // different LAN host, a tailscale address, etc.) needs its origin granted at connect time via
    // the optional-permissions flow instead. A no-op (resolves true immediately, no prompt) for an
    // origin already covered by host_permissions or a previously-granted optional one. Must run
    // here, in the popup's own foreground context with this click as the user gesture --
    // chrome.permissions.request() cannot be called from the background service worker.
    const origin = `${new URL(url).origin}/*`;
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      return showStatus(
        t("connectDaemon.errPermissionRequestFailed", { origin, error: e instanceof Error ? e.message : String(e) }),
        "err"
      );
    }
    if (!granted) {
      return showStatus(t("connectDaemon.errPermissionDenied", { origin: new URL(url).origin }), "err");
    }

    setBusy(connectBtn as HTMLButtonElement, true, t("connectDaemon.connecting"));
    showStatus(t("connectDaemon.connecting"), "ok");
    try {
      const result = await send<{ connectionId: string; accounts: DaemonAccountOption[] }>({
        kind: "popup-connect-daemon",
        url,
        apiKey,
        label,
      });
      clearDaemonConnectDraft();
      renderDaemonAccountPicker(status, result.connectionId, result.accounts);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(connectBtn as HTMLButtonElement, false);
    }
  });
}

function renderDaemonAccountPicker(status: WalletStatus, connectionId: string, accounts: DaemonAccountOption[]) {
  const back = h("button", { class: "secondary", id: "back" }, [t("common.backArrow")]);

  if (accounts.length === 0) {
    render(
      h("h1", {}, [t("daemonAccountPicker.noAccountsTitle")]),
      h("p", { class: "muted" }, [t("daemonAccountPicker.noAccountsDescription")]),
      back
    );
    document.getElementById("back")!.addEventListener("click", () => renderAccountSwitcher(status));
    return;
  }

  const checkboxes = accounts.map((a) => {
    const checkbox = h("input", { type: "checkbox", id: `acct-${a.componentAddress}` }) as HTMLInputElement;
    checkbox.checked = true;
    const row = h("label", { class: "balance-row", style: "cursor:pointer;gap:10px;justify-content:flex-start" }, [checkbox, a.label]);
    return { checkbox, account: a, row };
  });

  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const addBtn = h("button", { class: "primary", id: "add" }, [t("daemonAccountPicker.addSelectedButton")]);

  render(
    h("h1", {}, [t("daemonAccountPicker.title")]),
    h("p", { class: "muted" }, [t("daemonAccountPicker.description")]),
    h("div", { class: "card" }, checkboxes.map((c) => c.row)),
    statusEl,
    addBtn,
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderAccountSwitcher(status));

  addBtn.addEventListener("click", async () => {
    const selected = checkboxes.filter((c) => c.checkbox.checked).map((c) => c.account);
    if (selected.length === 0) {
      statusEl.style.display = "block";
      statusEl.className = "status err";
      statusEl.textContent = t("daemonAccountPicker.errSelectAtLeastOne");
      return;
    }
    setBusy(addBtn as HTMLButtonElement, true, t("daemonAccountPicker.adding"));
    try {
      await send({
        kind: "popup-add-daemon-accounts",
        connectionId,
        accounts: selected.map((a) => ({ componentAddress: a.componentAddress, label: a.label })),
      });
      renderLoading(t("daemonAccountPicker.switchingToNewAccount"));
      const newStatus = await getStatus();
      await renderHome(newStatus);
    } catch (e) {
      statusEl.style.display = "block";
      statusEl.className = "status err";
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      setBusy(addBtn as HTMLButtonElement, false);
    }
  });
}

function renderRevealMnemonic() {
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  render(
    h("h1", {}, [t("revealMnemonic.title")]),
    h("p", { class: "muted" }, [t("revealMnemonic.description")]),
    h("label", {}, [t("common.password")]),
    h("input", { type: "password", id: "pw", maxlength: "256" }),
    statusEl,
    h("div", { class: "row" }, [
      h("button", { class: "secondary", id: "cancel" }, [t("common.cancel")]),
      h("button", { class: "primary", id: "reveal" }, [t("revealMnemonic.revealButton")]),
    ])
  );
  const pw = document.getElementById("pw") as HTMLInputElement;
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("reveal")!.click();
  });
  document.getElementById("cancel")!.addEventListener("click", goHome);
  document.getElementById("reveal")!.addEventListener("click", async () => {
    try {
      const { mnemonic } = await send<{ mnemonic: string }>({ kind: "popup-reveal-mnemonic", password: pw.value });
      renderMnemonicDisplay(mnemonic);
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.className = "status err";
      statusEl.style.display = "block";
    }
  });
}

function renderMnemonicDisplay(mnemonic: string) {
  const words = mnemonic.split(" ");
  const grid = h(
    "div",
    { class: "mnemonic-grid" },
    words.map((w, i) => h("div", { class: "mnemonic-word" }, [h("span", {}, [String(i + 1)]), w]))
  );
  const back = h("button", { class: "primary", id: "back" }, [t("common.back")]);
  render(h("h1", {}, [t("mnemonicDisplay.title")]), h("p", { class: "muted" }, [t("mnemonicDisplay.description")]), grid, back);
  document.getElementById("back")!.addEventListener("click", goHome);
}

async function renderConnectedSites() {
  const backEarly = h("button", { class: "secondary", id: "back" }, [t("common.back")]);
  render(h("h1", {}, [t("connectedSites.title")]), h("div", { class: "card" }, [skeletonListRow(), skeletonListRow()]), backEarly);
  backEarly.addEventListener("click", goHome);

  const sites = await send<{ origin: string; viewAccessGrantedAt?: number }[]>({ kind: "popup-get-connected-sites" });
  const list =
    sites.length === 0
      ? emptyState(t("connectedSites.empty"), ICON_GLOBE)
      : h(
          "div",
          {},
          sites.flatMap((s) => {
            // Wrapped in list-row-info (not a bare string) for the same reason as the address
            // book/daemon connections rows -- an unusually long origin shouldn't be able to
            // blow out the row width and squeeze the Disconnect button off-screen.
            const hasView = s.viewAccessGrantedAt !== undefined;
            const info = h("div", { class: "list-row-info" }, [
              h("div", { class: "list-row-title", title: s.origin }, [s.origin]),
              // Only shown when granted. A site with no private view access is the normal case and
              // needs no label; a site that can read the user's confidential balance is exactly the
              // thing this screen exists to make visible, so it says so in the row itself rather
              // than hiding behind a detail view.
              hasView ? h("div", { class: "list-row-subtitle view-access-note" }, [t("connectedSites.canSeePrivateBalance")]) : "",
            ]);
            const removeBtn = h("button", { class: "secondary btn-compact" }, [t("connectedSites.disconnectButton")]) as HTMLButtonElement;
            confirmThenRun(
              removeBtn,
              t("connectedSites.disconnectConfirm", { origin: s.origin }),
              t("connectedSites.disconnectButton"),
              async () => {
                await send({ kind: "popup-disconnect-site", origin: s.origin });
                await renderConnectedSites();
              }
            );
            const row = h("div", { class: "balance-row" }, [info, removeBtn]);
            if (!hasView) return [row];
            // Revoking view access is offered as its own action, on its own row, rather than only
            // via Disconnect: a user who wants a dApp to keep working but stop reading their
            // private position shouldn't have to tear down the connection to get it.
            const revokeBtn = h("button", { class: "secondary btn-compact" }, [t("connectedSites.revokeViewAccessButton")]) as HTMLButtonElement;
            confirmThenRun(
              revokeBtn,
              t("connectedSites.revokeConfirm", { origin: s.origin }),
              t("connectedSites.revokeButton"),
              async () => {
                await send({ kind: "popup-revoke-site-view-access", origin: s.origin });
                await renderConnectedSites();
              }
            );
            return [row, h("div", { class: "balance-row view-access-row" }, [h("div", { class: "list-row-info" }, []), revokeBtn])];
          })
        );
  const back = h("button", { class: "secondary", id: "back" }, [t("common.back")]);
  render(h("h1", {}, [t("connectedSites.title")]), list, back);
  document.getElementById("back")!.addEventListener("click", goHome);
}

// ---------------------------------------------------------------------------
// Approval popups (opened by the background service worker)
// ---------------------------------------------------------------------------

async function renderApprovalFlow(approvalId: string) {
  const status = await getStatus();
  if (!status.hasWallet) {
    render(h("div", { class: "status err" }, [t("approval.noWallet")]));
    return;
  }
  if (!status.isUnlocked) {
    renderUnlock(
      () =>
        void getStatus().then((freshStatus) => renderApprovalDetails(approvalId, freshStatus)),
      status.lastKnownAddress
    );
    return;
  }
  await renderApprovalDetails(approvalId, status);
}

/** The account chip shown on both approval screens: whichever account will actually sign, so a
 * user with multiple accounts can confirm which identity/funds a request is exposing before
 * approving. For a transaction, that's the site's connected account (`approval.accountId`, bound
 * at connect time -- NOT necessarily whichever account happens to be active right now); for a
 * connect request, it's the account that was active when the prompt was raised (also carried on
 * `approval.accountId` now, captured up front so the account shown is exactly the one the
 * connection will bind -- see tari_requestAccounts). `undefined` only for a pre-update pending
 * approval with no captured id, which falls back to the current active account. */
function approvalAccountChip(status: WalletStatus, accountId: string | undefined): HTMLElement {
  const resolvedId = accountId ?? status.activeAccountId;
  const account = status.accounts.find((a) => a.id === resolvedId);
  // Show the wallet (otl_…) address -- the public identity a site actually connects to and sends
  // to -- not the component address. The identicon still derives from the component address
  // (account.address), matching the home/Receive convention: text = otl_ wallet address, avatar =
  // component. `receiveAddress` is the *active* account's wallet address (buildStatus only resolves
  // the active one); for an approval that targets a non-active account -- only reachable if the user
  // switched accounts while it sat pending -- fall back to the component address, the sole
  // identifier the AccountSummary carries.
  const displayAddress = resolvedId === status.activeAccountId ? (status.receiveAddress ?? account?.address ?? null) : (account?.address ?? null);
  return h("div", { class: "approval-account-chip" }, [
    accountAvatar(account?.address ?? null, 26),
    h("div", {}, [
      h("div", { style: "font-weight:600;font-size:13px" }, [account?.label ?? t("approval.defaultAccountLabel")]),
      displayAddress ? h("div", { class: "muted", style: "font-size:11px" }, [shortAddr(displayAddress)]) : "",
    ]),
  ]);
}

async function renderApprovalDetails(approvalId: string, status: WalletStatus) {
  const approval = await send<PendingApproval | null>({ kind: "popup-get-pending-approval", approvalId });
  if (!approval) {
    render(h("div", { class: "status err" }, [t("approval.expired")]));
    return;
  }

  // Held open for as long as this approval is showing, purely so the background service worker
  // has an open port keeping it awake -- see the listener's own comment in background/index.ts.
  // Without this, a human taking more than ~30s to actually read the request before clicking is
  // enough to let MV3 tear the worker down first, silently orphaning whichever RPC is waiting on
  // this decision. window.close() (both below and on navigation away) disconnects it on its own;
  // nothing else needs to reference it.
  chrome.runtime.connect({ name: "approval-keepalive" });

  // Live only while `approval.kind === "transaction"` and `feeChoice` is present and unenforced --
  // see the `<select>` built below. Read by `resolve` at click-time, never by re-rendering.
  let chosenFeeType: "private" | "transparent" | undefined =
    approval.kind === "transaction" ? approval.feeChoice?.initial : undefined;

  // Shown for a rejected operation (e.g. `resolveFeeType()` throwing because `chosenFeeType` was
  // switched to "private" on a daemon-connected account, which can't pay a fee privately) --
  // included as the last child of every branch's `render()` call below. Without this, `resolve()`
  // rejecting left the approve/reject buttons dead with no on-screen error at all: the click
  // handler had no try/catch, so the rejection became an unhandled promise rejection instead of
  // anything the user could see (confirmed live: switching to a private fee against a daemon
  // account "silently" did nothing).
  const statusEl = h("div", { class: "status", style: "display:none" });
  const showApprovalStatus = bindStatus(statusEl);

  const resolve = async (approve: boolean) => {
    const approveBtn = document.getElementById("approve") as HTMLButtonElement | null;
    const rejectBtn = document.getElementById("reject") as HTMLButtonElement | null;
    if (approveBtn) setBusy(approveBtn, true, approve ? t("approval.submitting") : t("approval.working"));
    if (rejectBtn) rejectBtn.disabled = true;
    try {
      const feeType = approve ? chosenFeeType : undefined;
      const { resolved } = await send<{ resolved: boolean }>({ kind: "popup-resolve-approval", approvalId, approve, feeType });
      if (!resolved) {
        // The keepalive port above should make this unreachable in practice now, but a service
        // worker restart from some other cause (a browser update, the user quitting Chrome
        // mid-review) still leaves the page's own original request dead with it. Say so instead of
        // closing and letting the user believe it went through.
        render(h("div", { class: "status err" }, [t("approval.connectionLost")]));
        return;
      }
      window.close();
    } catch (e) {
      showApprovalStatus(e instanceof Error ? e.message : String(e), "err");
      if (approveBtn) setBusy(approveBtn, false);
      if (rejectBtn) rejectBtn.disabled = false;
    }
  };

  if (approval.kind === "connect") {
    render(
      h("h1", {}, [t("approval.connectTitle")]),
      h("p", { class: "muted" }, [h("b", {}, [approval.origin]), t("approval.connectDescriptionSuffix")]),
      approvalAccountChip(status, approval.accountId),
      statusEl,
      h("button", { class: "primary", id: "approve" }, [t("approval.connectButton")]),
      h("button", { class: "secondary", id: "reject" }, [t("approval.cancelButton")])
    );
  } else if (approval.kind === "viewAccess") {
    // Spelled out in both directions -- what it does grant and what it doesn't -- because "view
    // access" on its own reads as harmless, and the thing being handed over (the account's entire
    // confidential position, which is the whole reason for holding funds privately) is precisely
    // what nothing else on-chain can see. The "can't spend" half matters just as much: a user who
    // assumes it does authorize spending would refuse grants they'd have been fine with.
    render(
      h("h1", {}, [t("approval.viewAccessTitle")]),
      h("p", { class: "muted" }, [
        h("b", {}, [approval.origin]),
        t("approval.viewAccessPrefix"),
        h("b", {}, [t("approval.viewAccessBold")]),
        t("approval.viewAccessSuffix"),
      ]),
      approvalAccountChip(status, approval.accountId),
      h("div", { class: "view-access-grants" }, [
        h("div", { class: "view-access-grant" }, [t("approval.grant1")]),
        h("div", { class: "view-access-grant" }, [t("approval.grant2")]),
        h("div", { class: "view-access-grant deny" }, [t("approval.deny1")]),
        h("div", { class: "view-access-grant deny" }, [t("approval.deny2")]),
      ]),
      h("p", { class: "muted" }, [t("approval.revokeAnytime")]),
      statusEl,
      h("button", { class: "primary", id: "approve" }, [t("approval.grantViewAccessButton")]),
      h("button", { class: "secondary", id: "reject" }, [t("approval.denyButton")])
    );
  } else if (approval.kind === "signOwnershipProof") {
    // The challenge is shown verbatim and is the one thing the user is actually vouching for --
    // the wallet builds the domain-tagged bytes it actually signs itself (see ownershipProof.ts),
    // never from anything the site supplies, but that's not what a human is evaluating here.
    render(
      h("h1", {}, [t("approval.ownershipTitle")]),
      h("p", { class: "muted" }, [
        h("b", {}, [approval.origin]),
        t("approval.ownershipPrefix"),
        h("b", {}, [t("approval.noSpendBold")]),
        t("approval.periodSuffix"),
      ]),
      approvalAccountChip(status, approval.accountId),
      h("p", { class: "muted" }, [t("approval.signPrompt")]),
      h("div", { class: "raw-details", style: "padding:10px;white-space:pre-wrap;word-break:break-word" }, [approval.challenge]),
      h("p", { class: "muted" }, [t("approval.resourceLine", { resource: approval.resourceAddress })]),
      h("p", { class: "muted" }, [t("approval.outputLine", { output: approval.substateId })]),
      h("div", { class: "view-access-grants" }, [
        h("div", { class: "view-access-grant deny" }, [t("approval.ownershipDeny1")]),
        h("div", { class: "view-access-grant deny" }, [t("approval.ownershipDeny2")]),
      ]),
      statusEl,
      h("button", { class: "primary", id: "approve" }, [t("approval.signButton")]),
      h("button", { class: "secondary", id: "reject" }, [t("approval.rejectButton")])
    );
  } else if (approval.kind === "signWalletOwnershipProof") {
    render(
      h("h1", {}, [t("approval.walletOwnershipTitle")]),
      h("p", { class: "muted" }, [
        h("b", {}, [approval.origin]),
        t("approval.walletOwnershipPrefix"),
        h("b", {}, [t("approval.noSpendBold")]),
        t("approval.periodSuffix"),
      ]),
      approvalAccountChip(status, approval.accountId),
      h("p", { class: "muted" }, [t("approval.signPrompt")]),
      h("div", { class: "raw-details", style: "padding:10px;white-space:pre-wrap;word-break:break-word" }, [approval.challenge]),
      h("p", { class: "muted" }, [t("approval.walletAddressLine", { address: approval.walletAddress })]),
      h("div", { class: "view-access-grants" }, [
        h("div", { class: "view-access-grant deny" }, [t("approval.walletDeny1")]),
        h("div", { class: "view-access-grant deny" }, [t("approval.ownershipDeny2")]),
      ]),
      statusEl,
      h("button", { class: "primary", id: "approve" }, [t("approval.signButton")]),
      h("button", { class: "secondary", id: "reject" }, [t("approval.rejectButton")])
    );
  } else {
    const instructionCards = approval.instructions.map((instr, i) => {
      const { title, detail } = summarizeInstruction(instr);
      const args = summarizeArgs(instr);
      const isLast = i === approval.instructions.length - 1;
      return h("div", { class: `instruction-card${isLast ? "" : " instruction-card-connected"}` }, [
        h("div", { class: "instruction-index" }, [String(i + 1)]),
        h("div", { class: "instruction-body" }, [
          h("div", { class: "instruction-title" }, [title]),
          detail ? h("div", { class: "instruction-detail" }, [detail]) : "",
          args.length > 0 ? h("div", { class: "instruction-args" }, [t("approval.argumentCount", { count: args.length, plural: args.length === 1 ? "" : "s" })]) : "",
        ]),
      ]);
    });

    const rawJson = JSON.stringify(approval.instructions, null, 2);
    const rawDetails = h("details", { class: "raw-details" }, [
      h("summary", {}, [t("approval.viewRawInstructionData")]),
      h("div", { class: "instruction-list" }, [rawJson]),
    ]);

    // Absent for a dry run or `redeemStealthOutputWithPrivateFee` (no `feeChoice` at all -- see
    // that field's own doc comment). `enforced` shows the locked fact as text; otherwise the same
    // sliding switch settings uses (see switchControl) whose `change` updates `chosenFeeType`
    // above for `resolve` to read at click-time.
    const feeChoiceBlock = approval.feeChoice
      ? approval.feeChoice.enforced
        ? h("p", { class: "muted" }, [
            t("approval.feeEnforcedNote", {
              feeType: approval.feeChoice.initial === "private" ? t("settings.feePrivacyPrivate") : t("settings.feePrivacyTransparent"),
            }),
          ])
        : h("div", { class: "fee-choice" }, [
            h("label", { class: "muted", style: "display:block;margin-bottom:6px" }, [t("approval.feePaymentLabel")]),
            switchControl(
              "fee-type-switch",
              approval.feeChoice.initial === "private",
              t("settings.feePrivacyTransparent"),
              t("settings.feePrivacyPrivate")
            ),
            h("p", { class: "muted", style: "font-size:11px;margin:6px 0 0" }, [t("approval.feeHint")]),
          ])
      : "";

    // Each fact on its own line rather than one run-on paragraph -- see
    // summarizeOperationForApproval's doc comment in background/index.ts for why they're already
    // split this way by the time they get here.
    const stepsBlock =
      approval.steps && approval.steps.length > 0
        ? h(
            "div",
            { class: "approval-steps" },
            approval.steps.map((step) => h("div", { class: "approval-step" }, [step]))
          )
        : "";
    const warningBlock = approval.warning ? h("div", { class: "approval-warning" }, [approval.warning]) : "";
    const hasInstructions = approval.instructions.length > 0;

    // Filled in after first paint: simulating can take several seconds, and the rest of the screen
    // is worth reading meanwhile. Stays empty for request kinds the wallet builds itself.
    const previewBlock = h("div", { class: "approval-steps" }, [h("div", { class: "muted" }, [t("approval.previewLoading")])]);
    void send<TransactionPreview | null>({ kind: "popup-preview-transaction-request", approvalId })
      .then((p) => {
        if (!p) return previewBlock.remove();
        const lines: (Node | string)[] = [h("div", { style: "font-weight:600" }, [t("approval.previewTitle")])];
        const warn = (text: string) => h("div", { class: "approval-warning" }, [text]);
        if (p.htlcValue) lines.push(h("div", { class: "approval-step" }, [t("approval.previewHtlcValue", { amount: p.htlcValue })]));
        for (const problem of p.htlcProblems ?? []) lines.push(warn(t("approval.previewHtlcProblem", { problem })));
        if (p.simulated) {
          if (p.wouldFail) lines.push(warn(t("approval.previewWouldFail", { error: p.wouldFail })));
          for (const amount of p.outgoing) lines.push(h("div", { class: "approval-step" }, [t("approval.previewSends", { amount })]));
          for (const amount of p.incoming) lines.push(h("div", { class: "approval-step" }, [t("approval.previewReceives", { amount })]));
          if (p.outgoing.length === 0 && p.incoming.length === 0 && !p.wouldFail) lines.push(h("div", { class: "muted" }, [t("approval.previewNoChanges")]));
        } else if (p.error && !p.htlcValue) {
          lines.push(warn(t("approval.previewUnavailable", { error: p.error })));
        }
        for (const method of p.ownAccountCalls) lines.push(warn(t("approval.previewOwnAccountCall", { method })));
        previewBlock.replaceChildren(...lines);
      })
      .catch((e) => previewBlock.replaceChildren(h("div", { class: "approval-warning" }, [t("approval.previewUnavailable", { error: e instanceof Error ? e.message : String(e) })])));

    render(
      h("h1", {}, [t("approval.transactionTitle")]),
      h("p", { class: "muted" }, [h("b", {}, [approval.origin]), t("approval.transactionDescriptionSuffix")]),
      approvalAccountChip(status, approval.accountId),
      stepsBlock,
      warningBlock,
      approval.dryRun ? "" : previewBlock,
      approval.maxFee ? h("p", { class: "muted" }, [t("approval.maxFeeLine", { fee: approval.maxFee })]) : "",
      approval.dryRun ? h("p", { class: "muted" }, [t("approval.dryRunNote")]) : "",
      feeChoiceBlock,
      hasInstructions ? h("div", { class: "instruction-cards" }, instructionCards) : "",
      hasInstructions ? rawDetails : "",
      statusEl,
      h("button", { class: "primary", id: "approve" }, [approval.dryRun ? t("approval.simulateButton") : t("approval.approveAndSignButton")]),
      h("button", { class: "secondary", id: "reject" }, [t("approval.rejectButton")])
    );
    if (approval.feeChoice && !approval.feeChoice.enforced) {
      document.getElementById("fee-type-switch")!.addEventListener("change", (e) => {
        chosenFeeType = (e.target as HTMLInputElement).checked ? "private" : "transparent";
      });
    }
  }

  document.getElementById("approve")!.addEventListener("click", () => resolve(true));
  document.getElementById("reject")!.addEventListener("click", () => resolve(false));
}

main().catch((e) => {
  render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
});
