export interface Body {
  azimuth_deg: number;
  elevation_deg: number;
}
export interface Sample {
  timestamp_utc: string;
  sun: Body;
  earth: Body;
}
export interface Site {
  site_id: string;
  coordinates: { latitude: number; longitude: number };
  target: Record<string, unknown>;
  heightmap: Record<string, unknown>;
  heightmap_url: string;
  horizon_profiles: Record<string, number[]>;
  ephemeris_timeline: Sample[];
  provenance: Record<string, unknown>;
}
export class InputError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export function horizonAt(profile: number[], azimuth: number): number {
  const pos = ((((azimuth % 360) + 360) % 360) * profile.length) / 360;
  const i = Math.floor(pos),
    f = pos - i;
  return profile[i] * (1 - f) + profile[(i + 1) % profile.length] * f;
}
export function conditions(profile: number[], sample: Sample) {
  const sun_visible = sample.sun.elevation_deg > horizonAt(profile, sample.sun.azimuth_deg);
  const earth_visible = sample.earth.elevation_deg > horizonAt(profile, sample.earth.azimuth_deg);
  return { sun_visible, earth_visible, co_visibility: sun_visible && earth_visible };
}
export interface Options {
  observer_height_m?: number;
  start_utc?: string;
  end_utc?: string;
  step_hours?: number;
}
export function analyse(site: Site, options: Options = {}) {
  const height = options.observer_height_m ?? 2;
  const profile = site.horizon_profiles[String(height)];
  if (!profile)
    throw new InputError(
      `Altura no disponible. Perfiles: ${Object.keys(site.horizon_profiles).join(', ')} m`,
      422,
    );
  const all = site.ephemeris_timeline;
  function boundary(value: string | undefined, fallback: string) {
    const t = value ?? fallback;
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t) ||
      !Number.isFinite(Date.parse(t)) ||
      new Date(t).toISOString().replace('.000Z', 'Z') !== t
    )
      throw new InputError('Fecha UTC inválida');
    const index = all.findIndex((s) => s.timestamp_utc === t);
    if (index < 0) throw new InputError('Fecha fuera de cobertura o sin muestra horaria', 422);
    return index;
  }
  const start = boundary(options.start_utc, all[0].timestamp_utc),
    end = boundary(options.end_utc, all.at(-1)!.timestamp_utc);
  const step = options.step_hours ?? 1;
  if (!Number.isInteger(step) || step < 1 || step > 24 || start >= end)
    throw new InputError('Rango inválido o paso fuera de 1–24 horas');
  // Ventanas calculadas con todas las muestras horarias; el paso solo reduce la respuesta.
  const hourly = all
    .slice(start, end + 1)
    .map((s) => ({ ...s, conditions: conditions(profile, s) }));
  const windows: {
    condition: string;
    start_utc: string;
    end_utc: string;
    duration_hours: number;
    truncated_start: boolean;
    truncated_end: boolean;
  }[] = [];
  for (const key of ['sun_visible', 'earth_visible', 'co_visibility'] as const) {
    let opened: number | undefined;
    for (let i = 0; i < hourly.length; i++) {
      if (hourly[i].conditions[key] && opened === undefined) opened = i;
      if (opened !== undefined && (!hourly[i].conditions[key] || i === hourly.length - 1)) {
        windows.push({
          condition: key,
          start_utc: hourly[opened].timestamp_utc,
          end_utc: hourly[i].timestamp_utc,
          duration_hours: i - opened,
          truncated_start: opened === 0,
          truncated_end: i === hourly.length - 1 && hourly[i].conditions[key],
        });
        opened = undefined;
      }
    }
  }
  return {
    site_id: site.site_id,
    coordinates: site.coordinates,
    target: site.target,
    heightmap: site.heightmap,
    heightmap_url: site.heightmap_url,
    observer_height_m: height,
    horizon_mask: profile.map((v, i) => ({
      azimuth_deg: (i * 360) / profile.length,
      max_elevation_deg: v,
    })),
    ephemeris_timeline: hourly.filter((_, i) => i % step === 0),
    windows,
    metrics: Object.fromEntries(
      ['sun_visible', 'earth_visible', 'co_visibility'].map((key) => [
        `${key}_sample_fraction`,
        hourly.filter((s) => s.conditions[key as keyof typeof s.conditions]).length / hourly.length,
      ]),
    ),
    resolution: {
      horizon_step_deg: 360 / profile.length,
      source_step_hours: 1,
      response_step_hours: step,
      start_utc: hourly[0].timestamp_utc,
      end_utc: hourly.at(-1)!.timestamp_utc,
      window_method: 'sample_hold_until_next_hour; clipped at range end; no crossing refinement',
      visibility_rule: 'body center elevation > circular linear horizon; equality is false',
      height_method:
        height === (site.target?.observer_height_m ?? 2)
          ? 'native ephemeris observer height'
          : 'precomputed horizon; ephemeris angles reused from 2 m (approximation)',
    },
    provenance: site.provenance,
  };
}
