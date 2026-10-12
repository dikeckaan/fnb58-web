// Starter scripts for the automation console, with comments in both languages.

import type { Lang } from './state/settings';

export interface ScriptExample {
  id: string;
  title: Record<Lang, string>;
  code: Record<Lang, string>;
}

export const SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    id: 'level',
    title: { tr: 'Gerilim seviyesi ve dalgalanma kontrolü', en: 'Voltage level and ripple check' },
    code: {
      tr: `// 2 saniyenin ortalamasını al, en yakın USB seviyesine göre değerlendir.
const m = await mean(2);
const levels = [5, 9, 12, 15, 20];
const target = levels.reduce((a, b) => Math.abs(b - m.v) < Math.abs(a - m.v) ? b : a);

log('VBUS', m.v, 'V,', m.i, 'A,', m.p, 'W');
near(m.v, target, target * 0.05, 'Seviye ±%5 içinde');
check(m.vpp < 0.15, 'Tepeden tepeye dalgalanma 150 mV altında: ' + (m.vpp * 1000).toFixed(1) + ' mV');
check(m.temp < 60, 'Sıcaklık 60 °C altında');`,
      en: `// Average two seconds and judge against the nearest USB level.
const m = await mean(2);
const levels = [5, 9, 12, 15, 20];
const target = levels.reduce((a, b) => Math.abs(b - m.v) < Math.abs(a - m.v) ? b : a);

log('VBUS', m.v, 'V,', m.i, 'A,', m.p, 'W');
near(m.v, target, target * 0.05, 'Level within ±5 %');
check(m.vpp < 0.15, 'Peak-to-peak ripple under 150 mV: ' + (m.vpp * 1000).toFixed(1) + ' mV');
check(m.temp < 60, 'Temperature under 60 °C');`,
    },
  },
  {
    id: 'sweep',
    title: { tr: 'QC 2.0 gerilim taraması', en: 'QC 2.0 voltage sweep' },
    code: {
      tr: `// Şarj cihazından sırayla 5, 9 ve 12 V ister, her seviyeyi ölçer.
// Önce Tetikleme sayfasındaki uyarıyı onaylamış olmanız gerekir.
row('İstenen V', 'Ölçülen V', 'Hata %', 'Dalgalanma mV', 'Akım A');
for (const volts of [5, 9, 12]) {
  const ok = await trigger('qc2', volts);
  if (!check(ok, volts + ' V isteği kabul edildi')) continue;
  await waitFor((r) => Math.abs(r.v - volts) < volts * 0.08, 3);
  await sleep(0.5);
  const m = await mean(1);
  row(volts, m.v.toFixed(3), ((m.v / volts - 1) * 100).toFixed(2), (m.vpp * 1000).toFixed(1), m.i.toFixed(3));
  near(m.v, volts, volts * 0.05, volts + ' V seviyesi');
}
await release();
log('Tetikleme bırakıldı.');`,
      en: `// Asks the charger for 5, 9 and 12 V in turn and measures each level.
// You must have accepted the warning on the Trigger page first.
row('Requested V', 'Measured V', 'Error %', 'Ripple mV', 'Current A');
for (const volts of [5, 9, 12]) {
  const ok = await trigger('qc2', volts);
  if (!check(ok, volts + ' V request accepted')) continue;
  await waitFor((r) => Math.abs(r.v - volts) < volts * 0.08, 3);
  await sleep(0.5);
  const m = await mean(1);
  row(volts, m.v.toFixed(3), ((m.v / volts - 1) * 100).toFixed(2), (m.vpp * 1000).toFixed(1), m.i.toFixed(3));
  near(m.v, volts, volts * 0.05, volts + ' V level');
}
await release();
log('Trigger released.');`,
    },
  },
  {
    id: 'rout',
    title: { tr: 'Yük değişiminden çıkış direnci', en: 'Output resistance from a load change' },
    code: {
      tr: `// İlk noktayı ölçer, yükü değiştirmenizi bekler, sonra R = -ΔV / ΔI hesaplar.
const a = await mean(1);
log('1. nokta:', a.v, 'V,', a.i, 'A. Şimdi yükü en az 200 mA değiştirin (30 sn).');
const changed = await waitFor((r) => Math.abs(r.i - a.i) > 0.2, 30);
if (check(changed, 'Yük değişti')) {
  await sleep(1);
  const b = await mean(1);
  const r = -(b.v - a.v) / (b.i - a.i);
  log('2. nokta:', b.v, 'V,', b.i, 'A');
  log('Kaynak ve kablo direnci:', (r * 1000).toFixed(1), 'mΩ');
  check(r > 0 && r < 0.3, 'Direnç 300 mΩ altında');
}`,
      en: `// Measures one point, waits for you to change the load, then computes R = -ΔV / ΔI.
const a = await mean(1);
log('Point 1:', a.v, 'V,', a.i, 'A. Now change the load by at least 200 mA (30 s).');
const changed = await waitFor((r) => Math.abs(r.i - a.i) > 0.2, 30);
if (check(changed, 'Load changed')) {
  await sleep(1);
  const b = await mean(1);
  const r = -(b.v - a.v) / (b.i - a.i);
  log('Point 2:', b.v, 'V,', b.i, 'A');
  log('Source plus cable resistance:', (r * 1000).toFixed(1), 'mΩ');
  check(r > 0 && r < 0.3, 'Resistance under 300 mΩ');
}`,
    },
  },
  {
    id: 'sleep',
    title: { tr: 'Uyku akımı kabul testi', en: 'Sleep current acceptance test' },
    code: {
      tr: `// 20 saniyelik ortalama akımı sınırla karşılaştırır.
const limitMa = 5;
reset();
const m = await mean(20);
const c = counters();
log('Ortalama:', (m.i * 1000).toFixed(3), 'mA, tepe aralığı:', (m.ipp * 1000).toFixed(2), 'mA');
log('Toplanan yük:', (c.ah * 1e6).toFixed(1), 'µAh');
check(m.i * 1000 < limitMa, 'Ortalama akım ' + limitMa + ' mA altında');`,
      en: `// Compares the 20 second mean current with a limit.
const limitMa = 5;
reset();
const m = await mean(20);
const c = counters();
log('Mean:', (m.i * 1000).toFixed(3), 'mA, span:', (m.ipp * 1000).toFixed(2), 'mA');
log('Charge collected:', (c.ah * 1e6).toFixed(1), 'µAh');
check(m.i * 1000 < limitMa, 'Mean current under ' + limitMa + ' mA');`,
    },
  },
  {
    id: 'soak',
    title: { tr: 'Bir dakikalık dayanıklılık kaydı', en: 'One minute soak log' },
    code: {
      tr: `// Her 5 saniyede bir satır yazar ve gerilimin bandın içinde kaldığını denetler.
const first = await mean(1);
row('t (sn)', 'V', 'A', 'W', '°C');
for (let k = 0; k < 12; k++) {
  const m = await mean(5);
  row((k + 1) * 5, m.v.toFixed(4), m.i.toFixed(4), m.p.toFixed(3), m.temp.toFixed(1));
  near(m.v, first.v, first.v * 0.03, (k + 1) * 5 + '. saniye');
}`,
      en: `// Writes a row every 5 seconds and checks that the voltage stays in band.
const first = await mean(1);
row('t (s)', 'V', 'A', 'W', '°C');
for (let k = 0; k < 12; k++) {
  const m = await mean(5);
  row((k + 1) * 5, m.v.toFixed(4), m.i.toFixed(4), m.p.toFixed(3), m.temp.toFixed(1));
  near(m.v, first.v, first.v * 0.03, 'second ' + (k + 1) * 5);
}`,
    },
  },
];
