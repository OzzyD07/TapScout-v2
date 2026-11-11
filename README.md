# TapScout v2

Kendi mobil uygulama build'lerini, MCP'ye bağlı bir ajana **gerçek bir Android emülatöründe ve iOS
Simulator'da yereldeki bir cihaz gibi** kullandırmak için. Cihazlar ücretsiz GitHub Actions
runner'larında (veya bu bilgisayardaki emülatörde) açılır. Hangi testin yapılacağına ve neyin hata
olduğuna **bağlı ajan karar verir**. TapScout yalnızca komutları uygular, ekranı gösterir ve kanıtı
saklar.

- Model API'si yok, API anahtarı yok, ücretli servis yok. Supabase ve Vercel kaldırıldı. Veriler
  `.data/` altında düz dosyalar olarak durur.
- Web arayüzü ve MCP sunucusu yerelde çalışır (`127.0.0.1`).
- TapScout v1'in (Nebius hackathon) GitHub Actions cihaz altyapısı korundu: KVM'li Android
  emülatörü, macOS iOS Simulator, Appium (UiAutomator2 / XCUITest), önceden derlenmiş WDA, OIDC
  kimliği.

## Mimari

```
MCP istemcisi (Claude Code, Claude Desktop…)
   │ stdio köprüsü veya http://127.0.0.1:4780/mcp
   ▼
Hub (yerel)  ── web arayüzü :4780 (canlı yayın, ajanın gördükleri, bulgular, dosyalar)
   │            dosya deposu .data/ · GitHub dispatch/cancel (gh token)
   │ runner ağ geçidi :4781 ── yalnızca bu port dışarı açılır (cloudflared quick tunnel)
   ▲ WebSocket (runner bağlantıyı dışarıdan başlatır) + build indirme + kanıt yükleme
Runner (GitHub Actions job veya yerel süreç)
   OIDC ile kimlik → build'i hub'dan indir, SHA-256 doğrula → Appium oturumu → komut bekle
   Android: emülatör + UiAutomator2 · iOS: Simulator + XCUITest/WDA
```

| Paket | Görev |
|---|---|
| `packages/hub` | MCP sunucusu, yerel web arayüzü, oturum yönetimi, runner ağ geçidi, tünel, rapor |
| `packages/runner` | Cihaz tarafı: Appium kontrolü, canlı kare akışı, kare yakalama, kayıt, log ve çökme toplama |
| `packages/shared` | Hub ve runner protokolü, koordinat dönüşümleri, UI ağacı normalizasyonu |
| `apps/sample-app` | FieldNotes: bilinen hatalar içeren örnek Expo uygulaması (doğrulama için) |
| `.github/workflows/device-session.yml` | Bir cihaz oturumu (Android veya iOS) |
| `.github/workflows/build-sample.yml` | Örnek uygulamanın APK'sı ve iOS Simulator `.app.zip`'i (artifact) |

## Kurulum

Gerekenler: Node.js 22.13+, pnpm 10, GitHub CLI (`gh auth login`). Yerel Android için Android
SDK (adb ve emülatör) gerekir.

```bash
pnpm install          # paketleri derler (prepare)
pnpm setup:local      # .tools/ altına Appium + UiAutomator2 (+ macOS'ta XCUITest) ve cloudflared kurar
pnpm hub              # hub: http://127.0.0.1:4780
```

GitHub oturumları için repo `main` dalında `device-session.yml` workflow'unu içermelidir. Hub,
workflow'u `gh auth token` ile tetikler. Repo varsayılan olarak `origin` uzak deposundan okunur
(`TAPSCOUT_GITHUB_REPO` ile değiştirilebilir). Diğer ayarlar için [`.env.example`](.env.example)
dosyasına bakın.

### MCP bağlantısı

- **Claude Code (bu repo içinde):** `.mcp.json` hazır gelir (stdio köprüsü). Hub çalışmıyorsa
  köprü onu arka planda başlatır (log: `.data/hub.log`).
- **Claude Code (HTTP, hub açıkken):**
  `claude mcp add --transport http tapscout http://127.0.0.1:4780/mcp`
- **Claude Desktop:** `claude_desktop_config.json` içine
  `{"mcpServers":{"tapscout":{"command":"node","args":["<repo>/packages/hub/dist/mcp-stdio.js"]}}}`

Oturumlar istemciden bağımsız olarak hub'da yaşar. İstemci yeniden başlasa da oturum sürer.
`/mcp__tapscout__test_app` prompt'u önerilen test döngüsünü başlatır.

Bir aracı elle çağırmak için (görüntüler `--out` klasörüne kaydedilir):

```bash
node packages/hub/dist/call.js --list
node packages/hub/dist/call.js device_screenshot '{"annotate":"elements"}' --out shots
```

## MCP araçları

| Grup | Araçlar |
|---|---|
| Oturum | `session_start`, `session_status` (en fazla 50 sn bekleyebilir), `session_list`, `session_stop`, `session_report` |
| Gözlem | `device_screenshot` (isteğe bağlı element kutuları ve ızgara), `device_zoom` (görünüm birimleriyle etiketli ızgara), `device_ui_tree` (compact, json veya xml) |
| Dokunma | `device_tap` (tek veya çift; `alert:<düğme>` ile diyalog yanıtı), `device_long_press`, `device_swipe`, `device_drag`, `device_scroll`, `device_pinch` |
| Metin | `device_type` (append veya replace, submit, secret), `device_key` (Android tuşları; iOS'ta temel tuşlar), `device_keyboard` (status veya hide) |
| Uygulama | `app_restart` (veri silmeyle ya da silmeden), `app_control` (launch, terminate, background, state, open_url, clear_data), `device_rotate`, `device_wait` (idle, text, text_gone) |
| Ortam | `device_environment`: koyu/açık mod, uygulama dili, yazı boyutu, GPS konumu, internetsiz mod, push bildirimi, Face ID / parmak izi, galeriye fotoğraf veya video |
| Zaman | `device_capture_frames` (bir eylem etrafında zaman damgalı kareler; kontak sayfası), `device_recent_frames` (canlı tampon), `device_recording` (MP4) |
| Görsel kalite | `device_visual_audit`: kontrast, küçük dokunma alanı, etiketsiz kontrol, çakışma, ekran dışına taşma, kesilmiş metin, hizasızlık, durum çubuğu / home indicator altında kalan kontrol |
| Performans | `device_performance`: `snapshot` (CPU ve bellek), `sample` (zaman içinde CPU ve bellek), `launch` (soğuk veya sıcak açılış), `action` (bir eylemin görsel tepkisi, fps, takılma; Android'de gfxinfo jank) |
| Testler | `test_record`, `test_expect`, `test_save` (ajanın yaptığı adımları test olarak kaydeder), `test_list`, `test_get`, `test_delete`, `test_run` (bir veya birden çok oturumda, paralel), `test_results`, `test_compare` (build'ler arası tablo) |
| Kanıt | `device_logs`, `device_crashes`, `evidence_capture`, `finding_record` |

**Koordinatlar:** bütün x, y ve bölge değerleri *görünüm birimidir*. Görünüm birimi,
`device_screenshot` görüntüsünün pikselidir (örneğin 576×1280). Hub bunu Android'de px'e, iOS'ta
pt'ye çevirir. Element hedefleri de kullanılabilir: `e12`, `id:login_button`, `text:Kaydet`.
Bir eylemden sonra ref'ler eski kalırsa hub elementi yeni ağaçta kimliğine göre yeniden bulur.

## Görsel kalite, performans ve regresyon testleri

Bu araçlar ölçer, gözlemler ve kanıt toplar. Neyin hata olduğuna yine ajan karar verir.

- **Görsel denetim (`device_visual_audit`):** UI ağacındaki kutular ve ekran görüntüsünün
  pikselleri üzerinde çalışır. Kontrast, metnin kendi kutusundaki ön plan ve arka plan
  renklerinden WCAG oranıyla ölçülür (normal metin 4,5:1, büyük metin 3:1). Dokunma alanı sınırı
  Android'de 48 dp, iOS'ta 44 pt'dir. Sonuç, numaralı adaylar ve aynı numaralarla işaretlenmiş
  ekran görüntüsüdür; her aday için önem ve güven derecesi verilir. Adaylar ipucudur: ajan onları
  görüntüde veya `device_zoom` ile doğrular, sonra `finding_record` ile kaydeder. Koyu mod, büyük
  yazı, başka dil (`device_environment`) ve yatay ekran (`device_rotate`) sonrasında tekrar
  çalıştırılır. Denetimler `evidence/audits/` altına JSON ve işaretli görüntü olarak kaydedilir ve
  raporda görünür.
- **Performans (`device_performance`):**

  | Ölçüm | Android | iOS Simulator |
  |---|---|---|
  | CPU | `/proc/<pid>/stat` (tek çekirdeğe göre %, 100'ü aşabilir) | uygulama sürecinin macOS'taki `ps` CPU süresinden (aynı birim) |
  | Bellek | `dumpsys meminfo` (PSS, RSS, Java/Native heap, grafik), iş parçacığı sayısı | `ps` RSS, iş parçacığı sayısı |
  | Açılış | `am start -W` TotalTime + ekranın durulduğu an | XCTest'in uygulamayı açma süresi + ekranın durulduğu an |
  | Eylem tepkisi | Ekran videosundan: ilk değişiklik, durulma, hareket sırasındaki fps, en uzun duraklama | aynısı (`simctl` videosu) |
  | Kare zamanlaması | `dumpsys gfxinfo` (jank yüzdesi, 50/90/95/99. yüzdelik kare süresi) | yok |
  | Donma ve ANR | `device_crashes` (ANR kayıtları), eylem ölçümündeki uzun duraklamalar | `device_crashes`, uzun duraklamalar |

  Emülatör ve simülatör, ana makinenin CPU'sunu ve GPU'sunu paylaşır. Değerler gerçek cihazla
  aynı değildir; aynı kurulumdaki build'leri ve ekranları karşılaştırmak için kullanılır. iOS'ta
  Instruments veya XCTMetric yoktur: bunlar uygulamanın içine derlenen bir test paketi ya da
  `xctrace` kaydı ister. Ölçümler `evidence/perf/` altına kaydedilir ve raporda görünür.
- **Tekrarlanabilir testler:** Ajan uygulamayı normal araçlarla kullanırken `test_record` kaydı
  başlatır. Her eylem bir adım olur ve hedef, cihazdan bağımsız biçimde saklanır: önce `id`, sonra
  metin, rol ve sıra; element yoksa ekran oranı. `test_expect` beklenen sonucu ekler: element
  görünür veya görünmez, metin eşittir veya içerir, uygulama çalışıyor, çökme yok, ekran kayıtlı
  görüntüye benziyor. `test_save` testi `.data/tests/<id>/test.json` dosyasına yazar. Ajan testi
  daha sonra `test_get` ile okuyup değiştirip `test_save` ile yeni sürüm olarak kaydedebilir.
- **Tekrar çalıştırma ve regresyon:** `test_run`, testleri bir veya birden çok hazır oturumda
  (örneğin aynı build'in Android ve iOS oturumlarında) paralel ve arka planda çalıştırır. Adımları
  ve beklentileri TapScout uygular ve kontrol eder; bu sırada ajan karar vermez. Başarısız adımda
  ekran görüntüsü, UI ağacı ve log kanıt olarak saklanır. Her sonuç, aynı platformdaki farklı bir
  build'in son sonucuyla karşılaştırılır:

  | Önce | Şimdi | Sınıf |
  |---|---|---|
  | geçti | geçmedi | **REGRESSION** |
  | geçmedi | geçti | fixed |
  | geçmedi | geçmedi | still_failing |
  | geçti | geçti | stable |
  | sonuç yok | | new |

  Build, dosyanın SHA-256 değeri ile ayırt edilir; sürüm ve build numarası etiket olarak
  gösterilir. `test_compare` build'leri sütun, testleri satır olarak gösterir. Web arayüzündeki
  "Testler ve regresyon" paneli de aynı bilgiyi gösterir.

## İstemciye bağlı kısıtlar

- **Model video görmez.** MCP'de video içerik tipi yok. Ajan yalnızca araçların döndürdüğü
  durağan görüntüleri görür. Animasyon ve geçici hatalar için `device_capture_frames` saniye
  etiketli bir kontak sayfası döndürür. `device_recent_frames` yakın geçmişi yaklaşık 30 sn'lik
  canlı tampondan verir. Canlı MJPEG yayını ve MP4 kayıtları **yalnızca insan içindir**. Web
  arayüzü "Canlı yayın" ile "Ajanın gördükleri" panellerini bu yüzden ayrı gösterir; ikinci panel
  modele gerçekten gönderilen her görüntüyü listeler.
- **Görüntü maliyeti:** 576×1280 bir ekran yaklaşık 966 token tutar (`⌈w/28⌉·⌈h/28⌉`). Claude
  Code'da bir MCP sonucu varsayılan olarak 25k token ile sınırlıdır (`MAX_MCP_OUTPUT_TOKENS`).
  Eylemlerde `observe: "none" | "tree"` ile görüntü almadan devam edilebilir.
- **Zaman aşımı:** Claude Code'un HTTP MCP istekleri varsayılan olarak 60 sn'de kesilir; stdio'da
  istek başına sınır yoktur. Bu yüzden her araç 55 sn'nin altında kalır. Oturum açılışı (GitHub'da
  3–8 dk) asenkron ilerler ve `session_status` ile takip edilir. Claude Desktop'ın sınırları
  belgelenmemiştir.
- **Sunucu yönergeleri** 4096 karakter sınırının altındadır. Prompt'lar Claude Code'da slash
  komutu olarak görünür.
- **claude.ai web bağlayıcıları** localhost'a erişemez; MCP bilerek dışarı açılmaz.
- **Koordinatlar görüntüden tahmin edilir.** Küçük hedeflerde element ref'leri, `annotate` ve
  `device_zoom` ızgarası kullanılmalıdır.

## Güvenlik

- **Runner kimliği:** GitHub OIDC tokenı GitHub JWKS'e göre doğrulanır (imza, issuer, audience
  `tapscout-v2`, süre). Ayrıca repo, `device-session.yml@refs/heads/main` ve `workflow_dispatch`
  koşulları aranır. Bir oturuma bağlanan ilk run'dan farklı bir run reddedilir. Yerel runner tek
  kullanımlık rastgele token kullanır.
- **Oturum tokenı:** Hub her runner'a kendi imzaladığı bir oturum tokenı verir (HS256, sır
  `.data/hub-secret` içinde). Yeniden bağlanma, build indirme ve kanıt yükleme yalnızca bu tokenla
  yapılır.
- **Dış erişim:** Tünel yalnızca ağ geçidi portunu (`/healthz`, `/runner/*`) açar. Web arayüzü,
  API ve MCP `127.0.0.1` üzerindedir ve Host/Origin denetimiyle DNS rebinding'e karşı korunur.
- **Herkese açık repo:** Workflow logları herkese açıktır. Runner ekran içeriği, yazılan metin veya
  token yazmaz. Hub'ın tünel adresi her job'ın ilk adımında maskelenir; loglarda `***` olarak
  görünür. Build ve kanıtlar GitHub'a yüklenmez; artifact yükleme isteğe bağlıdır
  (`upload_artifacts`).

## Bağlantı ve temizlik

- Runner kopunca tekrar bağlanır (üstel bekleme; tolerans varsayılan 10 dk). Bu sürede komutlar
  "disconnected" hatası döner. Hub sessiz bir bağlantıyı 45 sn içinde düşürür.
- Boştaki oturum 20 dk sonra durur (`TAPSCOUT_IDLE_MINUTES`). Her oturumun bir azami süresi de
  vardır.
- `session_stop` önce runner'dan logları ve varsa kaydı yüklemesini ister, Appium'u kapatır ve job
  kendiliğinden biter. Bitmeyen GitHub run'ı iptal edilir. Hub yeniden başlarsa yarım kalan
  oturumlar bir süre beklenir; runner dönmezse oturum kapatılır ve run iptal edilir.
- Appium oturumu çökerse runner, uygulama verisini koruyarak yeni bir oturum açar ve komutu yeniden
  dener.

### Komut zaman aşımları

Appium komutları iptal edilemez: süresi dolan bir HTTP isteği cihazda çalışmaya devam edebilir.
Runner bu yüzden komutları tek bir kuyrukta sırayla çalıştırır ve her komutun gerçek durumunu
izler:

- Süresi dolan komut henüz başlamamışsa iptal edilir ve hiç çalışmaz. Başlamışsa hata "hâlâ
  çalışıyor olabilir" der.
- Komut sürerken gelen yeni Appium komutları `device_busy` hatası alır; önceki komut sonradan
  biten işin üzerine yazmaz. Ekran görüntüsü, log, çökme ve performans okumaları Appium'u
  beklemez (adb veya `simctl`).
- Komut daha sonra biterse ajana bir sonraki araç sonucunda "geç bitti" notu gider. Ekran
  değişmiş olabileceği için ajan tekrar bakar.
- 30 sn içinde bitmeyen komut takılmış sayılır. Runner Appium oturumunu siler, Android'de
  UiAutomator2 sunucusunu durdurur ve uygulamaya ve verisine dokunmadan yeni bir oturum açar (en
  fazla 3 deneme). Uygulama aynı ekranda kalır. Terk edilen komutun kurtarma denemesi yeni oturumu
  bozmaz.

Tanı için: `TAPSCOUT_TIMEOUT_FACTOR` (hub) komut sürelerini çarpar (örneğin 0.1 ile zaman
aşımları kolayca denenir); `TAPSCOUT_STUCK_AFTER_MS` yerel runner'ın "takıldı" eşiğini
değiştirir.

## Platform notları

- **Build kurulumu:** Verilen build her oturumda kurulur; cihazda aynı veya daha yeni sürüm
  numaralı bir uygulama olsa da (`enforceAppInstall`). Appium normalde aynı sürümü atlar. Yeniden
  kullanılan bir emülatörde bu, yeni build yerine eskisinin test edilmesine yol açıyordu.
  Takılan bir oturumun yerine açılan oturum ise uygulamayı yeniden kurmaz ve durdurmaz.
- **Cihaz ortamı (`device_environment`):** Her ayar ayrı uygulanır ve sonucu ayrı bildirilir.

  | Ayar | Android | iOS Simulator |
  |---|---|---|
  | Koyu mod | `cmd uimode night` | `simctl ui appearance` |
  | Dil (yalnızca uygulama) | `cmd locale set-app-locales` (Android 13+) | uygulama `-AppleLanguages` / `-AppleLocale` ile yeniden açılır |
  | Yazı boyutu | `font_scale` 0,85–2,0 | uygulama en yakın içerik boyutu kategorisiyle (`-UIPreferredContentSizeCategoryName`) yeniden açılır |
  | Konum | `emu geo fix` | `simctl location set` |
  | İnternetsiz | uçak modu | yok: Simulator Mac'in ağını kullanır |
  | Push | yok: FCM uygulamanın sunucusundan gelir | `simctl push` |
  | Biyometrik | `enroll` PIN (1234) atar ve kayıt ekranını açar; `match` ve `no_match` sensöre dokunur | `enrollBiometric`, `sendBiometricMatch` |
  | Medya | `/sdcard/Pictures` veya `Movies` + medya taraması | `simctl addmedia` |

  GitHub'daki iOS Simulator'da tek bir ayar 5–20 sn sürebilir. Bu yüzden ayarlar tek tek
  uygulanır; bir çağrının 60 sn sınırı içinde kalmayacak olanlar "henüz uygulanmadı" diye
  listelenir ve ajan onları tekrar gönderir. Dil ya da yazı boyutunu yalnızca açılışta okuyan
  uygulamalar için `restart_app: true` verilir.
  Değiştirilen ayarlar oturum durumunda ve raporda görünür. Yerel emülatörde ayarlar oturum
  bitince kalır; geri almak için aynı araç kullanılır. Android'de `enroll` ile atanan PIN de
  kalır.

- **Kare yakalama:** Android'de `screenrecord`, iOS'ta `simctl io recordVideo` videosu ffmpeg
  (`ffmpeg-static`) ile karelere ayrılır. Kare sırası ve aralıkları kesindir. Eyleme göre konum
  yaklaşık ±0,5 sn sapabilir; araç eylemin ne zaman bittiğini de bildirir. Video yoksa iOS'ta WDA
  MJPEG akışı, Android'de ekran görüntüsü yoklaması kullanılır.
- **iOS'ta yazma:** XCTest klavyede olmayan karakterlerde ("ş", emoji) takılır. Bu yüzden ASCII
  dışı metin panoya konup ⌘V ile yapıştırılır. Her yazmadan sonra alanın değeri okunur. Klavye
  açılırken kaybolan harfler bir kez daha yazılır. Hiçbir şey yapıştırmayan ⌘V tekrarlanır, sonra
  düzenleme menüsü denenir. Metin yine gelmezse araç hata döner. Alan beklenmeyen bir değer
  gösteriyorsa (maske, şifre alanı, uzunluk sınırı) metin ikinci kez yazılmaz.
- **iOS'ta klavyeyi kapatma:** Genel bir yöntem yok. Tek satırlı alanda klavyenin done, go veya
  return tuşuna, o da olmazsa Return'e basılır. Çok satırlı alanda hiçbir tuşa basılmaz: bu
  tuşların hepsi klavyenin Return tuşudur ve metne satır sonu ekler (doğrulamada kaydedilen bir
  "hakkında" metninin sonuna böyle `\n` eklenmişti). Klavye açık kalırsa araç bunu nedeniyle
  söyler; uygulamada başka hiçbir yere dokunulmaz. Tekrarlanan bir testte hedef klavyenin
  altında kalırsa TapScout klavyeye basmak yerine adımı hata olarak bitirir.
- **iOS logları:** Uygulamanın kendi kayıtları her düzeyde gelir; Apple çerçevelerinden yalnızca
  error/fault kayıtları alınır. XCTest'in erişilebilirlik sorguları süzülür.

## Sınırlar

- iOS yalnızca **iOS Simulator**'da çalışır (`xcodebuild -sdk iphonesimulator` ile üretilmiş
  `.app`'in zip'i). Yerel iOS için macOS gerekir.
- Android emülatörü x86_64'tür. arm64 APK'lar çeviriyle çalışır; yalnızca 32 bit APK'lar çalışmaz.
- Quick tunnel adresi hub her yeniden başladığında değişir. Sabit adres için
  `TAPSCOUT_PUBLIC_URL` kullanılır.
- Android `screenrecord` en fazla 180 sn kaydeder.

## Doğrulama durumu

- **Yerel Android (Windows, Android 16 emülatörü), FieldNotes `seeded` build'i:** Runner AVD'yi
  boot etti, Appium'u `.tools/`'tan başlattı ve build'i kurdu. MCP araçlarının hepsi gerçek
  cihazda çalıştırıldı: dokunma (ref, id ve text), Türkçe ve emoji ile yazma, klavye, kaydırma,
  sürükleme, uzun basma, pinch, döndürme, arka plan, `app_restart`, bir dokunmanın etrafında
  kare yakalama (geçiş animasyonu görüldü), canlı tampon, MP4 kayıt, loglar, çökme sorgusu, kanıt
  ve bulgu, rapor, durdurma. Kapanışta loglar yüklendi ve Appium kapandı. Ajan döngüsüyle
  planlanmış "profil düzenlemesi yeniden başlatınca kayboluyor" hatası yeniden üretildi.
- **GitHub Actions Android (Android 15 emülatörü, ubuntu-24.04):** Hub cloudflared quick
  tunnel'ı açtı ve workflow'u tetikledi; GitHub adımları oturum durumunda takip edildi. Runner
  OIDC ile bağlandı, 41 MB'lık build'i 18 sn'de indirdi; oturum açılıştan yaklaşık 5 dk sonra
  hazırdı. Ekran, yazma, kare yakalama, canlı tampon, loglar, kanıt ve bulgu çalıştı. Planlanmış
  "klavye Continue'yu kapatıyor" hatası görüldü. Appium bir kez "socket hang up" ile düştü;
  runner uygulama verisini koruyarak oturumu yeniden açtı. `session_stop` sonrası loglar geldi ve
  job **success** ile bitti. Public job logunda yazılan metin veya token yok. (Tünel adresi o
  sırada adım başlıklarında görünüyordu; artık maskeleniyor, aşağıya bakın.)
- **GitHub Actions iOS (iPhone 17, iOS 26.5 Simulator, macos-26):** Runner bağlandı ve 11 MB'lık
  build'i indirdi. XCUITest/WDA ile oturum açılışı yaklaşık 9 dk sürdü. Ekran, UI ağacı (klavye
  altında kalan Continue `UNDER-KEYBOARD` olarak işaretlendi), Türkçe ve emoji yazma (yapıştırma
  ile), klavyeyi kapatma, `simctl` videosuyla kare yakalama (iOS itme animasyonu kare kare
  görüldü), MP4 kayıt, loglar, çökme sorgusu, `app_restart`, canlı tampon ve durdurma çalıştı.
  Job **success** ile bitti. Doğrulama sırasında bulunup düzeltilenler: bundle id'nin
  Info.plist'ten okunması, ASCII dışı yazma, klavye kapatma, `simctl list` bayrak sırası, ilk UI
  ağacı okumasının ısıtılması, kayıt başlangıcının beklenmesi, XCTest log gürültüsü.
- **`device_environment`:** Yerel Android 16 emülatöründe tüm ayarlar tek çağrıda yaklaşık
  6 sn'de uygulandı. Koyu mod ve büyük yazı ekranda görüldü; uygulamaya özel dil, konum, uçak modu,
  galeriye fotoğraf ve parmak izi kaydı ekranı çalıştı, push gerekçesiyle reddedildi. GitHub iOS
  26.5 Simulator'da koyu mod, yazı boyutu (launch argümanı), konum, push, galeri, dil ve Face ID
  kaydı/eşleşmesi çalıştı; internetsiz mod gerekçesiyle reddedildi. Tüm ayarlar bir arada 49 sn'de
  döndü; sığmayan iki ayar listelendi ve ikinci çağrıda uygulandı. Job **success** ile bitti.
  Doğrulamada iki uygulama kusuru görüldü: koyu modda başlık çubuğu beyaz kalıyor ve iOS'ta durum
  çubuğu yazıları okunmuyor. Hub tarafındaki bir koordinat hatası da düzeltildi: görünüm alanı
  pencere boyutundan güncelleniyordu.
- **Son tur (aynı kodla iki platform):** Android ve iOS oturumları paralel açıldı. Kare
  yakalamada ilk görünür değişiklik her iki platformda da eylemden sonra geldi; iki job da
  **success** ile bitti.
- **Görsel kalite, performans, testler ve zaman aşımları** (yerel Android 16 emülatörü ve GitHub
  iOS 26.5 Simulator, FieldNotes `fixed` ve `seeded`):
  - *Regresyon:* Ajan "profil hakkında metni yeniden başlatınca korunur" akışını (14 adım, Türkçe
    metinle) Android'de kaydetti. Test `fixed` build'de geçti (`new`), `seeded` build'de 13. adımda
    "No bio yet." ile kaldı ve **REGRESSION** olarak işaretlendi. Kanıt ekranı hatayı
    gösteriyordu. Aynı test hiç değiştirilmeden iOS'ta da çalıştı: `fixed` geçti, `seeded`
    REGRESSION. Bir `test_run` çağrısı Android (yerel) ve iOS (GitHub) oturumlarını paralel
    çalıştırdı; Android sonucu önceki seeded sonucuna göre `fixed` sınıfını aldı. `test_compare`
    iki platformu ayrı tablolarda gösterdi. Bir test Android'de yaklaşık 32 sn, iOS'ta 150–170
    sn sürdü.
  - *Görsel denetim:* Android'de ve iOS'ta açık ve koyu modda çalıştı (1–3 sn). iOS koyu modda
    okunaklı gri bir metin 1.0:1 kontrastla işaretlenmişti; kontrast hesabı düzeltildi. Aynı
    ekran görüntüsü artık 7.3:1 veriyor. Koyu modda beyaz kalan başlık çubuğu ve görünmeyen durum
    çubuğu simgeleri görüntüde açıkça görülüyor.
  - *Performans:* Android'de soğuk açılış (`am start -W`) yaklaşık 1,2 sn, bir dokunmanın ilk
    görünür etkisi 168 ms ve durulması 501 ms; gfxinfo jank oranı da raporlandı. iOS'ta
    `launchctl` ile bulunan süreç için CPU, RSS ve iş parçacıkları; dokunmanın ilk etkisi 525 ms,
    durulması 1425 ms, ~16 fps; soğuk açılış 5,2 sn. Bir de 8 sn'lik örnekleme yapıldı.
  - *Zaman aşımı:* Kısaltılmış sürelerle (`TAPSCOUT_TIMEOUT_FACTOR`) zaman aşımı, ardından
    `device_busy` ve "geç bitti" notu görüldü. Takılan komut Appium oturumunun değiştirilmesine
    yol açtı; uygulama yazılmış metniyle aynı ekranda kaldı.
  - *Herkese açık log:* Hub'ın tünel adresi workflow `env` değeri olarak her adım başlığında
    görünüyordu. Artık maskeleniyor: yeni bir GitHub Android run'ında logda adres yok
    (`HUB_URL: ***`), yazılan metin ve token da yok; job **success** ile bitti. Aynı test bu
    oturumda (Android 15, telefon profili) Appium oturumu bir kez yenilenmesine rağmen geçti.
  - *Doğrulamada bulunup düzeltilenler:* aynı sürüm numaralı build'in kurulmaması
    (`enforceAppInstall`); iOS'ta alan temizlendikten sonra ⌘V'nin hata vermeden hiçbir şey
    yapıştırmaması (artık alanın değeri kontrol ediliyor, gerekirse tekrar deneniyor); kontrast
    hesabı; Google sistem uygulamasının çökmesinin "no_crash" beklentisini bozması (artık yalnızca
    uygulamanın süreçleri sayılıyor); oturum değiştirilirken Appium'un uygulamayı durdurması.

## Geliştirme

```bash
pnpm check     # biome + tip denetimi + testler (shared, runner, hub; sahte runner ve MCP istemcisiyle uçtan uca)
```

Lisans: [Apache-2.0](LICENSE). Örnek uygulama şablonu © 650 Industries (Expo), MIT.
