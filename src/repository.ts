import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Site, InputError } from './domain.js';
export async function loadSites(directory = resolve('data/sites')) {
  const sites = new Map<string, Site>();
  for (const file of (await readdir(directory)).filter((f) => f.endsWith('.json')).sort()) {
    const site = JSON.parse(await readFile(resolve(directory, file), 'utf8')) as Site;
    if (
      !site.site_id ||
      sites.has(site.site_id) ||
      !site.ephemeris_timeline?.length ||
      !site.horizon_profiles?.['2']
    )
      throw new Error(`Producto inválido: ${file}. Ejecuta data:prepare`);
    sites.set(site.site_id, site);
  }
  if (!sites.size) throw new Error('No hay sitios preparados');
  return {
    list: () => [...sites.values()],
    get: (id: string) => {
      const site = sites.get(id);
      if (!site) throw new InputError('Sitio desconocido', 404);
      return site;
    },
  };
}
