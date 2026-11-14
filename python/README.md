# PB-03 — Adrian / Aram

Código recibido en `drive-download-20261114T150317Z-1-001/fase1`, conservado
sin modificar: trazado geodésico, relieve cercano LOLA y capa lejana regional.
No es una implementación nueva ni se ha regenerado el DEM en esta entrega.
`config.yaml` conserva los parámetros originales; solo T2 corresponde a PB-03.

Desde la raíz, con las dependencias de `python/requirements.txt` instaladas:

```bash
python3 python/horizon/t2_mascaras_horizonte.py --config python/config.yaml --input-dir drive-download-20261114T150317Z-1-001/datos/crudos/lola_sitios_5m --output-dir /tmp/light-link-horizon
```

Antes de ejecutar, ajustar `t2.far_field.regional_dem` en una copia de la
configuración a la ruta absoluta del DEM regional entregado. Las rutas relativas
se resuelven respecto a `python/`. No regenerar sobre los originales.
La generación completa y su validación científica siguen pendientes.

Las máscaras entregadas tienen 3600 direcciones a 0,1°, resolución mayor que las
360 direcciones a 1° pedidas en PB-03. Se conserva esa resolución para evitar
perder picos. Hay perfiles precalculados de 2 y 5 m; 10 m requiere volver a
trazar todos los rayos. Distancia al máximo por sí sola no permite corregir
exactamente otras alturas: puede cambiar el obstáculo dominante.
