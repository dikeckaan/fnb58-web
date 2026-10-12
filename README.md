# FNB58 Tezgâh

FNIRSI FNB58 USB test cihazı için tarayıcıda çalışan ölçüm, kayıt ve analiz aracı.
Üreticinin yalnızca Windows'ta çalışan `UsbMeter` programının yerine geçer. Sürücü ya da
kurulum gerektirmez, macOS, Linux ve Windows'ta çalışır.

FNIRSI ile bağlantılı değildir.

## Çalıştırma

```sh
npm install
npm run dev        # http://localhost:5858
npm test           # 72 test
npm run build      # dist/ klasörüne statik site
```

Gerçek cihaz için Chrome, Edge ya da Opera gerekir, çünkü WebHID yalnızca bu tarayıcılarda
var. Safari ve Firefox'ta yalnızca simülatör çalışır. WebHID ayrıca güvenli bağlam ister:
`localhost` ya da HTTPS.

Cihazın **PC** yazan micro USB girişini bilgisayara takın, "Cihazı bağla" düğmesine basın
ve listeden FNB-58 girişini seçin. Tarayıcı izni hatırlar, sonraki açılışta kendiliğinden
bağlanır.

## Yayınlama

Site tamamen statiktir, sunucu tarafı yoktur.

**GitHub Pages.** `.github/workflows/pages.yml` hazır. Depoyu GitHub'a gönderin, depo
ayarlarında Pages kaynağını "GitHub Actions" yapın. `main` dalına her gönderimde testler
çalışır, site derlenir ve yayınlanır. Yollar göreli olduğu için alt klasörde de çalışır.

**Cloudflare Workers.** `wrangler.jsonc` hazır.

```sh
npx wrangler login
npm run deploy:cloudflare
```

`public/_headers` dosyası Cloudflare'de güvenlik başlıklarını ve önbellek sürelerini ayarlar.

## Özellikler

**Canlı.** Gerilim, akım, güç, D+, D− ve sıcaklık saniyede 100 örnekle izlenir. Her kanalın
sayısal göstergesi kendi iz şeridinin yanında durur. 10 saniyeden 1 saate kadar pencere,
sürükleyerek kaydırma, Ctrl ya da Cmd ile tekerlekle yakınlaştırma. İki ölçüm imleci
arasındaki süre, ortalamalar, kapasite ve enerji hesaplanır. Kapasite, enerji, ortalama ve
tepe güç, yük direnci, gerilim dalgalanması, şarj protokolü tahmini, alarmlar ve olay günlüğü.

**Analiz.** Mühendislik görünümü.

- Her kanal için ortalama, en az, en çok, tepeden tepeye, RMS, AC RMS, tepe faktörü, medyan,
  P1, P99 ve en büyük eğim.
- Hann pencereli FFT spektrumu, gürültü tabanı, gürültü yoğunluğu ve belirgin çizgiler.
- Histogram, standart sapma, gözlenen en küçük adım.
- V-I saçılımı ve en küçük kareler ile kaynak modeli: açık devre gerilimi, seri direnç, yük
  regülasyonu.
- Yük adımı tepkisi: ΔI, ΔV, geçici sapma, yerleşme süresi, çıkış direnci.
- Darbeli yükte görev oranı ve frekans, sıcaklık eğilimi.

**Laboratuvar.** Deneysel ölçümler ve tezgâh yardımcıları.

- Uyku profili ve pil ömrü: akım izini uyku tabanı ve uyanma olaylarına ayırır, uyanma başına
  yük ve enerjiyi, ortalama akımı ve seçilen pille tahmini ömrü verir.
- Şarj bitiş tahmini: sabit gerilim evresinde düşen akıma üstel eğri oturtur, zaman sabitini,
  kalan süreyi ve beklenen toplam kapasiteyi hesaplar.
- Çalışma noktası haritası: V-I düzleminde bekleme süresi yoğunluğu ve sabit güç eğrileri.
- Kaynak parmak izi: boşta gerilim, seri direnç, dalgalanma, dalgalanma çizgisi ve veri hattı
  seviyelerini kaydeder, sonraki ölçümlerle benzerlik puanı çıkarır.
- El sıkışma zaman çizelgesi ve VBUS geçişleri: yükselme süresi, değişim hızı, aşım.
- Allan sapması: en iyi ortalama alma süresi ve baskın gürültü türü.
- Betik konsolu: JavaScript ile ölçüm otomasyonu, denetimler, geçti ya da kaldı sonucu, CSV.
- Yüzen gösterge (diğer pencerelerin üstünde), sinyali tona çevirme, seviye değişimini sesli okuma.

**Kayıtlar.** Başlama akımı, bitirme akımı ve gecikme koşullarıyla kayıt. 100, 50, 10 ya da
1 örnek/sn. Kayıtlar tarayıcının yerel deposunda (IndexedDB) durur. Her kayıt için özet,
sabit akımın bittiği an, enerjinin %80'ine ulaşma süresi, hücre kapasitesi karşılığı. İki
kaydı üst üste karşılaştırma. CSV, JSON ve PNG dışa aktarma, CSV ve JSON içe aktarma.

**Tetikleme.** QC 2.0, QC 3.0, Huawei FCP, Huawei SCP ve Samsung AFC ile gerilim isteme,
bırakma ve adımlı plan. Planlar JSON olarak alınıp verilebilir.

**Araçlar.** Kablo direnci ölçümü, USB gerilim toleransı denetimi, enerjiden hücre
kapasitesine çevirici, enerji maliyeti, D+ ve D− imza tablosu.

**Diğer.** Simülatör (beş senaryo), Türkçe ve İngilizce, klavye kısayolları, çevrimdışı
çalışma, tanılama ekranı.

## Doğrulananlar ve doğrulanmayanlar

| Konu | Durum |
|---|---|
| Ölçüm okuma, CRC, zamanlama | Gerçek bir FNB58 üzerinde doğrulandı: 4,2 saniyede 106 paket, hepsinde CRC doğru, 100 örnek/sn. |
| Tarayıcıdaki WebHID bağlantısı | Aynı paketleri kullanır ama tarayıcının cihaz seçme penceresi otomatik sınanamadığı için elle denenmedi. |
| Tetikleme komutları | Üreticinin aracından çıkarıldı. Simülatörde çalışıyor. Gerçek bir şarj cihazıyla denenmedi. |
| Yazılım güncelleme | Bilinçli olarak eklenmedi. Yanlış bir bayt cihazı kullanılmaz hale getirir. |
| Cihaz belleğindeki kayıtları alma | Eklenmedi. İstek komutu bulundu ama aktarım el sıkışması doğrulanamadı. |
| Laboratuvar hesapları | Birim testleri ve simülatörle doğrulandı. Gerçek cihazda µA düzeyindeki doğruluk ölçülmedi. |
| Yüzen gösterge, ses ve sesli okuma | Kod yazıldı, otomatik tarayıcı sınamasında denenemedi (kullanıcı tıklaması ve ses çıkışı ister). |

Tetiklemeyi ilk kez denerken cihazın çıkışına hiçbir şey takmayın.

## Protokol

64 baytlık HID paketleri: `0xAA`, komut ya da tip baytı, en çok 61 bayt veri, sonda CRC-8
(polinom 0x39, başlangıç 0, ilk 63 bayt üzerinden).

| Yön | Bayt | Anlam |
|---|---|---|
| Gönder | `0x81`, `0x82`, `0x82` | Başlatma (FNB48 ve C1'de üçüncüsü `0x83`) |
| Gönder | `0x83` | Saniyede bir, akışı sürdürür |
| Gönder | `0x88` + protokol + mV (u16 LE) | Tetikle |
| Gönder | `0x89` | Tetiklemeyi bırak |
| Al | `0x03` | Cihaz bilgisi |
| Al | `0x04` | Ölçüm: 10 ms aralıklı 4 örnek, her biri 15 bayt |
| Al | `0x07`, `0x08` | Tetikleme onaylandı, onaylanmadı |

Örnek yapısı: gerilim u32 ÷ 100000 V, akım u32 ÷ 100000 A, D+ u16 ÷ 1000 V, D− u16 ÷ 1000 V,
işaret baytı (0 ise sıcaklık eksi), sıcaklık u16 ÷ 10 °C.

Okuma tarafı [baryluk/fnirsi-usb-power-data-logger](https://github.com/baryluk/fnirsi-usb-power-data-logger)
projesine dayanır. Tetikleme komutları ve gerilim tabloları `UsbMeter.exe` incelenerek
bulundu. Ayrıntılar: `docs/superpowers/specs/2026-10-12-fnb58-web-design.md`.

Cihaz 100 Hz örneklediği için 50 Hz üstü görülmez. Anahtarlamalı kaynakların kHz
düzeyindeki dalgalanması bu banda katlanır. Gerçek dalgalanma ölçümü için osiloskop gerekir.

## Kod yapısı

| Klasör | İçerik |
|---|---|
| `src/device` | Protokol, WebHID bağlantısı, simülatör, protokol tahmini |
| `src/core` | Örnek deposu, motor, sinyal analizi, laboratuvar hesapları, betik çalıştırıcı, kayıt deposu, dışa aktarma, adımlı plan |
| `src/plot` | Tuval üzerinde iz çizimi ve eksen ölçekleme |
| `src/components` | Ekranlar |
| `src/state` | Ayarlar, bağlantı, ses, yüzen gösterge, betik köprüsü |
