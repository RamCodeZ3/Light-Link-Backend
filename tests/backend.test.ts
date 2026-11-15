import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { horizonAt, conditions, analyse, type Site } from '../src/domain.js';
import { loadSites } from '../src/repository.js';
test('interpolación circular e igualdad estricta', () => {
  const profile = Array(360).fill(0);
  profile[359] = 2;
  assert.equal(horizonAt(profile, 359.5), 1);
  assert.equal(horizonAt(profile, -0.5), 1);
  assert.equal(horizonAt(profile, 360), 0);
  const c = conditions(profile, {
    timestamp_utc: '',
    sun: { azimuth_deg: 359, elevation_deg: 2 },
    earth: { azimuth_deg: 0, elevation_deg: 1 },
  });
  assert.deepEqual(c, { sun_visible: false, earth_visible: true, co_visibility: false });
});
test('ventanas continuas, cortas y truncadas', () => {
  const site = {
    site_id: 'synthetic',
    horizon_profiles: { '2': Array(360).fill(0) },
    ephemeris_timeline: [1, -1, 1, 1].map((v, i) => ({
      timestamp_utc: `2026-11-01T0${i}:00:00Z`,
      sun: { azimuth_deg: 0, elevation_deg: v },
      earth: { azimuth_deg: 90, elevation_deg: 1 },
    })),
  } as unknown as Site;
  const result = analyse(site);
  const windows = result.windows.filter((w) => w.condition === 'sun_visible');
  assert.deepEqual(
    windows.map((w) => w.duration_hours),
    [1, 1],
  );
  assert.equal(windows[0].truncated_start, true);
  assert.equal(windows[1].truncated_end, true);
  site.ephemeris_timeline.forEach((s) => (s.sun.elevation_deg = -1));
  assert.equal(analyse(site).windows.filter((w) => w.condition === 'co_visibility').length, 0);
  assert.throws(() => analyse(site, { start_utc: '2026-02-30T00:00:00Z' }));
});
test('todos los sitios y perfiles producen booleanos coherentes', async () => {
  const repo = await loadSites();
  assert.equal(repo.list().length, 7);
  for (const site of repo.list())
    for (const height of [2, 5]) {
      const result = analyse(site, { observer_height_m: height });
      assert.equal(result.horizon_mask.length, 3600);
      assert.equal(result.ephemeris_timeline.length, 1464);
      for (const row of result.ephemeris_timeline)
        assert.equal(
          row.conditions.co_visibility,
          row.conditions.sun_visible && row.conditions.earth_visible,
        );
    }
});
test('API: análisis, validaciones, PNG y exportaciones', async () => {
  const app = await buildApp();
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    const sites = (await app.inject('/sites')).json();
    for (const site of sites) {
      const response = await app.inject(`/sites/${site.site_id}`);
      assert.equal(response.statusCode, 200);
      const result = response.json();
      assert.equal(result.ephemeris_timeline.length, 1464);
      const png = await app.inject(result.heightmap_url);
      assert.equal(png.statusCode, 200);
      assert.equal(png.rawPayload[24], 16);
    }
    for (const url of ['/sites/missing', '/assets/heightmaps/no.png'])
      assert.equal((await app.inject(url)).statusCode, 404);
    for (const url of [
      '/sites/Site01?observer_height_m=10',
      '/sites/Site01?step_hours=0',
      '/sites/Site01?unknown=1',
    ])
      assert.equal((await app.inject(url)).statusCode, 400);
    assert.equal(
      (await app.inject('/sites/Site01?start_utc=2027-01-01T00:00:00Z')).statusCode,
      422,
    );
    const post = await app.inject({
      method: 'POST',
      url: '/analyses',
      payload: { site_id: 'Site01', observer_height_m: 5, step_hours: 24 },
    });
    assert.equal(post.statusCode, 200);
    const csv = await app.inject('/sites/Site01/export?format=csv');
    assert.equal(csv.statusCode, 200);
    assert.match(csv.body, /condition,start_utc/);
  } finally {
    await app.close();
  }
});
