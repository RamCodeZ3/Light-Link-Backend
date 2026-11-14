"""Normaliza productos entregados; no genera topografía ni efemérides."""
import argparse
import hashlib
import json
import math
from datetime import datetime
from pathlib import Path
import shutil
import struct

ROOT = Path(__file__).resolve().parents[1]


def load(path):
    return json.loads(path.read_text(), parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))


def numbers(values, count, low, high):
    if len(values) != count or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or not low <= v <= high for v in values):
        raise ValueError('Serie numérica inválida')
    return values


def prepare(source, output, assets):
    metadata = load(source / 'sites_metadata.json')
    targets = load(source / 'targets.json')['targets']
    products = []
    for site_id, target in targets.items():
        mask_path = source / 'horizon_masks' / f'{site_id}.json'
        eph_path = source / 'ephemeris' / f'{site_id}.json'
        mask, eph = load(mask_path), load(eph_path)
        meta, series = eph['meta'], eph['site']
        if mask['meta']['site_id'] != site_id or meta['site_id'] != site_id:
            raise ValueError('Identificador inconsistente')
        if mask['meta']['azimuth_frame'] != 'true_north' or meta['azimuth_frame'] != 'true_north':
            raise ValueError('Marco de azimut incompatible')
        for key, tolerance in [('observer_lat_deg', 1e-5), ('observer_lon_deg', 1e-5), ('observer_ground_z_m', 1e-3)]:
            if abs(meta[key] - mask['meta'][key]) > tolerance or abs(target[key] - mask['meta'][key]) > tolerance:
                raise ValueError(f'Observadores inconsistentes: {key}')
        times = meta['timestamps_utc']
        dates = [datetime.strptime(t, '%Y-%m-%dT%H:%M:%SZ') for t in times]
        if len(times) < 2 or len(times) != meta['num_steps'] or any((b-a).total_seconds() != 3600 for a,b in zip(dates, dates[1:])):
            raise ValueError('Cobertura temporal inválida')
        count = mask['meta']['num_bins']
        if not 360 <= count <= 3600 or abs(mask['meta']['azimuth_step_deg'] * count - 360) > 1e-8:
            raise ValueError('Máscara irregular')
        profiles = {height: numbers(p['horizon_deg'], count, -90, 90) for height,p in mask['profiles'].items()}
        for body in ['sun', 'earth']:
            numbers(series[f'{body}_az_deg'], len(times), 0, 360)
            numbers(series[f'{body}_el_deg'], len(times), -90, 90)
        terrain = metadata['sites'][site_id]
        png_path = source / terrain['heightmap_web_png']
        header = png_path.read_bytes()[:29]
        if header[:8] != b'\x89PNG\r\n\x1a\n' or header[24:26] != bytes([16, 0]) or png_path.stat().st_size > 1500000:
            raise ValueError('Heightmap inválido o demasiado grande')
        width,height = struct.unpack('>II', header[16:24])
        if width != terrain['web_px'] or height != width:
            raise ValueError('Dimensiones PNG inconsistentes')
        provenance = {'ephemeris': {k:v for k,v in meta.items() if k != 'timestamps_utc'}, 'horizon': mask['meta'], 'terrain': metadata['meta'], 'input_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [mask_path, eph_path, source/'targets.json', source/'sites_metadata.json', png_path]}}
        product = {'site_id':site_id, 'coordinates': {'latitude':target['observer_lat_deg'], 'longitude':target['observer_lon_deg']}, 'target':target, 'heightmap':terrain, 'heightmap_url':f'/assets/heightmaps/{png_path.name}', 'horizon_profiles':profiles, 'ephemeris_timeline':[{'timestamp_utc':t, **{body:{'azimuth_deg':series[f'{body}_az_deg'][i], 'elevation_deg':series[f'{body}_el_deg'][i]} for body in ['sun','earth']}} for i,t in enumerate(times)], 'provenance':provenance}
        products.append((product, png_path))
    output.mkdir(parents=True, exist_ok=True)
    assets.mkdir(parents=True, exist_ok=True)
    for product,png in products:
        (output / f"{product['site_id']}.json").write_text(json.dumps(product, ensure_ascii=False, allow_nan=False, separators=(',', ':'))+'\n')
        shutil.copyfile(png, assets/png.name)
    print(f'{len(products)} sitios validados y preparados')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT/'drive-download-20261114T150317Z-1-001/datos/fase1')
    args = parser.parse_args()
    prepare(args.source, ROOT/'data/sites', ROOT/'public/heightmaps')
