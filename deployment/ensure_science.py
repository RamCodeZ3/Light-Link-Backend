"""Obtiene DEM verificables al construir desde Git, o reutiliza el paquete local."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time
import urllib.request

from prepare_science import prepare, verify, sha256, ROOT

GLOBAL_URL='https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_64.tif'
GLOBAL_SHA256='af55ea2ed9173d1744b98ac4205501bd0bb0dcfc6ac49a11473a411dc64afd90'
DEFAULT_SITES=('Site01','Site04','Site11')


def download(url, output, expected, max_bytes):
    """Descarga acotada, verifica SHA-256 y publica únicamente el archivo completo."""
    if output.exists() and sha256(output)==expected:
        return
    output.parent.mkdir(parents=True,exist_ok=True)
    temporary=output.with_suffix(output.suffix+'.part')
    for attempt in range(3):
        try:
            digest=hashlib.sha256();total=0
            print(f'Descargando {output.name} (intento {attempt+1})',flush=True)
            request=urllib.request.Request(url,headers={'User-Agent':'Light-Link-Backend deployment/1.0'})
            with urllib.request.urlopen(request,timeout=90) as response, temporary.open('wb') as target:
                if response.status!=200:
                    raise ValueError(f'HTTP inesperado para {output.name}')
                for chunk in iter(lambda:response.read(1024*1024),b''):
                    total+=len(chunk)
                    if total>max_bytes:
                        raise ValueError(f'Archivo excede tamaño esperado: {output.name}')
                    digest.update(chunk);target.write(chunk)
            if digest.hexdigest()!=expected:
                raise ValueError(f'SHA-256 inesperado en {output.name}; no se aceptan cambios de fuente silenciosos')
            temporary.replace(output)
            return
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt==2:
                raise
            time.sleep(1+attempt)


def regional(source, local_dem, destination):
    """Mismo remuestreo de fase1/dem_regional.py entregado; no usa alturas ficticias."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.windows import Window
    from pyproj import Transformer

    with rasterio.open(local_dem) as local:
        crs=local.crs
    projection=Transformer.from_crs(crs,'+proj=longlat +R=1737400 +no_defs',always_xy=True)
    _,corner=projection.transform(320000,320000)
    with rasterio.open(source) as global_dem:
        width,height=global_dem.width,global_dem.height
        if (width,height)!=(23040,11520) or global_dem.dtypes[0]!='float32':
            raise ValueError('Rejilla del DEM global incompatible')
        r0=int(np.floor((90-(corner+.5))*64-.5))
        cap=global_dem.read(1,window=Window(0,r0,width,height-r0)).astype(np.float64)*1000
    axis=-320000+(np.arange(3200)+.5)*200
    out=np.empty((3200,3200),dtype=np.float32)
    for offset in range(0,3200,256):
        xs,ys=np.meshgrid(axis,-axis[offset:offset+256])
        lon,lat=projection.transform(xs,ys)
        col=(lon+180)*64-.5;row=(90-lat)*64-.5-r0
        c0=np.floor(col).astype(np.int64);fc=col-c0
        clipped=np.clip(row,0,cap.shape[0]-1.000001)
        r_0=np.floor(clipped).astype(np.int64);fr=clipped-r_0
        c0%=width;c1=(c0+1)%width;r_1=np.minimum(r_0+1,cap.shape[0]-1)
        out[offset:offset+256]=cap[r_0,c0]*(1-fc)*(1-fr)+cap[r_0,c1]*fc*(1-fr)+cap[r_1,c0]*(1-fc)*fr+cap[r_1,c1]*fc*fr
    if not np.isfinite(out).all():
        raise ValueError('DEM regional con datos no finitos')
    destination.parent.mkdir(parents=True,exist_ok=True)
    with rasterio.open(destination,'w',driver='GTiff',width=3200,height=3200,count=1,dtype='float32',crs=crs,transform=from_origin(-320000,320000,200,200),compress='deflate',predictor=3,tiled=True,blockxsize=256,blockysize=256) as target:
        target.write(out,1)
        target.update_tags(source=GLOBAL_URL,source_product='NASA/GSFC/SVS 4720 CGI Moon Kit',units='m sobre esfera de 1737400 m',grid='pixel-area: lon=-180+(col+0.5)/64, lat=90-(row+0.5)/64')
    destination.with_suffix('.json').write_text(json.dumps({'archivo':destination.name,'fuente':GLOBAL_URL,'fuente_sha256':GLOBAL_SHA256,'fuente_bytes':source.stat().st_size,'paso_m':200,'semilado_km':320,'pixeles':3200,'altura_min_m':float(out.min()),'altura_max_m':float(out.max()),'crs':crs.to_proj4(),'generator':'deployment/ensure_science.py; algoritmo de fase1/dem_regional.py recibido'},indent=2)+'\n')


def ensure(seed, output, selected=DEFAULT_SITES):
    if (seed/'manifest.json').is_file():
        print('Usando paquete científico local',flush=True)
        verify(seed)
        shutil.copytree(seed,output,dirs_exist_ok=True)
        verify(output)
        return
    print('No hay paquete local: preparando ciencia desde fuentes NASA verificadas',flush=True)
    with tempfile.TemporaryDirectory(prefix='light-link-build-') as temporary:
        source=Path(temporary)
        local=source/'crudos/lola_sitios_5m'
        for site in selected:
            metadata=json.loads((ROOT/'data/sites'/f'{site}.json').read_text())['target']
            name=metadata['source_file']
            url=f'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{site}/{name}'
            download(url,local/name,metadata['source_sha256'],150_000_000)
        global_dem=source/'ldem_64.tif'
        download(GLOBAL_URL,global_dem,GLOBAL_SHA256,1_100_000_000)
        regional(global_dem,local/f'{selected[0]}_final_adj_5mpp_surf.tif',source/'intermedios/dem_regional/ldem_64_sur_stereo_200m.tif')
        prepare(source,output,selected,compress=True)
        verify(output)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed',type=Path,default=ROOT/'.deployment/science')
    parser.add_argument('--output',type=Path,default=ROOT/'science')
    args=parser.parse_args()
    ensure(args.seed,args.output)
