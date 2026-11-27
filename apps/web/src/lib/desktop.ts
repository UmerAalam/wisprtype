import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/** The Rust side registers Alt+W globally and forwards it to the webview. */
export async function onToggle(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  return listen("wispr-toggle", handler)
}

export async function showBar(): Promise<void> {
  if (isDesktop()) await invoke("show_bar")
}

export async function hideBar(): Promise<void> {
  if (isDesktop()) await invoke("hide_bar")
}

/** Insert the transcript into the field that had focus before the bar opened. */
export async function insertText(text: string): Promise<void> {
  if (!isDesktop()) {
    await copyText(text)
    return
  }
  await invoke("insert_text", { text })
}

export async function copyText(text: string): Promise<void> {
  if (isDesktop()) {
    await writeText(text)
    return
  }
  await navigator.clipboard.writeText(text)
}
