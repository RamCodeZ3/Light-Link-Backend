# Desplegar el backend completo en Vercel

Preparación para **Vercel Container Runtime (beta)**. Conserva en un solo
contenedor Fastify/Node.js 22, Python 3.12, LOLA y el análisis automático.
Redis debe ser una instancia externa accesible por TCP/TLS.
Esta preparación no publica cambios en tu cuenta; Preview y Production se
validan al desplegar.

## 1. Preparar los datos en esta computadora

Desde la raíz, con el paquete original todavía disponible:

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt
npm run deploy:prepare
npm run deploy:verify
```

`deploy:prepare` crea `.deployment/science/`, ignorada por Git pero incluida
expresamente en la subida de Vercel CLI. Verifica los hashes originales y
comprime los TIFF sin pérdida: comprueba igualdad de todos los píxeles y
conserva CRS, transformaciones, dimensiones, NoData y tipo de datos. El
manifiesto registra tanto el hash del original como el del archivo comprimido.
La preparación local no cambia los datos originales ni recalcula el DEM regional.
Si el paquete local no existe al construir desde Git, se descargan los tres
GeoTIFF originales y el DEM global de NASA, verificando sus SHA-256; se
reconstruye entonces el DEM regional con el mismo remuestreo de la entrega.

La variante predeterminada incluye los DEM de **Site01, Site04 y Site11**,
además del DEM regional: aproximadamente 84,5 MiB de ciencia y unos 95 MiB con
el código y recursos web. Está pensada para el límite de subida de fuentes
por CLI de Hobby. Se siguen sirviendo los **siete sitios precalculados**; el
análisis de coordenadas nuevas en esta variante solo cubre las huellas de esos
tres DEM de alta resolución. Fuera de ellas devuelve `422`.

Para conservar la cobertura automática de los siete DEM:

```bash
npm run deploy:prepare:full
npm run deploy:verify
```

La variante completa ocupa unos 413 MiB de datos y supera el límite de subida
CLI de Hobby. Requiere un plan con capacidad suficiente (la documentación indica
1 GB de fuentes para Pro). No añade esos archivos al historial de Git.

## 2. Crear/configurar el proyecto de Vercel

Usar una versión actual de Vercel CLI que soporte Container Runtime:

```bash
npx vercel@latest login
npx vercel@latest link
```

En Settings del proyecto:

- Framework Preset: **Container**. `vercel.json` ya lo declara y
  `Dockerfile.vercel` evita la detección automática como Fastify puro.
- Habilitar Fluid Compute y configurar duración de al menos **300 segundos**:
  el proceso Python tiene un límite interno de 240 segundos.
- Verificar disponibilidad de Container Runtime y capacidad de imagen en la
  cuenta; el runtime está en beta. La imagen contiene librerías científicas y
  supera el tamaño de una función Node.js estándar. Aplican los límites del
  runtime/plan y, cuando corresponda, de Large Functions.
- Dejar los comandos y directorio de salida en los valores del preset Container;
  el Dockerfile instala, compila y arranca el servidor.

Configurar estas variables en Preview y Production según el entorno:

| Variable | Valor |
| --- | --- |
| `REDIS_URL` | URL TCP/TLS del proveedor, por ejemplo `rediss://default:CONTRASEÑA@HOST:6379` |
| `SITE_CACHE_TTL_SECONDS` | `86400`, o el TTL acordado |

No usar la URL REST de Redis ni `localhost`. Redis no se ejecuta dentro de este
contenedor. No guardar credenciales en Git; `.env.example` solo tiene marcadores.
Es preferible usar instancias Redis diferentes para Preview y Production para
no compartir registros/caché accidentalmente.

El Dockerfile define `HOST=0.0.0.0`, `PORT=80`, `PYTHON_BIN` y las rutas LOLA.
No configurar las rutas locales de esta computadora en Vercel. Si se cambia
`PORT` en el proyecto, el servidor usa ese valor.

## 3. Subir un preview desde esta computadora

```bash
npm run build
npm test
npm run deploy:verify
npx vercel@latest deploy
```

También se puede desplegar desde **Git**. El repositorio conserva únicamente
`.deployment/.gitkeep`; la etapa `science-build` detecta que no hay paquete
local, descarga los tres DEM del MVP desde NASA/GSFC y el DEM global
`ldem_64.tif` del CGI Moon Kit, y verifica sus hashes contra los registrados.
Después reconstruye el DEM regional de 200 m con el mismo remuestreo de la
entrega y comprime el paquete sin pérdida. No hace falta subir los DEM a Git
ni preparar archivos en el servidor de Vercel manualmente.

El primer build desde Git descarga aproximadamente **1,2 GB** y depende de la
disponibilidad de NASA. Tiene timeout por conexión, hasta tres intentos por
archivo y comprobación SHA-256 obligatoria. Si la fuente falla o cambia, el
build falla con un error explícito; no se generan datos ficticios. Los cambios
del código TypeScript no invalidan por sí solos la etapa científica, aunque
Vercel puede descartar su caché. Los originales descargados se eliminan antes
de terminar esa etapa; la imagen final solo incorpora el paquete preparado.

Si se usa CLI y hay un paquete local válido, se reutiliza sin descargar ni
regenerar la ciencia. Los dos modos conservan el backend Python completo.

No usar `--prod` hasta verificar el preview. El comando de producción, cuando
se decida publicar, es `npx vercel@latest deploy --prod`.

## 4. Comprobar el preview

```bash
curl https://TU-PREVIEW.vercel.app/health
curl https://TU-PREVIEW.vercel.app/sites
curl -X POST https://TU-PREVIEW.vercel.app/sites \
  -H 'Content-Type: application/json' \
  -d '{"name":"Prueba de integración","coordinates":{"latitude":-89.46,"longitude":222.45}}'
```

Con el ID devuelto:

```bash
curl -X POST https://TU-PREVIEW.vercel.app/analyses \
  -H 'Content-Type: application/json' \
  -d '{"site_id":"ID_DEVUELTO","start_utc":"2026-11-14T00:00:00Z","end_utc":"2026-11-14T03:00:00Z","observer_height_m":2}'
```

Debe devolver `200` con 360 muestras de horizonte y cuatro muestras horarias.
Consultar `heightmap_url` y repetir el análisis para verificar la caché.
El dominio puede tener Deployment Protection; en ese caso usar la autenticación
que configure el propietario del proyecto. Las rutas mantienen sus nombres,
sin prefijo `/api` ni reescrituras a servicios externos.

## Contenedor local

```bash
docker build -f Dockerfile.vercel -t light-link-backend .
docker run --rm -p 3000:80 -e REDIS_URL=redis://TU_REDIS:6379 light-link-backend
```

También puede usarse Podman. La imagen final incluye solo dependencias Node de
producción, Python, DEM seleccionados, JSON y PNG web; excluye la descarga
original, `.venv`, documentos locales y credenciales. `deploy:verify` se ejecuta
además durante la construcción de la imagen para detectar datos incompletos.

## Referencias oficiales

- Container Runtime: https://vercel.com/docs/functions/runtimes/container
- Límites de subida CLI: https://vercel.com/docs/limits
- Límites de funciones: https://vercel.com/docs/functions/limitations
- Exclusiones de CLI: https://vercel.com/docs/deployments/vercel-ignore

Documentación consultada el 14 de noviembre de 2026. La validación final en
Vercel depende de la cuenta, el plan, el runtime habilitado y las variables del
proyecto. Las pruebas locales del contenedor no sustituyen esa validación.

## Verificación local realizada

Se construyó la imagen con Podman y se levantó con un Redis temporal real.
Se verificaron por HTTP los siete sitios precalculados, registro de un punto
nuevo, análisis con LOLA y NASA/JPL, reutilización de Redis y PNG de 16 bits.
El ejemplo de cuatro muestras devolvió `200`: primera generación ~12,3 s,
consulta en caché ~0,011 s. Son mediciones locales, no garantías de Vercel.
Compilación TypeScript y las seis pruebas de API/Redis aprobadas. Imagen local
aproximadamente 735 MiB; fuentes seleccionadas aproximadamente 95 MiB.

También se probó una construcción sin `.deployment/science`, equivalente a un
checkout de Git: descargó las fuentes NASA, verificó sus hashes y terminó la
imagen. La reconstrucción regional comparada con la entrega original tuvo
**0 m de diferencia máxima** en todos sus píxeles, con el mismo CRS y transform.
Las nueve pruebas Python incluyen rechazos por checksum incorrecto y tamaño
excesivo en las descargas.

## El build pasa pero la aplicación termina con código 1

El resumen «La aplicación salió con el código 1» no identifica la excepción.
Abrir el evento de Runtime Logs y consultar stdout/stderr. El servidor emite
un objeto `startup_failed` con un código y mensaje sin URL ni credenciales:

- `REDIS_URL_PROTOCOL`: se usó HTTP/HTTPS; el cliente necesita `redis://` o
  `rediss://`. La URL HTTPS de Upstash corresponde a REST.
- `REDIS_URL_INVALID`: URL mal formada.
- `REDIS_AUTH_FAILED`: usuario o contraseña rechazados.
- `REDIS_CONNECTION_FAILED`: host/puerto/TLS/red no disponibles.
- `REDIS_TTL_INVALID`: TTL no válido.
- `EADDRINUSE`, `EACCES`, `ERR_SOCKET_BAD_PORT`: revisar el puerto del servidor.

Redis se conecta antes de abrir HTTP: una configuración inválida puede impedir
que respondan incluso las rutas de salud. Corregir las variables en el entorno
correspondiente (Preview o Production) y volver a desplegar. No publicar las
credenciales en los logs ni en el chat.

Para comprobar la API usar `/health` y `/sites`. `/sitio` no es una ruta del
contrato y `/` no tiene una página web; normalmente devuelven 404, no deben
terminar el proceso. Una caída al solicitar esas rutas apunta al arranque,
no confirma por sí misma un problema de enrutamiento.
