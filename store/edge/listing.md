# Microsoft Edge Add-ons submission kit

This kit is for the public listing of Firelink Companion 2.2.2. Upload the shared `firelink-chromium.zip` package produced by the release workflow; do not create a separate Edge codebase or add Edge-only permissions.

## Listing metadata

- Product name: Firelink Companion
- Version: 2.2.2
- Visibility: Public
- Category: Productivity
- Language rows: English, Simplified Chinese, Hebrew, Persian, Ukrainian, Russian
- Website: https://github.com/nimbold/Firelink-Extension
- Support: https://github.com/nimbold/Firelink-Extension/issues
- Privacy policy: https://github.com/nimbold/Firelink-Extension/blob/main/PRIVACY.md
- Mature content: No
- Remote code: No
- Primary purpose: Send browser downloads, links, torrent or magnet handoffs, and user-requested media pages to the paired Firelink desktop download manager for review.
- Content-use note: Users must download only content they are authorized to download. Firelink Companion does not bypass DRM, paywalls, login restrictions, or other access controls.

The manifest's localized short descriptions are in `_locales/*/messages.json`. The long descriptions below are written for the corresponding Edge listing language.

Compatibility note: browsers that do not expose request/document identity to
extensions use the canonical page URL fallback for **Fetch media** instead of
request-observed manifest discovery. Direct manifest links remain supported by
the Firelink desktop Add window.

## Localized long descriptions

### English (`en`)

Firelink Companion connects your browser to the Firelink desktop download manager. Send a browser download, a link, selected links, a magnet link, or a torrent to Firelink and review the request in Firelink's Add window before starting or queuing it. When you choose **Fetch media**, the extension briefly observes the active tab for up to eight seconds and sends one discovered HLS, DASH, or Smooth Streaming manifest when available; otherwise it sends the current page to Firelink's media workflow so you can select an available format there. Discovery is user-triggered, local, active-tab-only, and does not reload the page or fetch manifest bodies or key files. The extension also supports automatic capture for ordinary browser downloads, with recovery for browser restarts and ambiguous handoffs. Requests use a signed local connection to the paired Firelink app on your own computer. There is no remote download service, advertising, analytics, or in-page video overlay. Firelink desktop must be installed and running for handoffs to work. Browser cookies are used only when an automatic ordinary download needs the signed-in browser session; explicit media requests use Firelink's configured media cookie source and never forward a raw browser Cookie header. Use the extension only for content you are authorized to download; it does not bypass DRM, paywalls, login restrictions, or other access controls. Pair once from **Settings > Integrations**, then use the popup or context menu.

### 简体中文 (`zh-CN`, package directory `_locales/zh_CN`)

Firelink Companion 将浏览器与 Firelink 桌面下载管理器连接起来。你可以把浏览器下载、单个链接、选中的多个链接、磁力链接或 Torrent 发送到 Firelink，并在 Firelink 的“添加下载”窗口中检查请求后再开始或排队。选择“获取媒体”时，扩展会在用户触发的活动标签页中最多观察八秒，发送一个已发现的 HLS、DASH 或 Smooth Streaming 清单；找不到清单时才发送当前页面到 Firelink 的媒体工作流，你可以在那里选择可用格式。发现过程仅在本地进行，不会重新加载页面，也不会读取清单正文或密钥文件。扩展也支持普通浏览器下载的自动捕获，并能在浏览器重启或传输结果不明确时恢复状态。请求通过签名连接发送到你自己电脑上的 Firelink，不会发送到远程下载服务，也不包含广告、分析或网页内视频悬浮按钮。需要先安装并运行 Firelink 桌面应用；仅当自动普通下载需要当前浏览器会话时才会使用浏览器 Cookie，显式媒体请求使用 Firelink 配置的媒体 Cookie 来源，且不会转发原始浏览器 Cookie 标头。请仅使用本扩展下载你有权下载的内容；它不会绕过 DRM、付费墙、登录限制或其他访问控制。请在“设置 > 集成”中完成一次配对，然后使用弹出窗口或右键菜单。

### עברית (`he`)

Firelink Companion מחבר את הדפדפן אל מנהל ההורדות Firelink למחשב. אפשר לשלוח הורדה מהדפדפן, קישור יחיד, קישורים שנבחרו, קישור מגנט או קובץ Torrent אל Firelink, ולבדוק את הבקשה בחלון “הוספת הורדות” לפני שמתחילים או מכניסים אותה לתור. בלחיצה על “אחזור מדיה” התוסף צופה בכרטיסייה הפעילה עד שמונה שניות לאחר פעולת המשתמש ושולח מניפסט HLS, DASH או Smooth Streaming אחד אם נמצא; אחרת הוא שולח את הדף הנוכחי לתהליך המדיה של Firelink, שבו אפשר לבחור פורמט זמין. הגילוי מתבצע מקומית, ללא טעינה מחדש וללא קריאת תוכן מניפסטים או קובצי מפתח. התוסף תומך גם בלכידה אוטומטית של הורדות רגילות ובהתאוששות לאחר הפעלה מחדש של הדפדפן או העברה לא חד-משמעית. הבקשות נחתמות ונשלחות אל אפליקציית Firelink המזווגת במחשב שלך. אין שירות הורדות מרוחק, פרסומות, איסוף נתוני שימוש או כפתור מדיה שמוזרק לתוך דפי וידאו. יש להתקין ולהפעיל את Firelink למחשב; עוגיות הדפדפן משמשות רק כאשר הורדה רגילה אוטומטית זקוקה להפעלה מחוברת, ובקשות מדיה מפורשות משתמשות במקור עוגיות המדיה שהוגדר ב-Firelink ואינן מעבירות כותרת Cookie גולמית. יש להשתמש בתוסף רק עבור תוכן שמותר לך להוריד; הוא אינו עוקף DRM, חומות תשלום, הגבלות התחברות או בקרות גישה אחרות. מזווגים פעם אחת דרך הגדרות > שילובים, ואז משתמשים בחלונית או בתפריט ההקשר.

### فارسی (`fa`)

Firelink Companion مرورگر را به دانلودمنیجر دسکتاپ Firelink متصل می‌کند. می‌توانید یک دانلود مرورگر، یک پیوند، چند پیوند انتخاب‌شده، پیوند مگنت یا فایل Torrent را به Firelink بفرستید و درخواست را در پنجرهٔ «افزودن دانلودها» بررسی کنید، سپس آن را شروع یا وارد صف کنید. با انتخاب «دریافت رسانه»، افزونه پس از اقدام کاربر حداکثر هشت ثانیه زبانهٔ فعال را بررسی می‌کند و در صورت یافتن، یک مانیفست HLS، DASH یا Smooth Streaming می‌فرستد؛ در غیر این صورت صفحهٔ فعلی را به جریان رسانهٔ Firelink می‌فرستد تا قالب در دسترس را همان‌جا انتخاب کنید. این کشف فقط به‌صورت محلی انجام می‌شود، صفحه را دوباره بارگذاری نمی‌کند و محتوای مانیفست یا فایل‌های کلید را نمی‌خواند. افزونه از گرفتن خودکار دانلودهای معمولی پشتیبانی می‌کند و پس از راه‌اندازی دوبارهٔ مرورگر یا انتقال مبهم، وضعیت را با احتیاط بازیابی می‌کند. درخواست‌ها با اتصال امضاشده فقط به برنامهٔ Firelink جفت‌شده روی رایانهٔ خودتان ارسال می‌شوند. سرویس دانلود راه دور، تبلیغات، تحلیل آماری یا دکمهٔ رسانه‌ای تزریق‌شده در صفحه وجود ندارد. برای انتقال باید برنامهٔ دسکتاپ Firelink نصب و اجرا شده باشد. کوکی مرورگر فقط زمانی برای دانلود معمولی خودکار استفاده می‌شود که نشست واردشدهٔ مرورگر لازم باشد؛ درخواست‌های صریح رسانه از منبع کوکی رسانه‌ای تنظیم‌شده در Firelink استفاده می‌کنند و سرآیند خام Cookie مرورگر را ارسال نمی‌کنند. این افزونه را فقط برای محتوایی استفاده کنید که اجازهٔ دانلود آن را دارید؛ افزونه DRM، دیوار پرداخت، محدودیت ورود یا کنترل دسترسی دیگری را دور نمی‌زند. یک بار از مسیر «تنظیمات > یکپارچه‌سازی‌ها» جفت شوید و سپس از پنجرهٔ افزونه یا منوی راست‌کلیک استفاده کنید.

### Українська (`uk`)

Firelink Companion з’єднує браузер із настільним менеджером завантажень Firelink. Надсилайте до Firelink завантаження браузера, окреме посилання, вибрані посилання, magnet-посилання або torrent і переглядайте запит у вікні додавання Firelink перед запуском чи постановкою в чергу. Коли ви вибираєте **Отримати медіа**, розширення після дії користувача протягом не більш як восьми секунд спостерігає за активною вкладкою й надсилає один знайдений маніфест HLS, DASH або Smooth Streaming; якщо маніфест не знайдено, надсилається поточна сторінка до медіаробочого процесу Firelink, де можна вибрати доступний формат. Виявлення відбувається локально, без перезавантаження сторінки та без читання вмісту маніфестів або файлів ключів. Розширення також підтримує автоматичне перехоплення звичайних завантажень і відновлення після перезапуску браузера або неоднозначної передачі. Запити надсилаються підписаним локальним з’єднанням до спареного застосунку Firelink на вашому комп’ютері. Немає віддаленого сервісу завантажень, реклами, аналітики чи кнопки медіа, що вставляється у відеосторінки. Для передачі потрібно встановити й запустити Firelink для настільного ПК. Файли cookie браузера використовуються лише тоді, коли автоматичному звичайному завантаженню потрібен активний сеанс; явні медіазапити використовують налаштоване джерело медіа-cookie у Firelink і не передають необроблений заголовок Cookie браузера. Використовуйте розширення лише для вмісту, який ви маєте право завантажувати; воно не обходить DRM, платний доступ, обмеження входу чи інший контроль доступу. Виконайте спарування один раз у розділі **Налаштування > Інтеграції**, а потім користуйтеся спливаючим вікном або контекстним меню.

### Русский (`ru`)

Firelink Companion связывает браузер с настольным менеджером загрузок Firelink. Отправляйте в Firelink загрузку браузера, отдельную ссылку, выбранные ссылки, magnet-ссылку или torrent и проверяйте запрос в окне добавления Firelink перед запуском или постановкой в очередь. При выборе **Получить медиа** расширение после действия пользователя наблюдает за активной вкладкой не более восьми секунд и отправляет один найденный манифест HLS, DASH или Smooth Streaming; если манифест не найден, отправляется текущая страница в медиапроцесс Firelink, где можно выбрать доступный формат. Обнаружение выполняется локально, без перезагрузки страницы и без чтения содержимого манифестов или файлов ключей. Расширение также поддерживает автоматический перехват обычных загрузок и восстановление после перезапуска браузера или неоднозначной передачи. Запросы отправляются по подписанному локальному соединению в сопряжённое приложение Firelink на вашем компьютере. Здесь нет удалённого сервиса загрузок, рекламы, аналитики или медиа-кнопки, встроенной в страницы с видео. Для передачи необходимо установить и запустить настольное приложение Firelink. Файлы cookie браузера используются только когда автоматической обычной загрузке нужен активный сеанс браузера; явные запросы медиа используют настроенный источник cookie для медиа в Firelink и не передают необработанный заголовок Cookie браузера. Используйте расширение только для контента, который вам разрешено загружать; оно не обходит DRM, платный доступ, ограничения входа или другие средства контроля доступа. Выполните сопряжение один раз в разделе **Настройки > Интеграции**, затем пользуйтесь всплывающим окном или контекстным меню.

## Permission and host-access justifications

These explanations correspond to the current manifest. The submission should not describe any permission as being used for a broader purpose.

| Manifest item | Justification for the Edge form |
| --- | --- |
| `downloads` | Observe the browser download lifecycle and, only for an enabled automatic capture, pause, resume, or cancel the original browser download after Firelink confirms whether it accepted the handoff. This also supports recovery of interrupted or ambiguous captures. |
| `contextMenus` | Add user-invoked actions for downloading a link or selected links, fetching media from the current page, and sending magnet or torrent links to Firelink. |
| `storage` | Store the user's pairing token, capture and site preferences, language/theme choices, and safe pending-handoff state needed to recover across service-worker restarts. |
| `alarms` | Schedule bounded recovery and retry checks for pending browser handoffs when the background service worker is suspended and later restarted. |
| `scripting` | Request the packaged content-script result needed to collect selected links when a context-menu selection cannot be read directly from the tab event. No remote script is fetched or executed. |
| `notifications` | Tell the user whether Firelink accepted, rejected, or could not safely complete a handoff, including cases where the original browser download remains paused to avoid a duplicate. |
| `cookies` | Read browser cookies only for an automatic ordinary download whose signed-in browser session is needed. Explicit media requests may send one discovered manifest or the page URL and do not forward a raw browser cookie header. |
| `webRequest` | Observe non-blocking request metadata only during a user-triggered, active-tab Fetch media session, for at most eight seconds, so the extension can identify one manifest and safe request context. It does not block, modify, replay, or continuously record requests. |
| `<all_urls>` host permission | Support automatic capture and user-invoked link/media actions on arbitrary sites, including authenticated pages and pages whose download URLs are not known in advance. The extension sends handoff data only to the paired local Firelink app. |

## Privacy and data-use form guidance

Use [`PRIVACY.md`](../../PRIVACY.md) as the public policy URL after the repository version is published. The extension handles browsing and download information locally to perform the requested handoff, and it can handle authentication information in the form of browser cookies for the narrowly described automatic ordinary-download path. Select the Edge form's data categories that match the current policy and source behavior; do not claim that the extension never accesses browsing activity or personal information.

The extension has no advertising, analytics, remote code, remote download backend, or sale of data. Disclose the dependency on the separately installed Firelink desktop application because the extension's main purpose is a local handoff to that application.

## Certification notes

### Reviewer setup

1. Install the Firelink desktop application and start it.
2. Install Firelink Companion from the submitted Edge package.
3. In Firelink, open **Settings > Integrations** and copy a test pairing token.
4. Open the extension popup, paste the token, save it, and confirm the popup reports a secure connection.
5. Use a public, non-authenticated test file for an ordinary download. Confirm that the request opens Firelink's Add window and that the browser download is not discarded before Firelink confirms acceptance.
6. From a normal web page, test **Fetch media** in the popup and from the page context menu. Confirm that one visible manifest is selected when available, that the canonical page is used as fallback, that the request opens Firelink's Add window for format selection, and that the extension does not add an in-page player button.
7. Test a link, selected links, a magnet URI, and a `.torrent` link from the context menu. Confirm that each request is reviewed in Firelink's Add window.
8. Restart or suspend the browser service worker during a pending handoff and verify that recovery does not duplicate or prematurely resume the original download.

No reviewer account, private URL, or secret token is required. If a test token is needed, generate it in a local Firelink installation and revoke or replace it after review. The desktop dependency, local-only transport, cookie boundary, and lack of remote code should be called out in the submission notes.

### Scope and content notes

- The extension has one purpose: browser-to-Firelink download handoff and review.
- It does not provide an IDM-style in-page overlay; media actions remain in the popup and context menus.
- Clear media and non-DRM encrypted HLS such as AES-128 may work when the
  bundled yt-dlp engine can legitimately access the manifest and key. DRM/CDM,
  license-server, and other protected-key workflows are unsupported and are not
  bypassed; this release adds no subtitle or multiple-audio-track selection UI.
- It does not bypass DRM, inject remote code, or upload browsing data to a remote service.
- The submitted ZIP must contain the manifest at its root and must not contain the repository's `dist` parent directory, tests, or store documentation.

## Store asset checklist

- `assets/logo-300.png`: square 300×300 listing logo derived from the Firelink brand icon.
- `assets/tile-440x280.png`: 440×280 promotional tile for the listing.
- `screenshots/`: optional but recommended real Edge extension screenshots after runtime validation. Do not upload the capture instructions file as a screenshot.
- Use the same `firelink-chromium.zip` package for Edge and other Chromium browsers.
- Confirm that all six locale rows are populated in Partner Center and that the privacy URL, category, support URL, permission explanations, and listing descriptions have no incomplete fields before selecting Publish.
