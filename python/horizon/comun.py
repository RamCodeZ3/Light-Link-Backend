#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
comun.py
================
Utilidades compartidas por las tres tareas de la Fase 1 (T1 heightmaps,
T2 mascaras de horizonte, T3 efemerides).

Contiene:

* la configuracion unica (``config.yaml``) y su hash;
* la geometria de la estereografica polar sur y la convergencia de cuadricula;
* la marcha sobre geodesicas y la elevacion angular exacta;
* la interpolacion circular de las mascaras de horizonte;
* el escritor de JSON compacto.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

# --------------------------------------------------------------------------
# Constantes fisicas
# --------------------------------------------------------------------------
MOON_RADIUS_M = 1_737_400.0
MOON_RADIUS_KM = 1_737.4
AU_KM = 149_597_870.700
C_KM_S = 299_792.458

SCHEMA_VERSION = 2

#: Marco de referencia lunar (IAU).  Horizons lo usa para ``SITE_COORD``:
#: ``Center pole/equ : MEAN_ME (high precision) {East-longitude positive}``.
LUNAR_FRAME = "MEAN_ME"

#: Convencion de azimut compartida por T2 y T3.
AZIMUTH_CONVENTION = ("0=N, 90=E, 180=S, 270=W (sentido horario visto "
                       "desde arriba)")


# --------------------------------------------------------------------------
# Configuracion
# --------------------------------------------------------------------------
def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    """Carga ``config.yaml``.  Si no se pasa ruta, busca ``config.yaml`` junto
    al directorio de este modulo."""
    import yaml

    if path is None:
        path = RAIZ / "config.yaml"
    path = Path(path).expanduser().resolve()
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    cfg["_config_path"] = str(path)
    return cfg


def config_hash(cfg: Dict[str, Any]) -> str:
    """SHA-256 de la configuracion efectiva (sin la ruta interna)."""
    clean = {k: v for k, v in cfg.items() if not k.startswith("_")}
    blob = json.dumps(clean, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def sha256_file(path: Path) -> str:
    """SHA-256 del contenido de un archivo."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# Geometria: estereografica polar sur
# --------------------------------------------------------------------------
def polar_stereographic_to_latlon(x: np.ndarray | float,
                                  y: np.ndarray | float,
                                  lon_0_deg: float = 0.0,
                                  radius_m: float = MOON_RADIUS_M
                                  ) -> Tuple[np.ndarray, np.ndarray]:
    """Estereografica polar sur (k0 = 1) -> (lat, lon) selenograficas.

    rho = 2 R tan(45 + lat/2) ;  x = rho sin(lon - lon_0) ; y = rho cos(lon - lon_0)
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    rho = np.hypot(x, y)
    lat = np.degrees(2.0 * np.arctan(rho / (2.0 * radius_m))) - 90.0
    lon = np.degrees(np.arctan2(x, y)) + lon_0_deg
    return lat, lon


def latlon_to_polar_stereographic(lat: np.ndarray | float,
                                  lon: np.ndarray | float,
                                  lon_0_deg: float = 0.0,
                                  radius_m: float = MOON_RADIUS_M
                                  ) -> Tuple[np.ndarray, np.ndarray]:
    """(lat, lon) selenograficas -> (x, y) en la estereografica polar sur."""
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    rho = 2.0 * radius_m * np.tan(np.radians(45.0 + lat / 2.0))
    dl = np.radians(lon - lon_0_deg)
    return rho * np.sin(dl), rho * np.cos(dl)


def grid_convergence_deg(lon_site_deg: float, lon_0_deg: float = 0.0) -> float:
    """Convergencia de la cuadrica: gamma = lambda_sitio - lambda_0.

    En la estereografica polar sur el norte de cuadricula ( +Y ) apunta al
    meridiano ``lon_0``, mientras que el norte real de un sitio de longitud
    ``lambda`` apunta radialmente hacia fuera, es decir a ``lambda - lon_0``
    grados de azimut de cuadricula.  Por tanto::

        azimut_real = azimut_cuadricula - gamma

    y para muestrear la LUT en azimut real ``alfa`` hay que trazar el rayo en
    azimut de cuadricula ``alfa + gamma``.
    """
    return float(lon_site_deg) - float(lon_0_deg)


# --------------------------------------------------------------------------
# Geodesicas sobre la esfera lunar
# --------------------------------------------------------------------------
def geodesic_destination(lat0_deg: float, lon0_deg: float,
                         az_deg: np.ndarray | float,
                         dist_m: np.ndarray | float,
                         radius_m: float = MOON_RADIUS_M
                         ) -> Tuple[np.ndarray, np.ndarray]:
    """Destino de un punto a distancia geodesica ``dist_m`` y azimut real.

    Azimut 0 = Norte, 90 = Este (sentido horario).  Vectorizado.
    """
    f1 = np.radians(lat0_deg)
    l1 = np.radians(lon0_deg)
    th = np.radians(az_deg)
    dl = np.asarray(dist_m, dtype=np.float64) / radius_m

    sin_f2 = (np.sin(f1) * np.cos(dl)
              + np.cos(f1) * np.sin(dl) * np.cos(th))
    f2 = np.arcsin(np.clip(sin_f2, -1.0, 1.0))
    l2 = l1 + np.arctan2(np.sin(th) * np.sin(dl) * np.cos(f1),
                         np.cos(dl) - np.sin(f1) * sin_f2)
    return np.degrees(f2), np.degrees(l2)


def exact_elevation_deg(z_target_m: float | np.ndarray,
                         z_obs_m: float,
                         dist_m: float | np.ndarray,
                         radius_m: float = MOON_RADIUS_M
                         ) -> np.ndarray:
    """Elevacion angular EXACTA de un punto respecto al horizonte local.

    Sustituye a la aproximacion ``d^2 / 2R`` del modelo plano:

        g = s / R ;  r1 = R + z_objetivo ;  r0 = R + z_observador
        elev = atan2(r1 cos(g) - r0, r1 sin(g))

    A diferencia de la aproximacion, esta formula tiene en cuenta que el
    punto objetivo esta a una distancia geocentrica distinta de la del
    observador, y es exacta para cualquier distancia.
    """
    s = np.asarray(dist_m, dtype=np.float64)
    g = s / radius_m
    r1 = radius_m + np.asarray(z_target_m, dtype=np.float64)
    r0 = radius_m + z_obs_m
    return np.degrees(np.arctan2(r1 * np.cos(g) - r0, r1 * np.sin(g)))


# --------------------------------------------------------------------------
# Azimut y mascaras de horizonte
# --------------------------------------------------------------------------
def normalize_azimuth(az: np.ndarray) -> np.ndarray:
    """Fuerza el azimut al rango [0, 360)."""
    out = np.mod(np.asarray(az, dtype=np.float64), 360.0)
    out[out >= 360.0] = 0.0
    return out


def horizon_interp(az: np.ndarray, profile: np.ndarray,
                   step_deg: float) -> np.ndarray:
    """Perfil de horizonte interpolado linealmente (circular).

    ``profile[i]`` es el horizonte en ``i * step_deg``.  El LOOKUP es O(1).
    """
    pos = normalize_azimuth(az) / step_deg
    base = np.floor(pos)
    i0 = base.astype(np.int64) % len(profile)
    i1 = (i0 + 1) % len(profile)
    frac = pos - base
    return profile[i0] * (1.0 - frac) + profile[i1] * frac


def horizon_binned(az: np.ndarray, profile: np.ndarray,
                   step_deg: float) -> np.ndarray:
    """Perfil de horizonte por bin mas cercano (consulta conservadora)."""
    idx = np.round(normalize_azimuth(az) / step_deg).astype(np.int64) \
        % len(profile)
    return profile[idx]


def circular_mean_deg(values: Iterable[float]) -> float:
    """Media circular de un conjunto de angulos en grados."""
    arr = np.asarray(list(values), dtype=np.float64)
    if arr.size == 0:
        return float("nan")
    rad = np.radians(arr)
    return float(math.degrees(math.atan2(np.sin(rad).sum(),
                                         np.cos(rad).sum())) % 360.0)


def circular_diff_deg(a: float, b: float) -> float:
    """Diferencia angular con signo en el rango (-180, 180]."""
    return float((a - b + 180.0) % 360.0 - 180.0)


# --------------------------------------------------------------------------
# Escritor de JSON compacto
# --------------------------------------------------------------------------
def write_json_compact(doc: Dict[str, Any], path: Path,
                        indent: int = 2) -> int:
    """Escribe JSON legible pero compacto.

    Los arrays de escalares (float / int / str) de mas de 8 elementos se
    renderizan en una sola linea.  Devuelve el numero de bytes escritos.
    """
    payload = copy.deepcopy(doc)
    tokens: Dict[str, str] = {}

    def walk(node: Any, prefix: str) -> None:
        if isinstance(node, dict):
            for key, value in list(node.items()):
                if (isinstance(value, list) and len(value) > 8
                        and all(isinstance(x, (int, float, str))
                                and not isinstance(x, bool) for x in value)):
                    token = f"__C_{prefix}_{key}__"
                    if all(isinstance(x, float) for x in value):
                        tokens[token] = ("[" + ",".join(f"{x:.4f}" for x in value)
                                         + "]")
                    elif all(isinstance(x, int) for x in value):
                        tokens[token] = "[" + ",".join(str(x) for x in value) + "]"
                    else:
                        tokens[token] = ("[" + ",".join(
                            json.dumps(x, ensure_ascii=False) for x in value)
                            + "]")
                    node[key] = token
                else:
                    walk(value, f"{prefix}_{key}")

    walk(payload, "root")
    text = json.dumps(payload, indent=indent, ensure_ascii=False)
    for token, value in tokens.items():
        text = text.replace(f'"{token}"', value)
    path = Path(path)
    path.write_text(text, encoding="utf-8")
    return path.stat().st_size


# --------------------------------------------------------------------------
# Misc
# --------------------------------------------------------------------------
def iso_utc(dt) -> str:
    """datetime -> 'YYYY-MM-DDTHH:MM:SSZ' (UTC)."""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_step(step: str) -> Tuple[int, str]:
    """'1h' -> (3600, 'h').  Acepta m / h / d."""
    import re

    m = re.fullmatch(r"\s*(\d+)\s*([mhd])\s*", str(step))
    if not m:
        raise ValueError(f"paso invalido: {step!r} (se espera p. ej. '1h')")
    mult = {"m": 60, "h": 3600, "d": 86400}[m.group(2)]
    return int(m.group(1)) * mult, m.group(2)


def step_to_hours(step: str) -> float:
    seconds, _ = parse_step(step)
    return seconds / 3600.0


def disk_fraction(margin_deg: np.ndarray,
                  radius_deg: float | np.ndarray) -> np.ndarray:
    """Fraccion visible de un disco con su centro a ``margin`` grados sobre un
    horizonte localmente recto.

        f(0) = 0.5,  f(radio) = 1,  f(-radio) = 0

    Es la fraccion del area del disco por encima de la recta del horizonte.

    ``radius_deg`` puede ser un escalar o un vector (por ejemplo, el radio
    angular del Sol en cada paso de tiempo); en ese caso se hace broadcast.
    Un radio nulo se trata como un punto: fraction 1 si el centro esta
    sobre el horizonte, 0 si esta debajo.
    """
    margin = np.asarray(margin_deg, dtype=np.float64)
    r = np.asarray(radius_deg, dtype=np.float64)
    if r.ndim == 0:
        r = np.full(margin.shape, float(r), dtype=np.float64)
    positive = r > 0.0
    safe_r = np.where(positive, r, 1.0)
    x = np.clip(-margin / safe_r, -1.0, 1.0)
    f = (np.arccos(x) - x * np.sqrt(1.0 - x * x)) / np.pi
    return np.where(positive, f, np.where(margin >= 0.0, 1.0, 0.0))


# --------------------------------------------------------------------------
# Rutas del proyecto (un solo lugar; el resto de scripts las importa)
# --------------------------------------------------------------------------
#: raiz del repositorio (este modulo vive en <raiz>/fase1/)
RAIZ = Path(__file__).resolve().parents[1]
#: insumos crudos: no se modifican nunca
DIR_CRUDOS = RAIZ / "datos" / "crudos"
DIR_CRUDOS_SITIOS = DIR_CRUDOS / "lola_sitios_5m"      # GeoTIFF LOLA 5 m/px
DIR_CRUDOS_CGI = DIR_CRUDOS / "cgi_moon_kit"           # NASA SVS 4720
#: productos intermedios (derivados de los crudos, entrada de T2)
DIR_DEM_REGIONAL = RAIZ / "datos" / "intermedios" / "dem_regional"
#: salidas de la Fase 1 = entrada de la Fase 2
DIR_FASE1 = RAIZ / "datos" / "fase1"


def ruta_del_proyecto(valor) -> Path:
    """Ruta relativa a la raiz del proyecto (o absoluta, sin cambios)."""
    p = Path(valor).expanduser()
    return p if p.is_absolute() else RAIZ / p
