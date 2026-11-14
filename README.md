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
limitado a los datos disponibles. Los análisis requieren un sitio con datos precalculados; las coordenadas nuevas
se registran mediante `POST /sites` (ver sección Redis). No se aceptan
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
- `GET /sites/:site_id`, `POST /analyses` y exportación: responden `422` para un
  sitio pendiente; `404` cuando es desconocido o su caché ya expiró.
- Sin `REDIS_URL`, el registro devuelve `503`; los siete sitios originales
  siguen disponibles. Con Redis configurado, la API comprueba la conexión al
  iniciar. Si Redis cae después, las operaciones que dependen de él devuelven
  `503`; el análisis de sitios precalculados sigue disponible.

**Implementado:** registro, consulta, deduplicación y TTL en Redis.
**Pendiente de acordar con el equipo:** entrega o generación de datos científicos
para los sitios nuevos y su incorporación al análisis. Registrar coordenadas no
produce una máscara de horizonte ni efemérides, ni reutiliza las de otro sitio.
No se ejecuta automáticamente NASA/JPL ni el procesamiento LOLA en esta ruta.

Prueba de integración con Redis real, aislada y sin modificar una instancia existente:

```bash
TEST_REDIS_SERVER_PATH=/ruta/a/redis-server npm test
```

Sin esa variable, se ejecutan las pruebas normales y se omite explícitamente
solo la integración Redis. El test inicia un proceso temporal sin persistencia,
verifica registro concurrente, lectura tras reiniciar la API, TTL, expiración y
fallo de Redis; al terminar elimina sus propios archivos temporales.
Cliente utilizado: [node-redis, documentación oficial](https://redis.io/docs/latest/develop/clients/nodejs/).
