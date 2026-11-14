#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
t2_mascaras_horizonte.py
=========================

Tarea T2 de la Fase 1: mascaras de horizonte H(phi) por sitio.

Que cambia respecto a la version anterior (auditoria tecnica, Fase 1)
---------------------------------------------------------------------
H2.1 (CRITICO)  La LUT esta indexada por **AZIMUT REAL** (0 = norte real,
                90 = este).  Antes estaba indexada por azimut de CUADRICULA y
                T3 la consultaba con el azimut real que devuelve Horizons:
                un error de hasta +-180 grados.  Ahora el rayo de azimut real
                ``alfa`` se traza en azimut de cuadricula ``alfa + gamma``,
                con ``gamma = lambda_sitio - lambda_0`` la convergencia de
                cuadricula del sitio.  El JSON declara
                ``azimuth_frame = "true_north"`` para que T3 pueda rechazarlo
                si encuentra una mascara en el marco equivocado.
H2.2  La capa CERCANA se calcula sobre el GeoTIFF float32 (elevacion exacta),
                no sobre el PNG uint16.  La capa LEJANA usa un DEM regional
                con geodesicas reales y elevacion angular exacta.
H2.3  La LUT tiene 0.1 grados (3600 bins) en lugar de 0.5 (720).
H2.4  El observador no es el centro del tile sino un **sitio objetivo**
                seleccionado automaticamente (pendiente minima) dentro de un
                radio de busqueda; se registra ``slope_ok``.
H2.5  El script NO escribe ``sites_metadata.json`` (eso es de T1).
H2.6  Salida por sitio: ``horizon_masks/<Site>.json`` + ``targets.json``.

Salidas
-------
    datos/fase1/targets.json          sitio objetivo por sitio (T3 lo usa)
    datos/fase1/horizon_masks/<Site>.json   LUT H(phi) por sitio
    datos/fase1/horizon_masks/index.json   indice de la corrida
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from comun import (
    DIR_CRUDOS_SITIOS, DIR_FASE1, ruta_del_proyecto,
    MOON_RADIUS_M,
    SCHEMA_VERSION,
    AZIMUTH_CONVENTION,
    config_hash,
    exact_elevation_deg,
    geodesic_destination,
    grid_convergence_deg,
    latlon_to_polar_stereographic,
    load_config,
    sha256_file,
    write_json_compact,
)

# --------------------------------------------------------------------------
# Constantes
# --------------------------------------------------------------------------
INPUT_GLOB = "*_final_adj_5mpp_surf.tif"
OUT_SUBDIR = "fase1"   # carpeta de salida dentro de datos/ (ver comun.DIR_FASE1)
HORIZON_SUBDIR = "horizon_masks"

PIXEL_RES_M = 5.0
AZIMUTH_STEP_DEG = 0.1
DIST_STEP_M = 5.0
OBSERVER_HEIGHTS_M = [2.0, 5.0]

NODATA_FLOOR = -1.0e30
SITE_RE = re.compile(r"^(?P<site>.+?)_final_adj_5mpp_surf\.tif$", re.IGNORECASE)

#: Bloque de azimutes procesado por iteracion (controla el uso de memoria).
AZ_BLOCK = 180

_T0 = time.time()


def log(msg: str = "", level: str = "INFO") -> None:
    tag = {"INFO": "  ", "OK": "OK", "WARN": "!!", "ERR": "XX"}.get(level, "  ")
    print(f"[{time.time() - _T0:7.1f}s] {tag} {msg}", flush=True)


# ==========================================================================
# Raster DEM
# ==========================================================================
class DemRaster:
    """GeoTIFF float32 de LOLA, con muestreo bilineal alineado a media pixel.

    El indice de pixel ``i`` (numpy, convencion "centro del pixel") se
    corresponde con la coordenada de mundo ``x = c + a * (i + 0.5)``.  Por eso
    la conversion mundo -> indice lleva el ``- 0.5``.  Es el mismo criterio
    que usa T1 para el centro del tile, de modo que T1, T2 y T3 se refieren
    al mismo punto (H1.6).
    """

    def __init__(self, path: Path) -> None:
        import rasterio

        self.path = Path(path)
        with rasterio.open(self.path) as ds:
            self.width = int(ds.width)
            self.height = int(ds.height)
            self.transform = ds.transform
            self.crs = ds.crs
            self.res = (float(ds.res[0]), float(ds.res[1]))
            data = ds.read(1).astype(np.float32, copy=False)

        self.z = np.ascontiguousarray(data)
        self.valid = np.isfinite(self.z) & (self.z > NODATA_FLOOR)
        self.n_valid = int(self.valid.sum())
        self.valid_fraction = float(self.valid.mean())

        self.a, self.b, self.c, self.d, self.e, self.f = tuple(self.transform)[:6]

        crs_dict = self.crs.to_dict() if self.crs else {}
        self.crs_proj4 = self.crs.to_proj4() if self.crs else ""
        self.lon_0_deg = float(crs_dict.get("lon_0") or 0.0)
        self.k0 = float(crs_dict.get("k_0") or 1.0)

    # -- geometria ---------------------------------------------------------
    def world_to_index(self, x: np.ndarray, y: np.ndarray):
        """(x, y) en metros -> (row, col) en indices de pixel."""
        col = (np.asarray(x, dtype=np.float64) - self.c) / self.a - 0.5
        row = (np.asarray(y, dtype=np.float64) - self.f) / self.e - 0.5
        return row, col

    def index_to_world(self, col: np.ndarray, row: np.ndarray):
        """(col, row) en indices de pixel -> (x, y) en metros."""
        x = self.c + self.a * (np.asarray(col, dtype=np.float64) + 0.5)
        y = self.f + self.e * (np.asarray(row, dtype=np.float64) + 0.5)
        return x, y

    # -- muestreo ----------------------------------------------------------
    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Muestreo bilinear; NaN fuera del raster o junto a un NoData."""
        from scipy import ndimage as ndi

        row, col = self.world_to_index(x, y)
        return ndi.map_coordinates(self.z, [row, col], order=1,
                                   mode="constant", cval=np.nan,
                                   prefilter=False)

    def bounds(self) -> Tuple[float, float, float, float]:
        return (self.c, self.f,
                self.c + self.a * self.width,
                self.f + self.e * self.height)

    def max_corner_distance(self, x0: float, y0: float) -> float:
        left, top, right, bottom = self.bounds()
        return max(math.hypot(cx - x0, cy - y0)
                   for cx in (left, right) for cy in (top, bottom))

    # -- relieve -----------------------------------------------------------
    def slope_deg(self, window_m: float) -> np.ndarray:
        """Pendiente local (grados) sobre una ventana de ``window_m``.

        Se calcula sobre una version suavizada con una caja de ``k`` pixeles;
        las zonas sin ventana completa quedan en NaN.  ``ndi.uniform_filter``
        propaga el NaN, asi que basta con descartar los NoData.
        """
        from scipy import ndimage as ndi

        k = int(round(window_m / PIXEL_RES_M))
        if k < 2:
            k = 2
        if k % 2 == 0:
            k += 1

        # OJO: ``ndi.uniform_filter(..., mode="constant", cval=np.nan)``
        # envenena TODO el array (su suma corrida arrastra el NaN del borde
        # a todo el interior).  Se usa ``mode="nearest"`` y la validez de la
        # ventana se comprueba aparte, contando pixeles validos.
        zf = np.where(self.valid, self.z, np.nan).astype(np.float64)
        sm = ndi.uniform_filter(zf, size=k, mode="nearest")
        win_ok = (ndi.uniform_filter(self.valid.astype(np.float64), size=k,
                                     mode="nearest") >= 1.0 - 1e-9)

        gy, gx = np.gradient(sm)
        slope = np.degrees(np.arctan(np.hypot(gx, gy) / PIXEL_RES_M))
        slope[~win_ok] = np.nan
        slope[~np.isfinite(slope)] = np.nan
        return slope


# ==========================================================================
# Seleccion del sitio objetivo  (H2.4)
# ==========================================================================
def select_target(dem: DemRaster, center_x: float, center_y: float,
                  search_radius_m: float, slope_window_m: float,
                  slope_ok_deg: float) -> Dict[str, Any]:
    """Elige el punto de observacion: pendiente minima cerca del centro.

    Devuelve el punto elegido, su pendiente y si la pendiente es aceptable.
    """
    slope = dem.slope_deg(slope_window_m)

    r0, c0 = dem.world_to_index(np.array([center_x]), np.array([center_y]))
    r0 = float(r0[0])
    c0 = float(c0[0])

    rad_px = search_radius_m / PIXEL_RES_M
    r_lo = max(0, int(math.floor(r0 - rad_px)))
    r_hi = min(dem.height, int(math.ceil(r0 + rad_px)) + 1)
    c_lo = max(0, int(math.floor(c0 - rad_px)))
    c_hi = min(dem.width, int(math.ceil(c0 + rad_px)) + 1)

    if r_hi <= r_lo or c_hi <= c_lo:
        r_lo, r_hi = 0, dem.height
        c_lo, c_hi = 0, dem.width

    sub = slope[r_lo:r_hi, c_lo:c_hi]
    if not np.isfinite(sub).any():
        raise ValueError("no hay pendientes calculables en el radio de busqueda")

    flat = np.where(np.isfinite(sub), sub, np.inf)
    k = int(np.argmin(flat))
    sr, sc = np.unravel_index(k, flat.shape)
    row = r_lo + int(sr)
    col = c_lo + int(sc)

    slope_val = float(slope[row, col])
    x, y = dem.index_to_world(np.array([float(col)]), np.array([float(row)]))
    x = float(x[0])
    y = float(y[0])

    z_val = float(dem.sample(np.array([x]), np.array([y]))[0])

    dist = float(math.hypot(x - center_x, y - center_y))

    return {
        "observer_x_m": x,
        "observer_y_m": y,
        "observer_pixel": [int(col), int(row)],
        "observer_z_m": z_val,
        "slope_deg": slope_val,
        "slope_ok": bool(slope_val <= slope_ok_deg),
        "slope_window_m": slope_window_m,
        "slope_ok_deg": slope_ok_deg,
        "search_radius_m": search_radius_m,
        "search_center_x_m": float(center_x),
        "search_center_y_m": float(center_y),
        "distance_to_search_center_m": dist,
        "search_bbox_px": [c_lo, r_lo, c_hi, r_hi],
    }


# ==========================================================================
# Capa cercana: marcha sobre el GeoTIFF  (H2.2, H2.3)
# ==========================================================================
def build_distances(max_dist_m: float, refine_m: float, refine_step_m: float,
                    step_m: float) -> np.ndarray:
    """Malla de distancias de la marcha.

    Dos tramos: fino (``refine_step_m``) hasta ``refine_m`` y grueso
    (``step_m``) a partir de ahi.  El horizonte lo fija casi siempre un
    relieve muy cercano (decenas o cientos de metros), y ahi el error de
    discretizacion es proporcional al paso: con 5 m se observa un error de
    hasta 0.02 grados en pendientes cerradas.  Afinar el primer tramo a 1 m
    lo deja por debajo de 0.005 grados sin coste apreciable.
    """
    refine_m = float(min(refine_m, max_dist_m))
    parts = []
    if refine_m > 0 and refine_step_m > 0:
        parts.append(np.arange(refine_step_m, refine_m + 0.5 * refine_step_m,
                               refine_step_m))
    parts.append(np.arange(refine_m + step_m,
                            max_dist_m + 0.5 * step_m, step_m))
    s = np.concatenate([p for p in parts if p.size])
    s = np.unique(s[(s > 0) & (s <= max_dist_m + 0.5 * step_m)])
    return s


def near_horizon(dem: DemRaster, obs_lat: float, obs_lon: float,
                 obs_ground_z: float, heights_m: Sequence[float],
                 azimuths_deg: np.ndarray, dist_step_m: float,
                 max_dist_m: float, refine_m: float = 500.0,
                 refine_step_m: float = 1.0) -> Dict[str, Dict[str, np.ndarray]]:
    """Perfil de horizonte de la capa CERCANA, en azimut REAL.

    Para cada azimut real se traza la geodesica sobre la esfera lunar, se
    proyecta cada muestra al plano del DEM y se muestrea el GeoTIFF float32.
    La elevacion angular es EXACTA (no la aproximacion ``d^2/2R``).

    La marcha (geodesia + muestreo) se hace UNA sola vez y se evalua para
    cada altura de observador: la altura solo cambia ``r0 = R + z_suelo + h``.

    Devuelve {altura -> {horizon_deg, dist_m, s_reached_m, valid_frac}}.
    """
    n_az = len(azimuths_deg)
    heights = [float(h) for h in heights_m]

    out = {
        h: {
            "horizon_deg": np.full(n_az, np.nan),
            "dist_m": np.full(n_az, np.nan),
            "s_reached_m": np.zeros(n_az),
            "valid_frac": np.zeros(n_az),
        } for h in heights
    }

    s = build_distances(max_dist_m, refine_m, refine_step_m, dist_step_m)
    n_s = len(s)
    if n_s == 0:
        raise ValueError("rango de distancias vacio")

    s_row = s[None, :]

    for start in range(0, n_az, AZ_BLOCK):
        stop = min(start + AZ_BLOCK, n_az)
        az = azimuths_deg[start:stop][:, None]

        # 1) geodesica real desde el observador (azimut real)
        lat, lon = geodesic_destination(obs_lat, obs_lon, az, s_row)
        # 2) proyeccion al plano del DEM
        x, y = latlon_to_polar_stereographic(lat, lon, dem.lon_0_deg)
        # 3) muestreo bilinear del GeoTIFF float32
        z = dem.sample(x, y)

        good = np.isfinite(z)
        # el rayo se detiene en el primer NoData
        bad = ~good
        has_bad = bad.any(axis=1)
        first_bad = np.where(has_bad, bad.argmax(axis=1), n_s)
        idx = np.arange(n_s)[None, :]
        prefix = idx < first_bad[:, None]
        usable = good & prefix

        for h in heights:
            # 4) elevacion angular EXACTA (r0 = R + z_suelo + h)
            theta = exact_elevation_deg(z, obs_ground_z + h, s_row)
            theta = np.where(usable, theta, -np.inf)

            best = theta.max(axis=1)
            arg = theta.argmax(axis=1)
            has_any = np.isfinite(best)

            out[h]["horizon_deg"][start:stop] = np.where(has_any, best, np.nan)
            out[h]["dist_m"][start:stop] = np.where(has_any, s[arg], np.nan)
            out[h]["s_reached_m"][start:stop] = np.where(
                has_any, s[np.maximum(first_bad - 1, 0)], 0.0)
            out[h]["valid_frac"][start:stop] = usable.sum(axis=1) / n_s

    for h in heights:
        out[h]["max_distance_m"] = float(max_dist_m)
        out[h]["distance_step_m"] = float(dist_step_m)
    return out


# ==========================================================================
# Capa lejana  (H2.2) - delegacion en capa_lejana
# ==========================================================================
def far_horizon(dem_paths: Sequence[Path], regional_dem: Optional[Path],
                provider: str, obs_lat: float, obs_lon: float, obs_z: float,
                azimuths_deg: np.ndarray, max_dist_m: float, step_m: float
                ) -> Dict[str, Any]:
    """Perfil de horizonte de la capa LEJANA.

    Devuelve ``None`` si la capa lejana esta desactivada o no hay datos.
    """
    if provider == "none":
        return None

    try:
        from capa_lejana import (  # type: ignore
            RegionalDEM,
            VirtualMosaic,
            far_horizon_profile,
        )
    except ImportError as exc:
        log(f"Capa lejana no disponible ({exc}); se omite", "WARN")
        return None

    if provider == "regional_dem":
        if not regional_dem or not Path(regional_dem).is_file():
            log(f"DEM regional no encontrado: {regional_dem}", "WARN")
            return None
        dem = RegionalDEM(Path(regional_dem))
    elif provider == "mosaic":
        dem = VirtualMosaic([Path(p) for p in dem_paths])
    else:
        log(f"Proveedor de capa lejana desconocido: {provider}", "WARN")
        return None

    H, s_alc = far_horizon_profile(dem, obs_lat, obs_lon, obs_z,
                                   azimuths_deg, max_dist_m, step_m)

    H = np.asarray(H, dtype=np.float64)
    s_alc_arr = np.asarray(s_alc, dtype=np.float64)
    if s_alc_arr.ndim == 0:
        s_alc_arr = np.full(len(azimuths_deg), float(s_alc_arr))

    return {
        "horizon_deg": H,
        "s_reached_m": s_alc_arr,
        "provider": provider,
        "max_distance_m": float(max_dist_m),
        "distance_step_m": float(step_m),
    }


# ==========================================================================
# Calculo completo de un sitio
# ==========================================================================
def compute_site_masks(dem: DemRaster, site_id: str, target: Dict[str, Any],
                       azimuths_deg: np.ndarray, heights_m: Sequence[float],
                       dist_step_m: float, far_cfg: Dict[str, Any],
                       dem_paths: Sequence[Path], refine_m: float = 500.0,
                       refine_step_m: float = 1.0) -> Dict[str, Any]:
    """Calcula la LUT H(phi) de un sitio para cada altura de observador."""
    from comun import polar_stereographic_to_latlon

    obs_x = target["observer_x_m"]
    obs_y = target["observer_y_m"]
    obs_z = target["observer_z_m"]

    lat, lon = polar_stereographic_to_latlon(obs_x, obs_y, dem.lon_0_deg)
    obs_lat = float(lat)
    obs_lon = float(lon) % 360.0

    gamma = grid_convergence_deg(obs_lon, dem.lon_0_deg)

    # --- capa cercana -----------------------------------------------------
    max_dist = dem.max_corner_distance(obs_x, obs_y)
    near = near_horizon(dem, obs_lat, obs_lon, obs_z, heights_m,
                        azimuths_deg, dist_step_m, max_dist,
                        refine_m=refine_m, refine_step_m=refine_step_m)
    h0 = heights_m[0]
    log(f"  {site_id}: capa cercana | alcance medio "
        f"{np.nanmean(near[h0]['s_reached_m']):,.0f} m | "
        f"H en [{np.nanmin(near[h0]['horizon_deg']):+.3f}, "
        f"{np.nanmax(near[h0]['horizon_deg']):+.3f}] deg")

    # --- capa lejana ------------------------------------------------------
    far: Dict[float, Dict[str, Any]] = {}
    if far_cfg.get("enabled"):
        for h in heights_m:
            f = far_horizon(dem_paths, far_cfg.get("regional_dem"),
                            far_cfg.get("provider", "mosaic"),
                            obs_lat, obs_lon, obs_z + h, azimuths_deg,
                            float(far_cfg.get("max_distance_m", 150000.0)),
                            float(far_cfg.get("downsample_m", 100.0)))
            if f is not None:
                far[h] = f
        if far:
            f0 = far[heights_m[0]]
            log(f"  {site_id}: capa lejana ({f0['provider']}) | alcance "
                f"min {np.nanmin(f0['s_reached_m']):,.0f} m, "
                f"med {np.nanmean(f0['s_reached_m']):,.0f} m | "
                f"H en [{np.nanmin(f0['horizon_deg']):+.3f}, "
                f"{np.nanmax(f0['horizon_deg']):+.3f}] deg")
        else:
            log(f"  {site_id}: sin capa lejana; el horizonte solo esta "
                f"constreñido por los "
                f"{np.nanmean(near[h0]['s_reached_m'])/1000:.1f} km del tile",
                "WARN")

    # --- prueba de convergencia de la capa lejana (H2.2.4) ----------------
    # OJO: que el perfil NO cambie al subir s_max solo prueba que el alcance
    # esta limitado por los DATOS (no hay DEM regional), no que el horizonte
    # haya dejado de cambiar por muy lejos que se mire.  Por eso se exige
    # ademas que el ALCANCE crezca: si no crece, la convergencia se marca
    # 'sin_datos' y 'converged' queda en False.
    convergence: Dict[str, Any] = {
        "threshold_deg": float(far_cfg.get("convergence_delta_deg", 0.05)),
        "factors": [],
        "s_max_m": None,
        "convergence_delta_deg": None,
        "converged": None,
        "status": "no_evaluado",
        "data_limited": None,
        "reach_grew": None,
        "note": "",
    }
    if far_cfg.get("enabled"):
        base_d = float(far_cfg.get("max_distance_m", 150000.0))
        factors = far_cfg.get("convergence_factors", [1.0, 2.0, 4.0])
        prev = None
        prev_reach = None
        for fac in factors:
            f = far_horizon(dem_paths, far_cfg.get("regional_dem"),
                            far_cfg.get("provider", "mosaic"),
                            obs_lat, obs_lon, obs_z + heights_m[0],
                            azimuths_deg, base_d * float(fac),
                            float(far_cfg.get("downsample_m", 100.0)))
            if f is None:
                if not convergence["factors"]:
                    # la capa lejana no se pudo calcular en absoluto
                    convergence["converged"] = False
                    convergence["data_limited"] = True
                    convergence["status"] = "sin_capa_lejana"
                    convergence["note"] = (
                        "la capa lejana no se pudo calcular: no hay DEM "
                        "disponible para el alcance pedido")
                break
            reach = float(np.nanmean(f["s_reached_m"]))
            convergence["factors"].append({
                "factor": float(fac),
                "s_max_m": base_d * float(fac),
                "mean_reach_m": round(reach, 2),
                "horizon_max_deg": round(float(np.nanmax(f["horizon_deg"])), 6),
            })
            convergence["s_max_m"] = base_d * float(fac)
            if prev is not None:
                d = np.abs(f["horizon_deg"] - prev["horizon_deg"])
                d = d[np.isfinite(d)]
                delta = float(np.max(d)) if d.size else 0.0
                convergence["convergence_delta_deg"] = round(delta, 6)
                # el alcance debe AUMENTAR: si no, no hay datos nuevos y el
                # delta ~0 es trivial (no se ha convergido nada).
                reach_grew = reach > prev_reach + 1.0
                convergence["reach_grew"] = bool(reach_grew)
                if not reach_grew:
                    convergence["converged"] = False
                    convergence["data_limited"] = True
                    convergence["status"] = "sin_datos"
                    convergence["note"] = (
                        "el alcance medio no aumenta al subir s_max "
                        f"({prev_reach:.0f} -> {reach:.0f} m): no hay DEM "
                        "regional, el perfil H no esta constreñido mas alla "
                        "del alcance de los tiles disponibles")
                    break
                if delta < convergence["threshold_deg"]:
                    convergence["converged"] = True
                    convergence["data_limited"] = False
                    convergence["status"] = "converged"
                    convergence["note"] = (
                        f"el alcance medio crece ({prev_reach:.0f} -> {reach:.0f} m) "
                        f"y H cambia como maximo {delta:.4f} deg (< "
                        f"{convergence['threshold_deg']} deg): el horizonte "
                        "lejano esta convergido")
                    break
                convergence["note"] = ""
                convergence["converged"] = False
                convergence["data_limited"] = False
                convergence["status"] = "no_converged"
            else:
                convergence["converged"] = False
                convergence["data_limited"] = True
                convergence["status"] = "sin_datos"
                convergence["note"] = (
                    "solo se pudo evaluar un factor de s_max: no hay "
                    "comparacion con la que probar la convergencia")
            prev = f
            prev_reach = reach
        log(f"  {site_id}: convergencia capa lejana | "
            f"s_max={convergence['s_max_m']} m | "
            f"delta={convergence['convergence_delta_deg']} deg | "
            f"estado={convergence['status']} | "
            f"converge={convergence['converged']}")
    else:
        convergence["converged"] = False
        convergence["data_limited"] = True
        convergence["status"] = "sin_capa_lejana"
        convergence["note"] = ("la capa lejana esta desactivada: el perfil "
                               "H solo esta constreñido por el tile cercano")

    # --- perfiles por altura ----------------------------------------------
    profiles: Dict[str, Any] = {}
    for h in heights_m:
        prof = near[h]
        H = prof["horizon_deg"].copy()
        dist_at_max = prof["dist_m"].copy()
        reached = prof["s_reached_m"].copy()
        vfrac = prof["valid_frac"].copy()
        source = np.array(["near"] * len(azimuths_deg), dtype=object)

        if h in far:
            f = far[h]
            Hf = f["horizon_deg"]
            better = np.isfinite(Hf) & (Hf > H)
            H = np.where(better, Hf, H)
            source = np.where(better, "far", source)
            reached = np.maximum(reached, np.where(
                np.isfinite(f["s_reached_m"]), f["s_reached_m"], 0.0))

        key = f"{h:g}"
        finite = np.isfinite(H)
        i_max = int(np.argmax(np.where(finite, H, -np.inf)))
        i_min = int(np.argmin(np.where(finite, H, np.inf)))
        stats = {
            "fraction_az_above_0deg": round(
                float(np.mean(H[finite] > 0.0)) if finite.any() else 0.0, 4),
            "azimuth_of_max_deg": round(float(azimuths_deg[i_max]), 4),
            "azimuth_of_min_deg": round(float(azimuths_deg[i_min]), 4),
            "horizon_max_deg": round(float(np.nanmax(H)), 6),
            "horizon_min_deg": round(float(np.nanmin(H)), 6),
            "mean_horizon_deg": round(float(np.nanmean(H)), 6),
            "fraction_from_far_layer": round(
                float(np.mean(np.asarray(source) == "far")), 4),
        }
        profiles[key] = {
            "observer_height_m": float(h),
            "horizon_deg": [round(float(v), 6) for v in H],
            "dist_at_max_m": [round(float(v), 2) if np.isfinite(v) else None
                              for v in dist_at_max],
            "s_reached_m": [round(float(v), 2) for v in reached],
            "valid_frac": [round(float(v), 4) for v in vfrac],
            "source": list(source),
            "horizon_stats": stats,
        }
        log(f"  {site_id}: altura {h} m -> H en [{np.nanmin(H):+.4f}, "
            f"{np.nanmax(H):+.4f}] deg | "
            f"alcanzado medio {np.nanmean(reached)/1000:.1f} km")

    meta = {
        "schema_version": SCHEMA_VERSION,
        "site_id": site_id,
        "azimuth_frame": "true_north",
        "azimuth_convention": AZIMUTH_CONVENTION,
        "azimuth_step_deg": float(AZIMUTH_STEP_DEG),
        "num_bins": int(len(azimuths_deg)),
        "azimuth_0_deg": 0.0,
        "interpolation": "linear_circular",
        "grid_convergence_deg": gamma,
        "lon_0_deg": dem.lon_0_deg,
        "observer_lat_deg": obs_lat,
        "observer_lon_deg": obs_lon,
        "observer_x_m": obs_x,
        "observer_y_m": obs_y,
        "observer_ground_z_m": obs_z,
        "observer_heights_m": [float(h) for h in heights_m],
        "distance_step_m": float(dist_step_m),
        "distance_refine_m": float(refine_m),
        "distance_refine_step_m": float(refine_step_m),
        "near_max_distance_m": float(dem.max_corner_distance(obs_x, obs_y)),
        "near_valid_pixel_fraction": dem.valid_fraction,
        "far_field": ({"provider": far[heights_m[0]]["provider"],
                       "max_distance_m": far[heights_m[0]]["max_distance_m"],
                       "distance_step_m": far[heights_m[0]]["distance_step_m"],
                       "mean_reach_m": float(np.nanmean(
                           far[heights_m[0]]["s_reached_m"])),
                       "min_reach_m": float(np.nanmin(
                           far[heights_m[0]]["s_reached_m"]))}
                      if far else
                      {"provider": "none",
                       "note": "sin capa lejana: el horizonte mas alla del "
                               "tile no esta constreñido por datos"}),
        "elevation_model": "exacta: atan2(r1*cos(s/R) - r0, r1*sin(s/R))",
        "geodesic": "geodesica real sobre la esfera lunar (k0=1, R=1737.4 km)",
        "s_max_m": float(dem.max_corner_distance(obs_x, obs_y)),
        "sources": {
            "near": {
                "kind": "GeoTIFF LOLA 5 mpp (float32, sin cuantizar)",
                "source_file": dem.path.name,
                "max_distance_m": float(dem.max_corner_distance(obs_x, obs_y)),
                "distance_step_m": float(dist_step_m),
                "distance_refine_m": float(refine_m),
                "distance_refine_step_m": float(refine_step_m),
                "mean_reach_m": round(float(np.nanmean(near[h0]["s_reached_m"])), 2),
            },
            "far": ({
                "kind": "capa lejana",
                "provider": far[heights_m[0]]["provider"],
                "max_distance_m": far[heights_m[0]]["max_distance_m"],
                "distance_step_m": far[heights_m[0]]["distance_step_m"],
                "mean_reach_m": round(float(np.nanmean(
                    far[heights_m[0]]["s_reached_m"])), 2),
                "min_reach_m": round(float(np.nanmin(
                    far[heights_m[0]]["s_reached_m"])), 2),
            } if far else {"kind": "ninguna",
                           "note": "sin DEM regional: el horizonte mas alla "
                                   "del tile no esta constreñido por datos"}),
        },
        "convergence": convergence,
    }

    return {"meta": meta, "profiles": profiles}


# ==========================================================================
# Programa principal
# ==========================================================================
def main(argv: Optional[List[str]] = None) -> int:
    default_input = DIR_CRUDOS_SITIOS

    parser = argparse.ArgumentParser(
        description="Mascaras de horizonte H(phi) en azimut REAL por sitio.")
    parser.add_argument("-i", "--input-dir", type=Path, default=default_input)
    parser.add_argument("-o", "--output-dir", type=Path, default=None)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--only", type=str, default=None)
    parser.add_argument("--no-far", action="store_true",
                        help="desactivar la capa lejana")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    t2 = cfg.get("t2", {})

    az_step = float(t2.get("azimuth_step_deg", AZIMUTH_STEP_DEG))
    num_bins = int(round(360.0 / az_step))
    dist_step = float(t2.get("distance_step_m", DIST_STEP_M))
    refine_m = float(t2.get("distance_refine_m", 500.0))
    refine_step_m = float(t2.get("distance_refine_step_m", 1.0))
    heights = [float(h) for h in t2.get("observer_heights_m", OBSERVER_HEIGHTS_M)]
    search_radius = float(t2.get("target_search_radius_m", 200.0))
    slope_window = float(t2.get("target_slope_window_m", 20.0))
    slope_ok_deg = float(t2.get("target_slope_ok_deg", 10.0))
    far_cfg = dict(t2.get("far_field", {}) or {})
    if args.no_far:
        far_cfg["enabled"] = False
    if far_cfg.get("regional_dem"):
        # relativa a la raiz del proyecto, no al directorio de trabajo
        far_cfg["regional_dem"] = str(ruta_del_proyecto(far_cfg["regional_dem"]))

    in_dir: Path = args.input_dir.expanduser().resolve()
    out_dir: Path = (args.output_dir.expanduser().resolve() if args.output_dir
                     else DIR_FASE1)
    mask_dir = out_dir / HORIZON_SUBDIR

    log("=" * 78)
    log("T2 - Mascaras de horizonte H(phi) en AZIMUT REAL")
    log("=" * 78)
    log(f"Config hash   : {config_hash(cfg)[:16]}")
    log(f"LUT           : {az_step} deg -> {num_bins} bins (marco: true_north)")
    log(f"Paso distancia: {dist_step} m (refinado a {refine_step_m} m hasta "
        f"{refine_m:g} m)")
    log(f"Alturas       : {heights} m")
    log(f"Capa lejana   : "
        f"{far_cfg.get('provider', 'none') if far_cfg.get('enabled') else 'desactivada'}")

    files = sorted(p for p in in_dir.glob(INPUT_GLOB) if p.is_file())
    if args.only:
        files = [p for p in files
                 if args.only.lower() in SITE_RE.match(p.name).group("site").lower()]
    if not files:
        log(f"No se encontraron '{INPUT_GLOB}' en {in_dir}", "ERR")
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    mask_dir.mkdir(parents=True, exist_ok=True)

    azimuths = np.arange(num_bins, dtype=np.float64) * az_step

    targets: Dict[str, Any] = {}
    index: Dict[str, Any] = {}
    failed: Dict[str, str] = {}
    t_start = time.time()

    for src in files:
        site_id = SITE_RE.match(src.name).group("site")
        try:
            log(f"{site_id}: leyendo {src.name}")
            dem = DemRaster(src)
            log(f"  {site_id}: {dem.width}x{dem.height} px, "
                f"{dem.valid_fraction*100:.1f}% valido, "
                f"lon_0={dem.lon_0_deg} deg")

            # el centro de busqueda es el centro de la huella valida, que es
            # el mismo criterio que usa T1 para el centro del tile
            from scipy import ndimage as ndi
            slices = ndi.find_objects(dem.valid.astype(np.uint8))[0]
            r0, r1 = slices[0].start, slices[0].stop
            c0, c1 = slices[1].start, slices[1].stop
            cx, cy = dem.index_to_world(np.array([(c0 + c1) / 2.0 - 0.5]),
                                        np.array([(r0 + r1) / 2.0 - 0.5]))
            center_x = float(cx[0])
            center_y = float(cy[0])

            target = select_target(dem, center_x, center_y, search_radius,
                                   slope_window, slope_ok_deg)
            log(f"  {site_id}: objetivo en ({target['observer_x_m']:.1f}, "
                f"{target['observer_y_m']:.1f}) m, z={target['observer_z_m']:.2f} m, "
                f"pendiente {target['slope_deg']:.2f} deg "
                f"(ok={target['slope_ok']})")

            res = compute_site_masks(dem, site_id, target, azimuths, heights,
                                     dist_step, far_cfg, files,
                                     refine_m=refine_m,
                                     refine_step_m=refine_step_m)

            # metadatos de la corrida
            doc_meta = dict(res["meta"])
            doc_meta.update({
                "generated_at_utc": datetime.now(timezone.utc).isoformat(
                    timespec="seconds"),
                "generator": Path(__file__).name,
                "config_hash": config_hash(cfg),
                "source_file": src.name,
                "source_sha256": sha256_file(src),
                "target": target,
                "target_lat_deg": res["meta"]["observer_lat_deg"],
                "target_lon_deg": res["meta"]["observer_lon_deg"],
            })

            doc = {"meta": doc_meta, "profiles": res["profiles"]}
            out_path = mask_dir / f"{site_id}.json"
            nbytes = write_json_compact(doc, out_path)

            targets[site_id] = {
                "target_id": site_id,
                "tile_id": site_id,
                "source": "auto_min_slope",
                "fuente_de_la_coordenada": "auto_min_slope",
                "site_id": site_id,
                "source_file": src.name,
                "source_sha256": doc_meta["source_sha256"],
                "observer_x_m": target["observer_x_m"],
                "observer_y_m": target["observer_y_m"],
                "observer_lat_deg": res["meta"]["observer_lat_deg"],
                "observer_lon_deg": res["meta"]["observer_lon_deg"],
                "observer_ground_z_m": target["observer_z_m"],
                "observer_height_m": heights[0] if heights else 2.0,
                "slope_deg": target["slope_deg"],
                "slope_ok": target["slope_ok"],
                "slope_window_m": target["slope_window_m"],
                "search_radius_m": target["search_radius_m"],
                "distance_to_search_center_m": target["distance_to_search_center_m"],
                "grid_convergence_deg": res["meta"]["grid_convergence_deg"],
                "lon_0_deg": dem.lon_0_deg,
                "horizon_mask_file": f"{HORIZON_SUBDIR}/{site_id}.json",
                "azimuth_frame": "true_north",
                "azimuth_step_deg": az_step,
                "num_bins": num_bins,
                "observer_heights_m": heights,
            }

            index[site_id] = {
                "site_id": site_id,
                "file": f"{HORIZON_SUBDIR}/{site_id}.json",
                "bytes": nbytes,
                "num_bins": num_bins,
                "azimuth_step_deg": az_step,
                "azimuth_frame": "true_north",
                "grid_convergence_deg": res["meta"]["grid_convergence_deg"],
                "observer_ground_z_m": target["observer_z_m"],
                "slope_deg": target["slope_deg"],
                "slope_ok": target["slope_ok"],
                "horizon_deg_min": float(np.nanmin(
                    res["profiles"][f"{heights[0]:g}"]["horizon_deg"])),
                "horizon_deg_max": float(np.nanmax(
                    res["profiles"][f"{heights[0]:g}"]["horizon_deg"])),
                "mean_reach_m": float(np.nanmean(
                    res["profiles"][f"{heights[0]:g}"]["s_reached_m"])),
                "convergence_delta_deg": res["meta"]["convergence"][
                    "convergence_delta_deg"],
                "s_max_m": res["meta"]["convergence"]["s_max_m"],
                "converged": res["meta"]["convergence"]["converged"],
                "convergence_status": res["meta"]["convergence"]["status"],
                "data_limited": res["meta"]["convergence"]["data_limited"],
                "horizon_stats": res["profiles"][f"{heights[0]:g}"][
                    "horizon_stats"],
            }
            log(f"  {site_id}: escrito {out_path.name} ({nbytes/1024:.0f} KB)")

        except Exception as exc:
            failed[site_id] = f"{type(exc).__name__}: {exc}"
            log(f"{site_id}: ERROR -> {type(exc).__name__}: {exc}", "ERR")
            log(traceback.format_exc().strip().replace("\n", "\n            "),
                "ERR")

    # --- targets.json -----------------------------------------------------
    targets_doc = {
        "meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": datetime.now(timezone.utc).isoformat(
                timespec="seconds"),
            "generator": Path(__file__).name,
            "config_hash": config_hash(cfg),
            "azimuth_frame": "true_north",
            "azimuth_convention": AZIMUTH_CONVENTION,
            "azimuth_step_deg": az_step,
            "num_bins": num_bins,
            "sites_processed": len(targets),
            "sites_failed": len(failed),
            "elapsed_s": round(time.time() - t_start, 2),
        },
        "targets": targets,
    }
    write_json_compact(targets_doc, out_dir / "targets.json")

    # --- indice de mascaras ------------------------------------------------
    index_doc = {
        "meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": datetime.now(timezone.utc).isoformat(
                timespec="seconds"),
            "generator": Path(__file__).name,
            "config_hash": config_hash(cfg),
            "azimuth_frame": "true_north",
            "azimuth_step_deg": az_step,
            "num_bins": num_bins,
            "sites_processed": len(index),
            "sites_failed": len(failed),
            "elapsed_s": round(time.time() - t_start, 2),
        },
        "sites": index,
    }
    write_json_compact(index_doc, mask_dir / "index.json")

    log("-" * 78)
    log(f"Sitios: {len(targets)} ok | {len(failed)} fallidos | "
        f"{time.time()-t_start:.1f}s")
    for sid, err in failed.items():
        log(f"    FALLIDO {sid}: {err}", "ERR")
    log(f"targets.json           -> {out_dir/'targets.json'}")
    log(f"mascaras               -> {mask_dir}")
    log("=" * 78)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
