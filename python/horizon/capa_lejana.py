#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
capa_lejana.py
==================

Capa lejana del horizonte lunar (H2.2 de la auditoria tecnica).

Por que existe
--------------
Los DEM de LOLA de 5 m/px solo cubren 8-13 km alrededor de cada sitio.  El Sol
lunar esta entre -3.1 y +6.1 grados de elevacion, y un relieve situado a 100 km
puede taparlo (para E = 1.5 grados hacen falta ~2.6 km de desnivel mas ~2.9 km
de caida por curvatura).  Con solo la capa cercana la LUT H(phi) **subestima**
el horizonte y la iluminacion y el DTE quedan sobrestimados.

La capa lejana usa un DEM regional de decenas de m/px con cobertura >= 150-200 km
y corrige los dos errores de la aproximacion de la capa cercana:

1. **Geodesicas reales.**  La marcha no se hace en el plano del DEM sino sobre
   geodesicas de la esfera lunar (azimut real 0=N, 90=E).  Asi el horizonte se
   evalua en el sitio correcto del polo y desaparece el problema de convergencia
   de cuadricula.
2. **Elevacion angular EXACTA.**  Se usa la formula esferica exacta
   ``elev = atan2(r1 cos(s/R) - r0, r1 sin(s/R))`` en lugar de la aproximacion
   ``d^2 / (2R)``.  A 150 km la diferencia ya es de ~0.4 grados, del orden del
   propio rango de elevacion solar, asi que no es un detalle.

Modelo fisico
-------------
Para un punto del terreno a distancia geodesica ``s`` y altura ``z_obj``, y un
observador a altura ``z_obs`` sobre la esfera de radio ``R``::

    g  = s / R                       # angulo central
    r1 = R + z_obj                   # radio geocentrico del objetivo
    r0 = R + z_obs                   # radio geocentrico del observador
    elev = atan2(r1 cos g - r0, r1 sin g)

El termino ``r1 sin g`` es la componente horizontal real (no la distancia de
arco ``s``), y ``r1 cos g - r0`` la vertical.  Es exacta para cualquier
distancia, no solo para las cercanas donde ``s^2/2R`` es aceptable.

Regla de seguridad (conservadora)
---------------------------------
El recorrido de cada rayo se **interrumpe en el primer NaN**.  Un pico mas alla
de un hueco de datos no puede usarse como horizonte porque el terreno intermedio
se desconoce: ignorarlo seria optimisticamente peligroso (dejaria ver el Sol
detras de un macizo que en realidad existe).  Solo cuenta el tramo continuo
desde el observador, y ``s_alcanzado`` informa de hasta donde llego esa
cobertura.

Dependencias: numpy, rasterio (y pyproj solo si se quiere contrastar la
geometria).  Compatible con Python 3.11+.
"""

from __future__ import annotations

import math
import re
import sys
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np
import rasterio

# ``comun`` vive junto a este modulo.  Se intenta el import normal y,
# si el modulo se carga desde fuera (p. ej. importlib desde otro directorio), se
# anade el directorio del propio archivo al sys.path como red de seguridad.
try:  # pragma: no cover - ruta normal
    from comun import (
        MOON_RADIUS_M,
        exact_elevation_deg,
        geodesic_destination,
        latlon_to_polar_stereographic,
    )
except ImportError:  # pragma: no cover - ruta de rescate
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from comun import (
        MOON_RADIUS_M,
        exact_elevation_deg,
        geodesic_destination,
        latlon_to_polar_stereographic,
    )

__all__ = [
    "RegionalDEM",
    "VirtualMosaic",
    "far_horizon_profile",
    "MOON_RADIUS_M",
    "MAX_BLOCK_ELEMENTS",
]

#: Tope de elementos (azimutes x pasos) por bloque.  Por encima de esto se
#: trocea el calculo por bloques de azimut para acotar la memoria: 20 M de
#: float64 son ~160 MB por matriz temporal, mas los arrays auxiliares.
MAX_BLOCK_ELEMENTS: int = 20_000_000

#: CRS de referencia que se acepta: estereografica polar sur sobre la esfera
#: lunar.  Se usa como sanity check para no mezclar un DEM hemiferico norte.
_PROJ_RE = re.compile(r"\+proj=([a-z0-9_]+)")
_LON0_RE = re.compile(r"\+lon_0=([-+0-9.eE]+)")


# --------------------------------------------------------------------------
# Utilidades internas
# --------------------------------------------------------------------------
def _extract_lon0(crs) -> float:
    """Extrae el meridiano central (``lon_0``) de una CRS polar stereografica.

    Se intenta primero la cadena proj4 (rapida y estable) y, si no aparece,
    se buscan los parametros del ``coordinate_operation`` de pyproj
    (``central_meridian``).  Devuelve 0.0 si la CRS no declara meridiano
    central, que es el valor de la estereografica polar del proyecto.
    """
    proj4 = ""
    try:
        proj4 = crs.to_proj4()
    except Exception:  # pragma: no cover - defensivo
        proj4 = ""

    m = _LON0_RE.search(proj4)
    if m:
        return float(m.group(1))

    # Fallback: parametros de pyproj (central_meridian / lon_0).
    try:
        for p in crs.coordinate_operation.params:
            if "central_meridian" in p or p.startswith("+lon_0"):
                mm = re.search(r"([-+0-9.eE]+)\s*$", p)
                if mm:
                    return float(mm.group(1))
    except Exception:  # pragma: no cover - defensivo
        pass

    return 0.0


def _check_polar_south(crs, path: Path) -> None:
    """Verifica que la CRS sea estereografica polar sur sobre la esfera lunar.

    Es un control temprano: mezclar una DEM hemiferica norte o en lat/lon
    produciria horizontes silenciosamente equivocados, mucho mas dificil de
    detectar que un error de excepcion.
    """
    try:
        proj4 = crs.to_proj4()
    except Exception:  # pragma: no cover - defensivo
        proj4 = ""

    m = _PROJ_RE.search(proj4)
    if m and m.group(1) != "stere":
        raise ValueError(
            f"{path}: la CRS debe ser estereografica polar (+proj=stere); "
            f"se obtuvo +proj={m.group(1)}"
        )

    lat0 = re.search(r"\+lat_0=([-+0-9.eE]+)", proj4)
    lat_ts = re.search(r"\+lat_ts=([-+0-9.eE]+)", proj4)
    sur = False
    if lat0 and abs(float(lat0.group(1)) + 90.0) < 1e-6:
        sur = True
    if lat_ts and abs(float(lat_ts.group(1)) + 90.0) < 1e-6:
        sur = True
    if (lat0 or lat_ts) and not sur:
        raise ValueError(
            f"{path}: la CRS debe ser estereografica del polo SUR "
            f"(+lat_0=-90); se obtuvo '{proj4}'"
        )


def _affine_corners(transform, width: int, height: int) -> List[Tuple[float, float]]:
    """Esquinas del raster en coordenadas del mundo (orden: 0,0 / W,0 / 0,H / W,H)."""
    pts = []
    for col, row in ((0, 0), (width, 0), (0, height), (width, height)):
        x, y = transform * (col, row)
        pts.append((float(x), float(y)))
    return pts


# --------------------------------------------------------------------------
# RegionalDEM
# --------------------------------------------------------------------------
class RegionalDEM:
    """DEM regional en la estereografica polar sur.  Muestreo bilineal en metros.

    El DEM se lee en memoria como float32 de forma perezosa (solo al muestrear
    por primera vez) y se mantiene el dataset de rasterio abierto para no
    reabrirlo en cada llamada.

    Convencion de coordenadas: ``sample`` recibe coordenadas del mundo del
    DEM (metros, sistema estereografico polar sur con el meridiano central
    ``lon_0_deg``), no indices de pixel.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(self.path)

        self._ds = rasterio.open(self.path)
        if self._ds.crs is None:
            self._ds.close()
            raise ValueError(f"{self.path}: el GeoTIFF no declara CRS")

        _check_polar_south(self._ds.crs, self.path)

        self._lon0 = _extract_lon0(self._ds.crs)
        self._transform = self._ds.transform
        self._inv_transform = ~self._transform
        self._width = int(self._ds.width)
        self._height = int(self._ds.height)

        # Lado equivalente del pixel (area equivalente).  Para pixeles
        # cuadrados, como los de LOLA, coincide con la resolucion del lado.
        det = self._transform.a * self._transform.e - self._transform.b * self._transform.d
        self._pixel_size = float(math.sqrt(abs(det)))

        corners = _affine_corners(self._transform, self._width, self._height)
        xs = [c[0] for c in corners]
        ys = [c[1] for c in corners]
        self._xmin, self._xmax = float(min(xs)), float(max(xs))
        self._ymin, self._ymax = float(min(ys)), float(max(ys))

        # Raster completo en float32; se carga la primera vez que se muestrea.
        self._data: Optional[np.ndarray] = None

    # -- metadatos ---------------------------------------------------------
    @property
    def lon_0_deg(self) -> float:
        """Meridiano central de la estereografica polar sur del DEM (grados)."""
        return self._lon0

    @property
    def pixel_size_m(self) -> float:
        """Lado equivalente del pixel del DEM en metros."""
        return self._pixel_size

    @property
    def bounds(self) -> Tuple[float, float, float, float]:
        """Extension del DEM en metros: ``(x0, y0, x1, y1)``.

        ``x0``/``x1`` son las abscisas minima/maxima (oeste/este) e
        ``y0``/``y1`` las ordenadas minima/maxima (sur/norte) del raster.
        """
        return (self._xmin, self._ymin, self._xmax, self._ymax)

    @property
    def shape(self) -> Tuple[int, int]:
        """Dimensiones del raster en pixeles: ``(height, width)``."""
        return (self._height, self._width)

    # -- ciclo de vida -----------------------------------------------------
    def close(self) -> None:
        """Cierra el dataset de rasterio y libera la memoria del raster."""
        self._data = None
        if getattr(self, "_ds", None) is not None:
            try:
                self._ds.close()
            finally:
                self._ds = None  # type: ignore[assignment]

    def __enter__(self) -> "RegionalDEM":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __del__(self) -> None:  # pragma: no cover - best effort
        try:
            self.close()
        except Exception:
            pass

    def __repr__(self) -> str:  # pragma: no cover - conveniencia
        return (f"RegionalDEM({self.path.name!r}, {self._width}x{self._height}, "
                f"px={self._pixel_size:g} m, lon_0={self._lon0:g})")

    # -- muestreo ----------------------------------------------------------
    def _load(self) -> np.ndarray:
        """Carga (una sola vez) el raster completo como float32 con NaN en nodata."""
        if self._data is None:
            data = self._ds.read(1).astype(np.float32, copy=False)
            nodata = self._ds.nodata
            if nodata is not None:
                if isinstance(nodata, float) and math.isnan(nodata):
                    pass                      # ya es NaN
                else:
                    data[data == np.float32(nodata)] = np.nan
            self._data = data
        return self._data

    def contains(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Mascara booleana: True donde el punto cae dentro de los bounds del DEM.

        Se usa el borde exterior del raster (bordes de pixel), no el centro del
        primer/ultimo pixel, para no descartar una franja de medio pixel.
        """
        xs = np.asarray(xs, dtype=np.float64)
        ys = np.asarray(ys, dtype=np.float64)
        return ((xs >= self._xmin) & (xs <= self._xmax)
                & (ys >= self._ymin) & (ys <= self._ymax))

    def sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Elevacion en metros (float64).  NaN fuera de la cobertura o en nodata.

        Interpolacion **bilineal real**: se toman los cuatro pixeles vecinos
        del punto y se ponderan por su fraccion de posicion.  Un vecino con
        nodata (NaN) invalida el resultado *solo si su peso es distinto de
        cero* (si el punto cae justo en el centro de un pixel, el resto de
        vecinos pesa 0 y no deben invalidar nada).

        Fuera de los bounds se devuelve NaN.  En el borde exterior del raster
        los pesos se recortan a [0, 1] (equivalente a replicar el pixel del
        borde) para no extrapolar ni crear un anillo artificial de NaN.
        """
        xs = np.asarray(xs, dtype=np.float64).ravel()
        ys = np.asarray(ys, dtype=np.float64).ravel()
        if xs.shape != ys.shape:
            raise ValueError(
                f"xs y ys deben tener la misma forma: {xs.shape} != {ys.shape}")

        out = np.full(xs.shape, np.nan, dtype=np.float64)
        idx = np.nonzero(self.contains(xs, ys))[0]
        if idx.size == 0:
            return out

        data = self._load()

        # Coordenadas fraccionarias en la convencion "centro de pixel": el
        # centro del pixel (r, c) tiene coordenadas (r, c) exactas.
        # ~transform da la convencion de esquinas, de ahi el -0.5.
        col, row = self._inv_transform * (xs[idx], ys[idx])
        fc = np.asarray(col, dtype=np.float64) - 0.5
        fr = np.asarray(row, dtype=np.float64) - 0.5

        if self._width < 2 or self._height < 2:
            # Raster de 1 pixel: solo cabe muestreo por vecino mas proximo.
            c = np.clip(np.rint(fc), 0, self._width - 1).astype(np.int64)
            r = np.clip(np.rint(fr), 0, self._height - 1).astype(np.int64)
            out[idx] = data[r, c].astype(np.float64)
            return out

        c0 = np.clip(np.floor(fc).astype(np.int64), 0, self._width - 2)
        r0 = np.clip(np.floor(fr).astype(np.int64), 0, self._height - 2)
        fx = np.clip(fc - c0, 0.0, 1.0)
        fy = np.clip(fr - r0, 0.0, 1.0)

        z00 = data[r0, c0].astype(np.float64)
        z01 = data[r0, c0 + 1].astype(np.float64)
        z10 = data[r0 + 1, c0].astype(np.float64)
        z11 = data[r0 + 1, c0 + 1].astype(np.float64)

        w00 = (1.0 - fx) * (1.0 - fy)
        w01 = fx * (1.0 - fy)
        w10 = (1.0 - fx) * fy
        w11 = fx * fy

        val = w00 * z00 + w01 * z01 + w10 * z10 + w11 * z11

        # Un vecino NaN invalida el punto solo si pesa de verdad.
        bad = ((np.isnan(z00) & (w00 > 0.0))
               | (np.isnan(z01) & (w01 > 0.0))
               | (np.isnan(z10) & (w10 > 0.0))
               | (np.isnan(z11) & (w11 > 0.0)))
        val[bad] = np.nan

        out[idx] = val
        return out


# --------------------------------------------------------------------------
# VirtualMosaic
# --------------------------------------------------------------------------
class VirtualMosaic:
    """Mosaico virtual de varios GeoTIFF en la MISMA CRS (superpuestos y/o separados).

    No se materializa ningun archivo: las consultas se reparten entre los tiles
    segun sus bounds y se combinan tomando el **maximo** de elevacion.  El
    maximo es la escolha conservadora para un horizonte (si dos tiles se
    solapan y uno ve una cota mas alta, el terreno "real" no puede ser mas bajo
    que el maximo sin contradecir la medicion).
    """

    def __init__(self, paths: Sequence[Path]) -> None:
        self.paths: List[Path] = [Path(p) for p in paths]
        if not self.paths:
            raise ValueError("VirtualMosaic requiere al menos un GeoTIFF")

        self._dems: List[RegionalDEM] = [RegionalDEM(p) for p in self.paths]

        lon0s = {d.lon_0_deg for d in self._dems}
        if len(lon0s) > 1:
            for d in self._dems:
                d.close()
            raise ValueError(
                f"los tiles deben compartir la misma CRS: se encontraron "
                f"meridianos centrales {sorted(lon0s)}")

    # -- metadatos ---------------------------------------------------------
    @property
    def tiles(self) -> List[RegionalDEM]:
        """Lista de tiles que componen el mosaico."""
        return list(self._dems)

    @property
    def lon_0_deg(self) -> float:
        """Meridiano central comun a todos los tiles (grados)."""
        return self._dems[0].lon_0_deg

    @property
    def pixel_size_m(self) -> float:
        """Resolucion equivalente mas gruesa del mosaico (metros).

        Si todos los tiles tienen la misma resolucion (caso normal), es
        simplemente esa resolucion.  Si difieren, se toma el maximo porque es
        la que limita la confianza en el detalle.
        """
        return float(max(d.pixel_size_m for d in self._dems))

    @property
    def bounds(self) -> Tuple[float, float, float, float]:
        """Union de los bounds de los tiles: ``(x0, y0, x1, y1)``."""
        xs0 = min(d.bounds[0] for d in self._dems)
        ys0 = min(d.bounds[1] for d in self._dems)
        xs1 = max(d.bounds[2] for d in self._dems)
        ys1 = max(d.bounds[3] for d in self._dems)
        return (xs0, ys0, xs1, ys1)

    # -- ciclo de vida -----------------------------------------------------
    def close(self) -> None:
        """Cierra todos los tiles del mosaico."""
        for d in self._dems:
            d.close()

    def __enter__(self) -> "VirtualMosaic":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __repr__(self) -> str:  # pragma: no cover - conveniencia
        return f"VirtualMosaic({len(self._dems)} tiles)"

    # -- muestreo ----------------------------------------------------------
    def sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Elevacion en metros (float64).  NaN donde ningun tile cubre el punto.

        Si varios tiles se solapan, gana el de mayor elevacion (mas
        conservador).  Se vectoriza por tile: primero se calcula la mascara
        "dentro de este tile" y solo se muestrean esos puntos, de modo que un
        tile que no cubre la zona no aporta nada (ni tiempo ni memoria).
        """
        xs = np.asarray(xs, dtype=np.float64).ravel()
        ys = np.asarray(ys, dtype=np.float64).ravel()
        if xs.shape != ys.shape:
            raise ValueError(
                f"xs y ys deben tener la misma forma: {xs.shape} != {ys.shape}")

        out = np.full(xs.shape, np.nan, dtype=np.float64)
        for dem in self._dems:
            mask = dem.contains(xs, ys)
            if not mask.any():
                continue
            vals = dem.sample(xs[mask], ys[mask])
            # np.fmax ignora NaN: si un tile cubre el punto pero con nodata,
            # el valor de otro tile sigue siendo valido.
            out[mask] = np.fmax(out[mask], vals)
        return out


# --------------------------------------------------------------------------
# Perfil de horizonte de la capa lejana
# --------------------------------------------------------------------------
def far_horizon_profile(dem,
                         obs_lat_deg: float,
                         obs_lon_deg: float,
                         obs_z_m: float,
                         azimuths_deg: np.ndarray,
                         max_dist_m: float,
                         step_m: float,
                         radius_m: float = MOON_RADIUS_M
                         ) -> Tuple[np.ndarray, np.ndarray]:
    """Perfil de horizonte de la capa lejana.

    Devuelve (H_far, s_alcanzado):
      H_far[i]       = elevacion angular maxima (grados) en el azimut azimuths_deg[i]
      s_alcanzado[i] = distancia (m) hasta la que hay cobertura CONTINUA desde el
                       observador (0 si el primer paso ya es NaN)

    Reglas:
      - Se marcha sobre geodesicas reales (geodesic_destination) con azimut REAL.
      - La elevacion angular usa exact_elevation_deg (NO la aproximacion d^2/2R).
      - El recorrido se INTERRUMPE en el primer NaN: un pico mas alla de un hueco
        de datos no puede usarse como horizonte (el terreno intermedio se desconoce).
      - Solo cuenta el tramo continuo desde el observador.
      - Vectorizado: NO bucles python sobre azimutes ni sobre distancias.
      - Memoria acotada: si el numero de azimutes x pasos es grande (>20M), trocea
        por bloques de azimut y concatena.

    ``dem`` puede ser un :class:`RegionalDEM` o un :class:`VirtualMosaic` (lo
    unico que se exige es un metodo ``sample(xs, ys)`` y, si existe, la
    propiedad ``lon_0_deg``).

    Los pasos de distancia son ``step_m, 2*step_m, ...`` (el observador no se
    muestrea a si mismo).  ``H_far`` es NaN en los azimutes sin ninguna
    cobertura valida.
    """
    az = np.asarray(azimuths_deg, dtype=np.float64).ravel()
    n_az = int(az.size)

    H_far = np.full(n_az, np.nan, dtype=np.float64)
    s_alcanzado = np.zeros(n_az, dtype=np.float64)
    if n_az == 0:
        return H_far, s_alcanzado

    step = float(step_m)
    if not (step > 0.0) or not math.isfinite(step):
        raise ValueError(f"step_m debe ser positivo y finito; se obtuvo {step_m!r}")
    dist_max = float(max_dist_m)
    if not math.isfinite(dist_max) or dist_max <= 0.0:
        raise ValueError(f"max_dist_m debe ser positivo y finito; se obtuvo {max_dist_m!r}")

    n_steps = int(math.floor(dist_max / step))
    if n_steps <= 0:
        return H_far, s_alcanzado

    # Distancias de muestreo: el primer paso esta a step_m del observador.
    dists = (np.arange(n_steps, dtype=np.float64) + 1.0) * step

    # Meridiano central del DEM (0 para la estereografica polar del proyecto).
    lon0 = float(getattr(dem, "lon_0_deg", 0.0))

    # Troceado por bloques de azimut para acotar la memoria.
    block = max(1, min(n_az, int(math.ceil(MAX_BLOCK_ELEMENTS / n_steps))))

    cols = np.arange(n_steps, dtype=np.int64)

    for i0 in range(0, n_az, block):
        i1 = min(i0 + block, n_az)
        n_b = i1 - i0

        # (n_b, 1) x (n_steps,) -> (n_b, n_steps): marcha sobre geodesicas reales.
        lat, lon = geodesic_destination(obs_lat_deg, obs_lon_deg,
                                        az[i0:i1, None], dists,
                                        radius_m=radius_m)
        x, y = latlon_to_polar_stereographic(lat, lon, lon_0_deg=lon0,
                                             radius_m=radius_m)
        z = np.asarray(dem.sample(x.ravel(), y.ravel()),
                       dtype=np.float64).reshape(n_b, n_steps)

        elev = np.asarray(exact_elevation_deg(z, obs_z_m, dists,
                                               radius_m=radius_m),
                          dtype=np.float64)

        valid = np.isfinite(z) & np.isfinite(elev)

        # Primer NaN de cada rayo (n_steps si el rayo esta completo).
        complete = valid.all(axis=1)
        first_bad = np.where(complete, n_steps,
                             np.argmax(~valid, axis=1)).astype(np.int64)

        # Tramo continuo: columnas strictement anteriores al primer NaN.
        prefix = cols[None, :] < first_bad[:, None]
        elev_masked = np.where(prefix, elev, -np.inf)
        h = elev_masked.max(axis=1)
        h[first_bad == 0] = np.nan            # sin cobertura: sin horizonte

        H_far[i0:i1] = h
        s_alcanzado[i0:i1] = first_bad.astype(np.float64) * step

    return H_far, s_alcanzado


if __name__ == "__main__":  # pragma: no cover - comprobacion rapida
    import argparse

    ap = argparse.ArgumentParser(description="Perfil de horizonte de la capa lejana")
    ap.add_argument("dem", help="GeoTIFF regional (o 'mosaico:glob')")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--z", type=float, default=0.0)
    ap.add_argument("--max-dist", type=float, default=150000.0)
    ap.add_argument("--step", type=float, default=100.0)
    args = ap.parse_args()

    if args.dem.startswith("mosaico:"):
        import glob as _glob
        paths = [Path(p) for p in sorted(_glob.glob(args.dem[len("mosaico:"):]))]
        source = VirtualMosaic(paths)
    else:
        source = RegionalDEM(Path(args.dem))

    az = np.arange(0.0, 360.0, 0.5)
    H, s = far_horizon_profile(source, args.lat, args.lon, args.z,
                               az, args.max_dist, args.step)
    fin = np.isfinite(H)
    print(f"H_far: min={np.nanmin(H) if fin.any() else float('nan'):.4f} "
          f"max={np.nanmax(H) if fin.any() else float('nan'):.4f} "
          f"con cobertura {int(fin.sum())}/{H.size} azimutes")
    print(f"s_alcanzado: min={s.min():.0f} m  max={s.max():.0f} m  "
          f"mediana={np.median(s):.0f} m")
    if hasattr(source, "close"):
        source.close()
