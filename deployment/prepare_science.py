"""Prepara solo los DEM necesarios para el contenedor; no modifica originales."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parents[1]
DEFAULT_SOURCE=ROOT/'drive-download-20261114T150317Z-1-001/datos'


def sha256(path):
    result=hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda:file.read(4*1024*1024),b''):
            result.update(chunk)
    return result.hexdigest()


def prepare(source, output, selected=None, compress=False):
    sources=[]
    for site_path in sorted((ROOT/'data/sites').glob('*.json')):
        if selected and site_path.stem not in selected:
            continue
        target=json.loads(site_path.read_text())['target']
        sources.append((source/'crudos/lola_sitios_5m'/target['source_file'], Path('local')/target['source_file'],target['source_sha256']))
    if selected and len(sources)!=len(set(selected)):
        raise ValueError('Identificador de sitio desconocido')
    regional=source/'intermedios/dem_regional/ldem_64_sur_stereo_200m.tif'
    sources.extend([(regional,Path('regional')/regional.name,None),(regional.with_suffix('.json'),Path('regional')/regional.with_suffix('.json').name,None)])
    # Comprobar todos los insumos antes de escribir el paquete.
    manifest=[]
    for original, relative, expected in sources:
        if not original.is_file():
            raise ValueError(f'Falta el insumo: {original}')
        actual=sha256(original)
        if expected and actual != expected:
            raise ValueError(f'El insumo no coincide con el hash registrado: {original.name}')
        manifest.append({'path':relative.as_posix(),'sha256':actual,'bytes':original.stat().st_size})
    output.mkdir(parents=True,exist_ok=True)
    previous=json.loads((output/'manifest.json').read_text()) if (output/'manifest.json').is_file() else {'files':[]}
    for (original,relative,_),record in zip(sources,manifest):
        destination=output/relative
        destination.parent.mkdir(parents=True,exist_ok=True)
        record['source_sha256']=record['sha256']
        if compress and original.suffix=='.tif':
            import numpy as np
            import rasterio
            import rasterio.shutil
            from rasterio.windows import Window
            rasterio.shutil.copy(original,destination,driver='GTiff',compress='DEFLATE',predictor=3,tiled=True,blockxsize=256,blockysize=256,zlevel=9)
            with rasterio.open(original) as source_ds,rasterio.open(destination) as target_ds:
                if (source_ds.crs,source_ds.transform,source_ds.shape,source_ds.dtypes,str(source_ds.nodata)) != (target_ds.crs,target_ds.transform,target_ds.shape,target_ds.dtypes,str(target_ds.nodata)):
                    raise ValueError('La compresión alteró los metadatos del DEM')
                for row in range(0,source_ds.height,512):
                    window=Window(0,row,source_ds.width,min(512,source_ds.height-row))
                    if not np.array_equal(source_ds.read(1,window=window),target_ds.read(1,window=window),equal_nan=True):
                        raise ValueError('La compresión alteró elevaciones')
            record['sha256']=sha256(destination)
            record['bytes']=destination.stat().st_size
            record['compression']='lossless DEFLATE predictor=3; pixel equality verified'
        elif not destination.exists() or sha256(destination)!=record['sha256']:
            shutil.copyfile(original,destination)
    wanted={record['path'] for record in manifest}
    for old in previous['files']:
        relative=Path(old['path'])
        if relative.as_posix() not in wanted and not relative.is_absolute() and '..' not in relative.parts:
            (output/relative).unlink(missing_ok=True)
    (output/'manifest.json').write_text(json.dumps({'schema_version':1,'files':manifest},indent=2)+'\n')
    print(f"Preparados {len(manifest)} archivos ({sum(x['bytes'] for x in manifest)/1024**2:.1f} MiB) en {output}")


def verify(output):
    manifest=json.loads((output/'manifest.json').read_text())
    for record in manifest['files']:
        relative=Path(record['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Ruta inválida en manifiesto')
        path=output/relative
        if not path.is_file() or sha256(path)!=record['sha256']:
            raise ValueError(f'Paquete científico incompleto o alterado: {relative}')
    print(f"Paquete científico verificado: {len(manifest['files'])} archivos")


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=DEFAULT_SOURCE)
    parser.add_argument('--output',type=Path,default=ROOT/'.deployment/science')
    parser.add_argument('--verify',action='store_true')
    parser.add_argument('--sites',nargs='+',help='Limitar cobertura automática a estos IDs; no altera los JSON precalculados')
    parser.add_argument('--compress',action='store_true',help='Compresión TIFF sin pérdida; necesita rasterio y numpy')
    args=parser.parse_args()
    try:
        verify(args.output) if args.verify else prepare(args.source,args.output,args.sites,args.compress)
    except (ValueError,FileNotFoundError) as error:
        parser.exit(1,str(error)+'\nEjecuta npm run deploy:prepare en la computadora que tiene los datos originales.\n')
