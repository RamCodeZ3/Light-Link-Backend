# Light Link Backend

Backend TypeScript + Fastify para PB-05 de Aram, con preparación de datos en
Python. Incluye soporte limitado de PB-06 y conserva el generador recibido de
PB-03 (Adrian / Aram). La ampliación de sitios nuevos añade análisis automático
con LOLA local y efemérides NASA/JPL Horizons; no selecciona sitios oficiales
ni certifica su seguridad para aterrizaje.

El prototipo inicial se desarrolló en 48 horas durante el hackathon NASA Space Apps.

## Fuentes de datos

- **Topografía lunar.** Los modelos digitales de elevación de LOLA, el altímetro
  de Lunar Reconnaissance Orbiter, se usan para generar las máscaras de horizonte
  y los mapas de elevación. [Productos LOLA de NASA/GSFC](https://pgda.gsfc.nasa.gov/products/78).
- **Efemérides.** NASA/JPL Horizons proporciona el azimut y la elevación del Sol
  y la Tierra vistos desde cada sitio lunar. El backend usa esos ángulos y las
  máscaras de horizonte para calcular las ventanas de co-visibilidad.
  [API de NASA/JPL Horizons](https://ssd-api.jpl.nasa.gov/doc/horizons.html).
- **Sitios precalculados.** Los siete sitios iniciales proceden del paquete
  `datos/fase1` recibido por el equipo. Los productos normalizados y sus metadatos
  de procedencia se guardan en [`data/sites`](data/sites).

## Ejecutar

Node.js 22 o posterior. Desde la raíz del repositorio:

```bash
npm ci
npm run build
npm test
npm start
```

Escucha en `127.0.0.1:3000`. Configurable con `HOST` y `PORT`.
Los siete productos normalizados y PNG web están versionados; su consulta no
requiere Python, red científica ni el paquete original. El análisis de sitios
nuevos sí necesita Python, los GeoTIFF y acceso a NASA/JPL (ver más abajo).

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
| `POST /analyses` | Análisis con parámetros en JSON; generación automática para sitios nuevos |
| `GET /sites/:site_id/export?format=json` | JSON maestro |
| `GET /sites/:site_id/export?format=csv` | Ventanas en CSV |
| `GET /assets/heightmaps/:file` | PNG precalculado de 16 bits |
| `GET /sites/:site_id/metadata` | Estado y cobertura de un sitio |
| `GET /sites/:site_id/heightmap` | PNG generado para un sitio nuevo |

Ejemplo:

```bash
curl 'http://127.0.0.1:3000/sites/Site01?observer_height_m=5&step_hours=6'
curl -X POST http://127.0.0.1:3000/analyses -H 'Content-Type: application/json' -d '{"site_id":"Site01","start_utc":"2026-11-14T00:00:00Z","end_utc":"2026-11-16T00:00:00Z","step_hours":1}'
```

Parámetros opcionales: `observer_height_m` (2 por defecto; 2 o 5),
`start_utc`, `end_utc` (UTC exacto `YYYY-MM-DDTHH:mm:ssZ`, alineados a muestras),
`step_hours` (entero 1–24, por defecto 1). Inicio anterior al fin; rango máximo
limitado a los datos disponibles. Las coordenadas nuevas se registran mediante `POST /sites` (ver sección Redis);
el primer análisis genera sus datos automáticamente si tienen cobertura. No se aceptan
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
  PB-03 de los sitios originales: generador recibido conservado en `python/horizon`; revisar
  [instrucciones](python/README.md). Regeneración completa y validación científica
  independiente pendientes; no se afirma haber recalculado los rayos.
- PB-06 parcial en sitios originales: selección de máscaras precalculadas a 2 y 5 m.
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

## Registro de nuevos sitios y Redis

Ampliación solicitada por el equipo: se pueden registrar sitios por coordenadas.
Configura un Redis existente mediante `REDIS_URL` antes de iniciar la API:

```bash
REDIS_URL=redis://127.0.0.1:6379 SITE_CACHE_TTL_SECONDS=86400 npm start
```

Para desarrollo, si tienes Docker disponible:

```bash
docker run --rm --name light-link-redis -p 127.0.0.1:6379:6379 redis:7.4
```

`SITE_CACHE_TTL_SECONDS`: entero entre 1 y 2592000 segundos; por defecto 86400
(24 h). Es caché: los sitios personalizados desaparecen al expirar o si Redis
pierde sus datos. Sobreviven al reinicio de la API mientras permanezcan en Redis.
Los archivos de los sitios precalculados siguen siendo su fuente de datos.
No hay respaldo persistente de los registros nuevos.

```bash
curl -X POST http://127.0.0.1:3000/sites \
  -H 'Content-Type: application/json' \
  -d '{"name":"Punto de exploración","coordinates":{"latitude":-89.5,"longitude":-137.5}}'
```

El ejemplo es ilustrativo; no define un sitio científicamente validado.
Respuesta `201` al crear, `200` si ya existe el mismo registro en caché:

```json
{
  "site_id": "custom_<identificador derivado de coordenadas>",
  "name": "Punto de exploración",
  "coordinates": {"latitude": -89.5, "longitude": 222.5},
  "status": "pending_data",
  "created_at_utc": "...",
  "expires_at_utc": "...",
  "missing_data": ["horizon_mask", "ephemeris_timeline", "heightmap_and_metadata"]
}
```

Latitud admitida: [-90°, 90°]; longitud de entrada: [-180°, 360°], positiva al
este, normalizada a [0°, 360°). Nombre obligatorio de hasta 120 caracteres.
Se asigna un ID determinista; no se sobrescriben los sitios originales ni se
modifica el nombre o TTL del primer registro al repetir las coordenadas.

- `GET /sites`: agrega los registros nuevos a los sitios precalculados.
- `GET /sites/:site_id/metadata`: devuelve estado y coordenadas. Los originales
  tienen estado `ready`, los nuevos `pending_data`.
- `GET /sites/:site_id`, `POST /analyses` y exportación: generan el producto
  automáticamente si falta o no cubre rango/altura; `404` si el registro expiró.
- Sin `REDIS_URL`, el registro devuelve `503`; los siete sitios originales
  siguen disponibles. Con Redis configurado, la API comprueba la conexión al
  iniciar. Si Redis cae después, las operaciones que dependen de él devuelven
  `503`; el análisis de sitios precalculados sigue disponible.

**Implementado:** registro, consulta, deduplicación, TTL y análisis automático.
Registrar un sitio lo deja en `pending_data`; solicitar su primer análisis
activa el procesamiento Python y cambia a `ready` cuando se publica el producto
completo. No se genera nada al registrar, ni se reutiliza la máscara de otro punto.

Prueba de integración con Redis real, aislada y sin modificar una instancia existente:

```bash
TEST_REDIS_SERVER_PATH=/ruta/a/redis-server npm test
```

Sin esa variable, se ejecutan las pruebas normales y se omite explícitamente
solo la integración Redis. El test inicia un proceso temporal sin persistencia,
verifica registro concurrente, lectura tras reiniciar la API, TTL, expiración y
fallo de Redis; al terminar elimina sus propios archivos temporales.
Cliente utilizado: [node-redis, documentación oficial](https://redis.io/docs/latest/develop/clients/nodejs/).

## Análisis automático de sitios nuevos

Instala una vez las dependencias Python (Python 3.12 o posterior):

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt
```

El servidor detecta `.venv/bin/python`; se puede elegir otro con `PYTHON_BIN`.
Debe disponer de los GeoTIFF LOLA y el DEM regional entregados; los originales
siguen ignorados por Git. Rutas de configuración:

- `LOLA_DEM_DIR`: carpeta con `*_final_adj_5mpp_surf.tif`; por defecto
  `drive-download-20261114T150317Z-1-001/datos/crudos/lola_sitios_5m`.
- `LOLA_REGIONAL_DEM`: por defecto
  `drive-download-20261114T150317Z-1-001/datos/intermedios/dem_regional/ldem_64_sur_stereo_200m.tif`.
- `REDIS_URL` y `SITE_CACHE_TTL_SECONDS`: como se describió arriba.

Flujo:

1. Registrar nombre y coordenadas con `POST /sites` y conservar el `site_id`.
2. Enviar `POST /analyses` con ese ID y fechas UTC. También funciona con
   `GET /sites/:site_id` y la ruta de exportación.
3. La primera solicitud espera al procesamiento: Python determina la altura del
   punto, calcula 360 direcciones de horizonte a 1°, genera PNG y consulta
   Horizons para Sol y Tierra desde ese punto y la altura pedida (2 o 5 m).
4. TypeScript evalúa los booleanos estrictos, ventanas y métricas. Redis guarda
   producto y PNG completos; el registro cambia a `ready` y muestra `coverage`.
5. Solicitudes con rango contenido y misma altura reutilizan ese producto.
   Cambiar de altura o ampliar fechas genera uno nuevo. Se conserva el último
   producto por sitio; cambiar solo `step_hours` no repite el procesamiento.

Ejemplo después de registrar un sitio:

```bash
curl -X POST http://127.0.0.1:3000/analyses \
  -H 'Content-Type: application/json' \
  -d '{"site_id":"ID_DEVUELTO_POR_POST_SITES","start_utc":"2026-11-14T00:00:00Z","end_utc":"2026-11-14T03:00:00Z","observer_height_m":2}'
```

Sin fechas se usa el rango del MVP: 2026-11-01T00:00:00Z a
2026-12-31T23:00:00Z. Rango máximo: 62 días, hasta 1489 muestras horarias;
UTC alineado a horas. El paso 1–24 h solo reduce la salida. No hay trabajos
persistidos ni cola; la solicitud espera hasta 240 segundos. Ajustar el timeout
del cliente/proxy a este flujo. Las solicitudes iguales en una instancia
comparten el cálculo. Redis impide procesar el mismo sitio simultáneamente en
otras instancias mediante un bloqueo de 300 segundos con token de propietario.
Cada instancia permite calcular un sitio a la vez; otro sitio recibe `429`.

Publicación atómica: se guardan estado, producto y PNG únicamente al finalizar.
Una generación fallida conserva el producto anterior si existe. Un éxito renueva
el TTL del registro y producto; repetir consultas que ya están en caché no lo
renueva. El PNG dinámico se sirve en `heightmap_url` con `no-store` para respetar
la expiración. No hay archivos generados permanentes fuera de Redis.

Errores adicionales:

| HTTP | Significado |
| --- | --- |
| 400 | Fechas inválidas, rango mayor de 62 días o parámetros no admitidos |
| 409 | Otro proceso calcula el sitio o expiró el bloqueo durante el cálculo |
| 422 | Falta cobertura topográfica suficiente para ese punto |
| 429 | La instancia está calculando otro sitio; reintentar después |
| 502 | Fallo de Horizons o respuesta incompatible/incompleta |
| 503 | Redis, DEM o entorno Python no disponibles |
| 504 | El procesamiento superó 240 segundos |

### Cobertura y precisión

La generación utiliza los DEM locales de 5 m disponibles: no cubre cualquier
coordenada lunar. Exige un punto con al menos 100 m de margen en un tile y datos
continuos cercanos. Para terreno lejano exige cobertura continua hasta 150 km en
todas las direcciones. Fuera de esa cobertura devuelve `422` sin inventar
alturas ni sustituir el horizonte por uno plano. No descarga automáticamente
nuevos DEM; pueden incorporarse más archivos compatibles a `LOLA_DEM_DIR`.

El observador permanece en las coordenadas solicitadas. El horizonte usa
geodésicas esféricas y curvatura lunar, paso de 5 m, refinamiento a 1 m en los
primeros 500 m, y capa regional a 100 m hasta 150 km. Donde hay DEM local se
prioriza frente al regional. Resolución angular: 1° (360 muestras), no los 0,1°
de las máscaras originales. No se ha comprobado convergencia más allá de 150 km;
pueden perderse picos entre direcciones o muestras. La transición entre DEM puede
tener diferencias de altura. Estas limitaciones figuran en `provenance`.

El PNG de 512 × 512 es de 16 bits y cubre un cuadrado centrado en el punto,
recortado a la superficie disponible, con máximo de 20 km de lado; la extensión
real, orientación y escala vertical se incluyen en `heightmap`. No se exige que
todos los sitios nuevos dispongan de 20 km de terreno local.

Horizons se consulta secuencialmente por HTTPS, con timeout y un reintento;
se comprueban centro lunar, radio, marco MEAN_ME, coordenadas, altura, fechas y
cantidad de muestras. Para sitios nuevos a 5 m se consultan efemérides a 5 m;
la aproximación de reutilizar ángulos de 2 m queda limitada a los archivos
precalculados originales. Se guardan parámetros, firma del proveedor, fecha de
consulta y hashes SHA-256. La compatibilidad de marcos MOON_ME/DE421 y MEAN_ME
sigue el criterio de los datos entregados; falta validación científica
independiente, así como evaluación de incertidumbre específica de cada punto.

Fuentes: [API NASA/JPL Horizons](https://ssd-api.jpl.nasa.gov/doc/horizons.html)
y [DEMs LOLA NASA/GSFC](https://pgda.gsfc.nasa.gov/products/78).

### Verificación

```bash
npm run build
npm run test:python
TEST_REDIS_SERVER_PATH=/ruta/a/redis-server npm test
TEST_REDIS_SERVER_PATH=/ruta/a/redis-server npm run test:live
```

Las pruebas Python usan terreno y respuestas sintéticas identificadas para
comprobar geometría, cobertura, NoData y rechazo de respuestas incorrectas.
Las pruebas TypeScript/Redis verifican generación bajo demanda, concurrencia,
reutilización tras reiniciar la API, cambio de altura, exportación y expiración.
`test:live` consulta realmente Horizons y los DEM locales para un punto nuevo,
comprueba alturas de 2 y 5 m, descarga PNG, reutiliza caché y rechaza un punto
sin cobertura. Su evidencia se escribe en `/tmp/light-link-automatic-smoke.json`;
los resultados no se versionan ni se sustituyen silenciosamente por mocks.

## Despliegue en Vercel

Configurado para Vercel Container Runtime (beta), manteniendo Node.js y Python
juntos. La [guía de despliegue](deployment/README.md) explica Redis externo,
variables y despliegue mediante Git o Vercel CLI. Desde Git, la construcción
obtiene los DEM desde NASA y verifica sus hashes automáticamente; con CLI
puede reutilizar el paquete local ya preparado.

`npm run deploy:prepare` prepara una variante para Hobby con los DEM de las tres
regiones del MVP (Site01, Site04 y Site11), comprimidos sin pérdida. Los siete
sitios precalculados siguen disponibles; la cobertura automática nueva queda
limitada a esas tres huellas. `npm run deploy:prepare:full` conserva los siete
DEM y requiere capacidad de subida mayor. Los paquetes no se guardan en Git.
