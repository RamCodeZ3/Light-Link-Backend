"""Generación bajo demanda: LOLA local + NASA/JPL Horizons. JSON por stdin/stdout."""
import base64
import calendar
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent / 'horizon'))
VERSION = 'automatic-sites-v1'
HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api'
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / 'drive-download-20261114T150317Z-1-001/datos'


class AnalysisError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def utc_date(value):
    try:
        parsed = datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        raise AnalysisError('Fecha UTC inválida', 400)
    if parsed.strftime('%Y-%m-%dT%H:%M:%SZ') != value or parsed.minute or parsed.second:
        raise AnalysisError('Las fechas deben estar alineadas a horas UTC', 400)
    return parsed


def parse_horizons(document, lat, lon, altitude_km, start, end):
    """Rechaza respuestas de otro cuerpo, marco, observador o cobertura."""
    text = document.get('result', '')
    if document.get('error') or '$$SOE' not in text or '$$EOE' not in text:
        raise AnalysisError('Horizons no devolvió una tabla de efemérides válida', 502)
    head = text.split('$$SOE')[0]
    if not re.search(r'Center body name\s*:\s*Moon\s*\(301\)', head) or not re.search(r'Center pole/equ\s*:\s*MEAN_ME', head):
        raise AnalysisError('Horizons respondió con cuerpo o marco incompatible', 502)
    radii = re.search(r'Center radii\s*:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)', head)
    observer = re.search(r'Center geodetic\s*:\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)', head)
    if not radii or any(abs(float(r)-1737.4) > 0.01 for r in radii.groups()) or not observer:
        raise AnalysisError('No se pudo verificar el observador lunar de Horizons', 502)
    returned_lon, returned_lat, returned_alt = map(float, observer.groups())
    if abs((returned_lon-lon+180) % 360-180) > 1e-5 or abs(returned_lat-lat) > 1e-5 or abs(returned_alt-altitude_km) > 0.00002:
        raise AnalysisError('Horizons respondió para otras coordenadas o altura', 502)
    rows = []
    for fields in csv.reader(text.split('$$SOE')[1].split('$$EOE')[0].strip().splitlines()):
        if len(fields) != 6:
            raise AnalysisError('Columnas de Horizons inesperadas', 502)
        try:
            match = re.fullmatch(r'\s*(\d{4})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2})\s*', fields[0])
            if not match:
                raise ValueError('fecha')
            year, month, day, hour, minute = match.groups()
            dt = datetime(int(year), list(calendar.month_abbr).index(month), int(day), int(hour), int(minute), tzinfo=timezone.utc)
            az, el = float(fields[3]), float(fields[4])
            if not math.isfinite(az) or not math.isfinite(el) or not 0 <= az <= 360 or not -90 <= el <= 90:
                raise ValueError('ángulos')
        except (ValueError, IndexError):
            raise AnalysisError('Valores inválidos en Horizons', 502)
        rows.append({'timestamp_utc': dt.strftime('%Y-%m-%dT%H:%M:%SZ'), 'azimuth_deg': az % 360, 'elevation_deg': el})
    expected = [start + timedelta(hours=i) for i in range(int((end-start).total_seconds()/3600)+1)]
    if [r['timestamp_utc'] for r in rows] != [t.strftime('%Y-%m-%dT%H:%M:%SZ') for t in expected]:
        raise AnalysisError('Cobertura horaria incompleta en Horizons', 502)
    return rows


def fetch_horizons(command, lat, lon, altitude_km, start, end):
    params = {'format': 'json', 'COMMAND': f"'{command}'", 'CENTER': "'coord@301'", 'COORD_TYPE': "'GEODETIC'", 'SITE_COORD': f"'{lon:.9f},{lat:.9f},{altitude_km:.9f}'", 'MAKE_EPHEM': "'YES'", 'OBJ_DATA': "'NO'", 'EPHEM_TYPE': "'OBSERVER'", 'START_TIME': f"'{start:%Y-%m-%d %H:%M}'", 'STOP_TIME': f"'{end:%Y-%m-%d %H:%M}'", 'STEP_SIZE': "'1h'", 'QUANTITIES': "'4'", 'CSV_FORMAT': "'YES'", 'TIME_TYPE': "'UT'", 'TIME_DIGITS': "'MINUTES'", 'APPARENT': "'AIRLESS'", 'ANG_FORMAT': "'DEG'"}
    raw = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(HORIZONS_URL+'?'+urllib.parse.urlencode(params), timeout=25) as response:
                raw = response.read(3_000_001)
            if len(raw) > 3_000_000:
                raise AnalysisError('Respuesta Horizons demasiado grande', 502)
            document = json.loads(raw)
            break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt:
                raise AnalysisError('NASA/JPL Horizons no está disponible; reintenta el análisis', 502)
            time.sleep(0.5)
    rows = parse_horizons(document, lat, lon, altitude_km, start, end)
    return rows, {'source_url': HORIZONS_URL, 'parameters': params, 'signature': document.get('signature'), 'response_sha256': hashlib.sha256(raw).hexdigest(), 'retrieved_at_utc': datetime.now(timezone.utc).isoformat()}


def terrain(lat, lon, height, dem_dir, regional_path):
    import numpy as np
    import rasterio
    from rasterio.windows import Window
    from PIL import Image
    from comun import latlon_to_polar_stereographic, sha256_file
    from t2_mascaras_horizonte import DemRaster, near_horizon
    from capa_lejana import RegionalDEM, far_horizon_profile

    if lat == -90 or lat == 90:
        raise AnalysisError('El azimut local en el polo exacto necesita una convención adicional; elige un punto fuera del polo')
    if not dem_dir.is_dir() or not regional_path.is_file():
        raise AnalysisError('Faltan los GeoTIFF LOLA o el DEM regional; configura LOLA_DEM_DIR y LOLA_REGIONAL_DEM', 503)
    selected = None
    x = y = None
    for path in sorted(dem_dir.glob('*_final_adj_5mpp_surf.tif')):
        with rasterio.open(path) as ds:
            crs = ds.crs.to_dict() if ds.crs else {}
            if crs.get('units') != 'm' or crs.get('proj') != 'stere' or float(crs.get('lat_0', 0)) != -90 or abs(float(crs.get('R', crs.get('a', 0)))-1737400) > 0.01:
                raise AnalysisError('CRS del DEM local incompatible', 503)
            if ds.transform.b or ds.transform.d or float(crs.get('x_0', 0)) or float(crs.get('y_0', 0)) or float(crs.get('k', crs.get('k_0', 1))) != 1:
                raise AnalysisError('Transformación del DEM local incompatible', 503)
            px, py = latlon_to_polar_stereographic(lat, lon, float(crs.get('lon_0', 0)))
            px, py = float(px), float(py)
            if not ds.bounds.left+100 <= px <= ds.bounds.right-100 or not ds.bounds.bottom+100 <= py <= ds.bounds.top-100:
                continue
            row, col = ds.index(px, py)
            if not ds.read(1, window=Window(col, row, 1, 1), masked=True).mask.any():
                selected, x, y = path, px, py
                break
    if selected is None:
        raise AnalysisError('Coordenadas fuera de cobertura LOLA de alta resolución o demasiado cerca del borde; se necesitan al menos 100 m de margen')
    dem = DemRaster(selected)
    with rasterio.open(selected) as ds:
        valid = ~np.ma.getmaskarray(ds.read(1, masked=True))
    dem.z[~valid] = np.nan
    ground = float(dem.sample(np.array([x]), np.array([y]))[0])
    if not math.isfinite(ground):
        raise AnalysisError('No hay altura válida en las coordenadas solicitadas')
    az = np.arange(360, dtype=float)
    near = near_horizon(dem, lat, lon, ground, [height], az, 5, dem.max_corner_distance(x, y), refine_m=500, refine_step_m=1)[height]
    if not np.all(np.isfinite(near['horizon_deg'])) or np.min(near['s_reached_m']) < 95:
        raise AnalysisError('La máscara cercana contiene huecos o no cubre 100 m en todas las direcciones')
    with rasterio.open(regional_path) as ds:
        crs = ds.crs.to_dict() if ds.crs else {}
        if crs.get('units') != 'm' or crs.get('proj') != 'stere' or float(crs.get('lat_0', 0)) != -90 or abs(float(crs.get('R', crs.get('a', 0)))-1737400) > 0.01 or float(crs.get('lon_0', 0)) != dem.lon_0_deg or float(crs.get('x_0', 0)) or float(crs.get('y_0', 0)) or float(crs.get('k', crs.get('k_0', 1))) != 1:
            raise AnalysisError('CRS del DEM regional incompatible con el DEM local', 503)
    with RegionalDEM(regional_path) as regional:
        class CombinedTerrain:
            lon_0_deg = dem.lon_0_deg

            def sample(self, xs, ys):
                # El DEM grueso no sustituye la topografía cercana disponible.
                local = dem.sample(xs, ys)
                return np.where(np.isfinite(local), local, regional.sample(xs, ys))

        far, reached = far_horizon_profile(CombinedTerrain(), lat, lon, ground+height, az, 150000, 100)
        if not np.all(np.isfinite(far)) or np.min(reached) < 150000:
            raise AnalysisError('El DEM regional no cubre de forma continua 150 km en todas las direcciones')
    horizon = np.maximum(near['horizon_deg'], far)
    # Recorte cuadrado centrado en la coordenada exacta, sin mover el observador.
    left, top, right, bottom = dem.bounds()
    half = min(10000, x-left-5, right-x-5, y-bottom-5, top-y-5)
    px = 512
    axis = (np.arange(px)+0.5)*2*half/px
    xs, ys = np.meshgrid(x-half+axis, y+half-axis)
    z = dem.sample(xs.ravel(), ys.ravel()).reshape(px, px)
    if not np.isfinite(z).all():
        raise AnalysisError('No hay cobertura topográfica completa para el heightmap del sitio')
    low, high = float(z.min()), float(z.max())
    scale = (high-low)/65535 if high > low else 1.0
    pixels = np.rint((z-low)/scale).astype(np.uint16)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format='PNG', compress_level=9)
    png = buffer.getvalue()
    if len(png) > 1500000:
        raise AnalysisError('El heightmap generado supera el límite de tamaño', 503)
    return {'ground': ground, 'horizon': horizon.tolist(), 'png': png, 'heightmap': {'z_min_m': low, 'z_max_m': high, 'z_scale_m_per_dn': scale, 'value_encoding': 'uint16 grayscale; Z = z_min_m + dn * z_scale_m_per_dn', 'web_px': px, 'physical_size_m': 2*half, 'plane_size_m': 2*half*(px-1)/px, 'vertex_spacing_m': 2*half/px, 'center_x_m': x, 'center_y_m': y, 'center_lat': lat, 'center_lon': lon, 'grid_convergence_deg': lon-dem.lon_0_deg, 'three_axes': 'PNG fila 0 -> -Z; columna 0 -> -X; altura -> +Y', 'png_bytes': len(png)}, 'provenance': {'generator': VERSION, 'near': {'source_url': 'https://pgda.gsfc.nasa.gov/products/78', 'source_file': selected.name, 'sha256': sha256_file(selected), 'pixel_resolution_m': list(dem.res), 'minimum_reach_m': float(np.min(near['s_reached_m'])), 'distance_step_m': 5, 'distance_refine_m': 500, 'distance_refine_step_m': 1}, 'far': {'source_metadata': json.loads(regional_path.with_suffix('.json').read_text()) if regional_path.with_suffix('.json').is_file() else None, 'source_file': regional_path.name, 'sha256': sha256_file(regional_path), 'max_distance_m': 150000, 'distance_step_m': 100, 'minimum_reach_m': float(np.min(reached))}, 'azimuth_frame': 'true_north', 'horizon_step_deg': 1, 'elevation_model': 'spherical exact atan2; radius 1737400 m', 'limitations': ['Horizonte a 1 grado; pueden perderse picos estrechos.', 'Horizonte limitado a 150 km; convergencia a mayor distancia no evaluada.', 'Se prioriza DEM de 5 m donde existe; el DEM regional puede tener diferencias verticales en la transición.', 'Marco topográfico MOON_ME/DE421 y Horizons MEAN_ME usados con coordenadas compatibles según la entrega; transformación independiente pendiente.', 'Heightmap visual remuestreado; máscara calculada con GeoTIFF sin cuantizar.', 'No certifica seguridad de aterrizaje.']}}


def generate(request):
    lat, lon = request['coordinates']['latitude'], request['coordinates']['longitude']
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or not math.isfinite(lat) or not math.isfinite(lon) or not -90 <= lat <= 90 or not 0 <= lon < 360:
        raise AnalysisError('Coordenadas inválidas', 400)
    start, end = utc_date(request['start_utc']), utc_date(request['end_utc'])
    if not 0 < (end-start).total_seconds() <= 62*86400:
        raise AnalysisError('El rango debe ser positivo y de hasta 62 días', 400)
    height = request['observer_height_m']
    if height not in (2, 5):
        raise AnalysisError('Altura admitida: 2 o 5 m', 400)
    result = terrain(lat, lon, height, Path(os.environ.get('LOLA_DEM_DIR', DEFAULT_SOURCE/'crudos/lola_sitios_5m')), Path(os.environ.get('LOLA_REGIONAL_DEM', DEFAULT_SOURCE/'intermedios/dem_regional/ldem_64_sur_stereo_200m.tif')))
    sun, sun_meta = fetch_horizons('10', lat, lon, (result['ground']+height)/1000, start, end)
    time.sleep(0.5)  # Consultas secuenciales al proveedor.
    earth, earth_meta = fetch_horizons('399', lat, lon, (result['ground']+height)/1000, start, end)
    timeline = [{'timestamp_utc': s['timestamp_utc'], 'sun': {k:s[k] for k in ('azimuth_deg', 'elevation_deg')}, 'earth': {k:e[k] for k in ('azimuth_deg', 'elevation_deg')}} for s, e in zip(sun, earth)]
    site = {'site_id': request['site_id'], 'coordinates': request['coordinates'], 'target': {'source': 'user_coordinates; no automatic relocation', 'observer_lat_deg': lat, 'observer_lon_deg': lon, 'observer_ground_z_m': result['ground'], 'observer_height_m': height}, 'heightmap': result['heightmap'], 'heightmap_url': f"/sites/{request['site_id']}/heightmap", 'horizon_profiles': {str(height): result['horizon']}, 'ephemeris_timeline': timeline, 'provenance': {'terrain': result['provenance'], 'ephemeris': {'source': 'NASA/JPL Horizons API', 'requests': [sun_meta, earth_meta], 'reference_frame': 'MEAN_ME', 'timescale': 'UT (UTC for these modern dates)', 'elevation_convention': 'apparent airless; body center', 'observer_height_m': height}, 'generator': VERSION}}
    return {'site': site, 'heightmap_base64': base64.b64encode(result['png']).decode()}


if __name__ == '__main__':
    try:
        output = generate(json.load(sys.stdin))
    except AnalysisError as error:
        output = {'error': str(error), 'status': error.status}
    except ImportError:
        output = {'error': 'Dependencias Python ausentes; instala python/requirements.txt', 'status': 503}
    except Exception as error:
        print(type(error).__name__+': '+str(error), file=sys.stderr)
        output = {'error': 'No se pudo generar el análisis científico', 'status': 503}
    print(json.dumps(output, allow_nan=False, separators=(',', ':')))
