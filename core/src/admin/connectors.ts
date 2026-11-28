import type { SettingsStore } from "../proactive/schedule.ts";

/**
 * Built-in connectors: groups of tools the user can switch on and off in the Control Center.
 * A switched-off connector's tools are not offered to the model and are blocked by policy.
 */
export interface Connector {
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** Runs inside the Phoenix Mac app (uses its macOS permissions). */
  onMac?: boolean;
  status?: string;
}

export const CONNECTORS: Connector[] = [
  { id: "web", name: "Web search", description: "Current information: weather, news, prices, opening hours.", tools: ["web_search"] },
  { id: "calendar", name: "Calendar", description: "Read your calendar and add events (no invitations).", tools: ["calendar_events", "calendar_add_event"], onMac: true },
  { id: "reminders", name: "Reminders", description: "List, add and complete Apple Reminders.", tools: ["reminders_list", "reminders_add", "reminders_complete"], onMac: true },
  { id: "messages", name: "Contacts & iMessage", description: "Look people up and send iMessages (always with your OK).", tools: ["contacts_search", "messages_send"], onMac: true },
  { id: "apple_notes", name: "Apple Notes", description: "Create notes that sync to your iPhone.", tools: ["apple_notes_create"], onMac: true },
  { id: "apps", name: "Open apps & websites", description: "Open an app or a web page.", tools: ["app_open"], onMac: true },
  { id: "files", name: "Files & documents", description: "Read, move and trash files in Documents, Desktop and Downloads.", tools: ["documents_list", "document_read", "files_move", "files_trash"] },
  { id: "shortcuts", name: "Shortcuts", description: "Run your Shortcuts (always with your OK).", tools: ["shortcuts_list", "shortcuts_run"] },
  { id: "media", name: "Images & video", description: "Create images on-device, record the screen, trim and caption videos.",
    tools: ["image_create", "screen_record_start", "screen_record_stop", "video_trim", "video_captions", "video_remove_silence", "media_transcribe"], onMac: true },
  { id: "screen", name: "Screen control", description: "Operate allowed apps on screen, incl. iPhone Mirroring.", tools: ["screen_act"], onMac: true },
  { id: "email", name: "Email", description: "Drafts go to a local outbox for now.", tools: ["outbox_send"], status: "Gmail sign-in on hold" },
  { id: "phoenix_notes", name: "Phoenix notes", description: "Private notes kept by Phoenix on this Mac.", tools: ["notes_save", "notes_list", "notes_read"] },
];

export function disabledConnectors(settings: SettingsStore): Set<string> {
  return new Set(settings.get<string[]>("connectors.disabled", []));
}

/** Tool names switched off by the user. */
export function disabledTools(settings: SettingsStore): Set<string> {
  const off = disabledConnectors(settings);
  return new Set(CONNECTORS.filter((c) => off.has(c.id)).flatMap((c) => c.tools));
}

export function setConnector(settings: SettingsStore, id: string, enabled: boolean): void {
  if (!CONNECTORS.some((c) => c.id === id)) throw new Error(`no connector "${id}"`);
  const off = disabledConnectors(settings);
  if (enabled) off.delete(id);
  else off.add(id);
  settings.set("connectors.disabled", [...off]);
}
