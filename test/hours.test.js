const { test } = require('node:test');
const assert = require('node:assert');
const { loadScripts } = require('./load');

const get = loadScripts(['js/hours.js']);
const isOpenNow = get('isOpenNow');
const openLabel = get('openLabel');

// Lokale tijd, zoals de app (getDay/getHours). 2 november 2026 is een maandag.
const at = (day, hh, mm = 0) => new Date(2026, 10, 2 + day, hh, mm);
const MA = 0, DI = 1, VR = 4, ZA = 5, ZO = 6;

test('geen data is onbekend, 24/7 is altijd open', () => {
  assert.strictEqual(isOpenNow(null, at(MA, 12)), null);
  assert.strictEqual(isOpenNow('', at(MA, 12)), null);
  assert.strictEqual(isOpenNow('24/7', at(ZO, 3)), true);
});

test('eenvoudige dagreeks met uren', () => {
  const oh = 'Mo-Fr 09:00-18:00';
  assert.strictEqual(isOpenNow(oh, at(MA, 10)), true);
  assert.strictEqual(isOpenNow(oh, at(MA, 8, 59)), false);
  assert.strictEqual(isOpenNow(oh, at(VR, 18)), false); // sluitminuut telt niet meer
});

test('een dag die in geen enkele regel staat is gesloten (OSM), niet onbekend', () => {
  assert.strictEqual(isOpenNow('Mo-Fr 09:00-18:00', at(ZA, 12)), false);
  assert.strictEqual(isOpenNow('Mo,We,Fr 10:00-14:00', at(DI, 12)), false);
});

test('regel zonder dagen geldt elke dag', () => {
  assert.strictEqual(isOpenNow('09:00-18:00', at(ZO, 12)), true);
  assert.strictEqual(isOpenNow('09:00-18:00', at(ZO, 20)), false);
});

test('meerdere tijdvakken op een dag (middagpauze)', () => {
  const oh = 'Mo-Fr 09:00-12:00,13:00-18:00';
  assert.strictEqual(isOpenNow(oh, at(MA, 10)), true);
  assert.strictEqual(isOpenNow(oh, at(MA, 12, 30)), false);
  assert.strictEqual(isOpenNow(oh, at(MA, 14)), true);
});

test('"off" sluit de dag, ook na een bredere regel', () => {
  const oh = 'Mo-Su 10:00-22:00; Mo off';
  assert.strictEqual(isOpenNow(oh, at(MA, 12)), false);
  assert.strictEqual(isOpenNow(oh, at(DI, 12)), true);
  assert.strictEqual(isOpenNow('Mo-Sa 10:00-22:00; Su closed', at(ZO, 12)), false);
});

test('latere regel wint voor dezelfde dag', () => {
  const oh = 'Mo-Su 10:00-22:00; Sa 12:00-23:00';
  assert.strictEqual(isOpenNow(oh, at(ZA, 11)), false);
  assert.strictEqual(isOpenNow(oh, at(ZA, 22, 30)), true);
  assert.strictEqual(isOpenNow(oh, at(VR, 11)), true);
});

test('nachtelijke uren lopen door na middernacht op de volgende dag', () => {
  const oh = 'Fr-Sa 22:00-02:00';
  assert.strictEqual(isOpenNow(oh, at(VR, 23)), true);
  assert.strictEqual(isOpenNow(oh, at(ZA, 1)), true);  // vrijdagnacht
  assert.strictEqual(isOpenNow(oh, at(ZO, 1)), true);  // zaterdagnacht
  assert.strictEqual(isOpenNow(oh, at(VR, 1)), false); // donderdagnacht: niet open
  assert.strictEqual(isOpenNow(oh, at(ZO, 3)), false);
});

test('regels gescheiden door een komma na een tijd (komt voor in de OSM-data)', () => {
  const oh = 'Mo-Th 16:00-01:00, Fr-Sa 15:00-02:00, Su 15:00-01:00';
  assert.strictEqual(isOpenNow(oh, at(ZA, 1)), true);   // vrijdagnacht
  assert.strictEqual(isOpenNow(oh, at(ZA, 16)), true);
  assert.strictEqual(isOpenNow(oh, at(ZO, 12)), false);
  assert.strictEqual(isOpenNow(oh, at(MA, 0, 30)), true); // zondagnacht
  assert.strictEqual(isOpenNow(oh, at(DI, 15)), false);
});

test('tot middernacht met 24:00', () => {
  assert.strictEqual(isOpenNow('Mo-Su 18:00-24:00', at(MA, 23, 30)), true);
  assert.strictEqual(isOpenNow('Mo-Su 18:00-24:00', at(MA, 17)), false);
});

test('feestdagregels worden overgeslagen', () => {
  assert.strictEqual(isOpenNow('PH off; Mo-Fr 09:00-17:00', at(MA, 10)), true);
});

test('niet begrepen formaten blijven onbekend', () => {
  assert.strictEqual(isOpenNow('sunrise-sunset', at(MA, 12)), null);
  assert.strictEqual(isOpenNow('Apr-Oct: Mo-Su 10:00-22:00', at(MA, 12)), null);
  assert.strictEqual(isOpenNow('by appointment', at(MA, 12)), null);
});

test('label in het Nederlands', () => {
  assert.match(openLabel(true, 'x'), /Nu open/);
  assert.match(openLabel(false, 'x'), /Nu gesloten/);
  assert.match(openLabel(null, 'x'), /Openingsuren onbekend/);
  assert.match(openLabel(null, null), /Geen openingsuren/);
});
