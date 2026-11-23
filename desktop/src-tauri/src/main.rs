// В релизной сборке под Windows не открывать консоль.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! SelfNote для macOS (и позже Windows): веб-клиент из `app/apps/web`
//! (сборка `--mode desktop`) в системном WebView. Адрес сервера выбирается
//! в самом интерфейсе при первом запуске.

use std::path::{Path, PathBuf};

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Действия меню, которые выполняет веб-клиент (обработчик `selfnote:menu` в App.tsx).
const WEB_ACTIONS: [&str; 4] = ["new-note", "new-list", "search", "settings"];

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build);

    builder
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("SelfNote")
                .inner_size(1280.0, 820.0)
                .min_inner_size(860.0, 560.0)
                .on_download(|webview, event| {
                    // экспорт заметок и резервные копии — сразу в «Загрузки»
                    if let DownloadEvent::Requested { destination, .. } = event {
                        if let Ok(dir) = webview.path().download_dir() {
                            *destination = unique_path(&dir, destination);
                        }
                    }
                    true
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить SelfNote");
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if id == "reload" {
        let _ = window.eval("location.reload()");
    } else if WEB_ACTIONS.contains(&id) {
        let _ = window.eval(&format!(
            "window.dispatchEvent(new CustomEvent('selfnote:menu', {{ detail: '{id}' }}))"
        ));
    }
}

/// «Загрузки/имя.zip», а если такой файл уже есть — «имя 2.zip», «имя 3.zip»…
fn unique_path(dir: &Path, suggested: &Path) -> PathBuf {
    let name = suggested
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "SelfNote".into());
    let candidate = dir.join(&name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(&name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|i| dir.join(format!("{stem} {i}{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(candidate)
}

#[cfg(target_os = "macos")]
mod menu {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Runtime};

    pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        let sep = || PredefinedMenuItem::separator(app);
        let item = |id: &str, text: &str, accel: &str| {
            MenuItem::with_id(app, id, text, true, Some(accel))
        };

        let about = AboutMetadata {
            name: Some("SelfNote".into()),
            copyright: Some("© 2026 Вячеслав Кожевятов".into()),
            ..Default::default()
        };
        let app_menu = Submenu::with_items(
            app,
            "SelfNote",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("О программе SelfNote"), Some(about))?,
                &sep()?,
                &item("settings", "Настройки…", "CmdOrCtrl+,")?,
                &sep()?,
                &PredefinedMenuItem::services(app, Some("Службы"))?,
                &sep()?,
                &PredefinedMenuItem::hide(app, Some("Скрыть SelfNote"))?,
                &PredefinedMenuItem::hide_others(app, Some("Скрыть остальные"))?,
                &PredefinedMenuItem::show_all(app, Some("Показать все"))?,
                &sep()?,
                &PredefinedMenuItem::quit(app, Some("Завершить SelfNote"))?,
            ],
        )?;
        let file = Submenu::with_items(
            app,
            "Файл",
            true,
            &[
                &item("new-note", "Новая заметка", "CmdOrCtrl+N")?,
                &item("new-list", "Новый список задач", "CmdOrCtrl+Shift+L")?,
                &sep()?,
                &PredefinedMenuItem::close_window(app, Some("Закрыть окно"))?,
            ],
        )?;
        let edit = Submenu::with_items(
            app,
            "Правка",
            true,
            &[
                &PredefinedMenuItem::undo(app, Some("Отменить"))?,
                &PredefinedMenuItem::redo(app, Some("Повторить"))?,
                &sep()?,
                &PredefinedMenuItem::cut(app, Some("Вырезать"))?,
                &PredefinedMenuItem::copy(app, Some("Копировать"))?,
                &PredefinedMenuItem::paste(app, Some("Вставить"))?,
                &PredefinedMenuItem::select_all(app, Some("Выбрать все"))?,
            ],
        )?;
        let view = Submenu::with_items(
            app,
            "Вид",
            true,
            &[
                &item("search", "Поиск", "CmdOrCtrl+K")?,
                &sep()?,
                &item("reload", "Обновить", "CmdOrCtrl+R")?,
                &PredefinedMenuItem::fullscreen(app, Some("Полноэкранный режим"))?,
            ],
        )?;
        let window = Submenu::with_items(
            app,
            "Окно",
            true,
            &[
                &PredefinedMenuItem::minimize(app, Some("Свернуть"))?,
                &PredefinedMenuItem::maximize(app, Some("Масштаб"))?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
    }
}
