//! Right Ctrl hold-to-talk.
//!
//! `tauri-plugin-global-shortcut` cannot serve this: on Windows it wraps
//! RegisterHotKey, which only reports key-down and never the release. A
//! `WH_KEYBOARD_LL` hook sees both, but its callback runs on the installing
//! thread and holds up the system's whole keyboard pipeline, so the callback
//! only makes a non-blocking channel send while another thread does the
//! emitting.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, HHOOK, MSG, WH_KEYBOARD_LL,
};

const VK_RCONTROL: u32 = 0xA3;
/// KBDLLHOOKSTRUCT flags bit that separates a release from a press.
const LLKHF_UP: u32 = 0x80;
/// A held key repeats WM_KEYDOWN, which must not restart the recording.
static HELD: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, Copy)]
struct KeyEvent {
    down: bool,
}

/// Raw mirror of KBDLLHOOKSTRUCT read from lParam, so whichever field naming
/// the locked `windows` release happens to use stays irrelevant.
#[repr(C)]
struct RawRecord {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}

static SENDER: Mutex<Option<SyncSender<bool>>> = Mutex::new(None);

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let record = unsafe { &*(lparam.0 as *const RawRecord) };
        if record.vk_code == VK_RCONTROL {
            let released = (record.flags & LLKHF_UP) != 0;
            let sender = SENDER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

            if released {
                if HELD.swap(false, Ordering::SeqCst) {
                    if let Some(tx) = sender.as_ref() {
                        let _ = tx.try_send(false);
                    }
                }
            } else if !HELD.swap(true, Ordering::SeqCst) {
                if let Some(tx) = sender.as_ref() {
                    let _ = tx.try_send(true);
                }
            }
        }
    }

    unsafe { CallNextHookEx(Some(HHOOK::default()), code, wparam, lparam) }
}

/// Installs the hook and pumps messages, which a low-level hook requires.
fn install(sender: SyncSender<bool>) {
    *SENDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sender);

    unsafe {
        let Ok(_hook) =
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) else {
                return;
            };

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {}
    }
}

/// Forwards Right Ctrl presses and releases to the webview as `wispr-key`.
pub fn spawn(app: AppHandle) {
    let (tx, rx) = sync_channel::<bool>(8);
    thread::spawn(move || install(tx));

    thread::spawn(move || {
        for down in rx {
            let _ = app.emit("wispr-key", KeyEvent { down });
        }
    });
}
