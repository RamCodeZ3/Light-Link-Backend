# Light Link Backend

Backend TypeScript + Fastify para PB-05 de Aram, con preparación de datos en
Python. Incluye soporte limitado de PB-06 y conserva el generador recibido de
PB-03 (Adrian / Aram). No implementa selección de sitios, extracción de PNG ni
descarga de efemérides (PB-01, PB-02, PB-04).

## Ejecutar

Node.js 22 o posterior. Desde la raíz del repositorio:

```bash
npm ci
npm run build
npm test
npm start
```

Escucha en `127.0.0.1:3000`. Configurable con `HOST` y `PORT`.
Los siete productos normalizados y PNG web están versionados; el servidor no
requiere Python, red científica ni el paquete original.

Para preparar de nuevo los datos recibidos (Python 3, sin dependencias externas):

```bash
python3 scripts/prepare_data.py --source drive-download-20261114T150317Z-1-001/datos/fase1
```

El adaptador valida series finitas, cobertura horaria, observadores compatibles,
marcos de azimut, máscaras regulares, y cabeceras PNG de 16 bits y hasta 1,5 MB.
Conserva metadatos y hashes SHA-256. No recalcula la ciencia ni reutiliza los
booleanos de disco entregados: TypeScript calcula la visibilidad estricta.
La carpeta original permanece intacta e ignorada por Git para no incorporar
cientos de MB de GeoTIFF y archivos históricos.

## Contrato REST

| Ruta | Resultado |
| --- | --- |
| `GET /health` | Salud del proceso |
| `GET /sites` | IDs, coordenadas, alturas y cobertura disponible |
| `GET /sites/:site_id` | JSON maestro PB-05 |
| `POST /analyses` | Mismo análisis con parámetros en JSON |
| `GET /sites/:site_id/export?format=json` | JSON maestro |
| `GET /sites/:site_id/export?format=csv` | Ventanas en CSV |
| `GET /assets/heightmaps/:file` | PNG web de 16 bits |

Ejemplo:

```bash
curl 'http://127.0.0.1:3000/sites/Site01?observer_height_m=5&step_hours=6'
curl -X POST http://127.0.0.1:3000/analyses -H 'Content-Type: application/json' -d '{"site_id":"Site01","start_utc":"2026-11-14T00:00:00Z","end_utc":"2026-11-16T00:00:00Z","step_hours":1}'
```

Parámetros opcionales: `observer_height_m` (2 por defecto; 2 o 5),
`start_utc`, `end_utc` (UTC exacto `YYYY-MM-DDTHH:mm:ssZ`, alineados a muestras),
`step_hours` (entero 1–24, por defecto 1). Inicio anterior al fin; rango máximo
limitado a los datos disponibles. No se aceptan coordenadas arbitrarias ni
parámetros desconocidos. No se guardan trabajos.
Errores JSON `{ "error": "..." }`: 400 entrada inválida, 404 sitio/recurso
inexistente, 422 sin cobertura; 500 error interno sin revelar rutas.

El maestro incluye `site_id`, `coordinates`, `target`, `horizon_mask` (pares
angulares), `ephemeris_timeline` (UTC, Sol, Tierra y `conditions` con
`sun_visible`, `earth_visible`, `co_visibility`), `heightmap_url`, metadatos
del terreno, altura, ventanas, métricas, resolución y procedencia. Esquema de
salida principal en `src/schema.ts`; entradas validadas por Fastify.

## Criterios y límites

- PB-05 implementado: cada centro se compara mediante `elevation > H(azimuth)`;
  igualdad es falso. Interpolación lineal circular O(1), incluido 359° → 0°.
  Se recalculan condiciones, ventanas y métricas bajo esa regla; no se copian
  resultados con criterios de disco de la entrega original.
- Ventanas por muestreo: estado constante hasta la siguiente hora, intervalo
  semiabierto, recortado al fin solicitado. Se marcan extremos truncados. No se
  refinan cruces; pueden perderse eventos entre muestras. Métricas como fracción
  de muestras horarias, no disponibilidad operacional ni duración exacta.
- El paso solo reduce el timeline devuelto; las ventanas conservan paso horario.
  El fin solicitado puede no aparecer en el timeline si no coincide con el paso.
- Cobertura recibida: 2026-11-01T00:00:00Z a 2026-12-31T23:00:00Z (1464 muestras).
  Los siete IDs se conservan: no se inventan nombres de misiones ni equivalencias
  con Shackleton o De Gerlache. La elección oficial de tres corresponde a PB-01.
- Máscaras: 3600 direcciones a 0,1°, mayor resolución que las 360 de PB-03.
  PB-03: generador recibido conservado en `python/horizon`; revisar
  [instrucciones](python/README.md). Regeneración completa y validación científica
  independiente pendientes; no se afirma haber recalculado los rayos.
- PB-06 parcial: selección instantánea de máscaras precalculadas a 2 y 5 m.
  A 5 m se reutilizan ángulos Horizons del observador a 2 m: aproximación
  declarada en `resolution.height_method`. Alturas arbitrarias, incluido 10 m,
  requieren regenerar horizontes y validar efemérides; no se aplica una
  corrección angular inventada.
- Cuatro PNG cubren 16 km, tres 20 km. Escala vertical, orientación y coordenadas
  del observador se preservan; el centro del tile no es el punto de observación.
  La validación de insumos no certifica precisión científica ni cumplimiento
  completo de PB-01/PB-02/PB-04.
- Visibilidad geométrica no garantiza energía ni un enlace de comunicación.
  Prototipo de demostración, no planificación de vuelo certificada.

## Organización

`src/domain.ts`: lógica pura. `src/repository.ts`: archivos precalculados.
`src/app.ts`: HTTP y validación. `scripts/prepare_data.py`: adaptación Python.
`data/sites`: entradas normalizadas. `public/heightmaps`: recursos web.
`python/horizon`: código científico recibido para PB-03.

Las pruebas cubren interpolación circular, igualdad, ventanas cortas y
truncadas, oclusión, ambos perfiles de los siete sitios, rutas, errores,
exportación y descarga PNG. No añaden frontend ni infraestructura de persistencia.
