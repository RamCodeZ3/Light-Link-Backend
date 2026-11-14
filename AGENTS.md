# Lunar Co-Visibility Explorer — instrucciones del proyecto

## Contexto y prioridades

Proyecto para una competencia / hackathon NASA Space Apps, inspirado en la planificación de misiones CLPS al polo sur lunar. La herramienta permite comparar sitios y fechas de aterrizaje según la visibilidad del Sol y de la Tierra sobre el horizonte local.

La prioridad es conseguir un flujo completo que funcione para la demostración. Mantener una arquitectura decente, sencilla y ampliable, sin sacrificar la entrega por abstracciones o infraestructura prematuras. Preferir un monolito modular y datos precalculados antes que microservicios y procesamiento distribuido.

El alcance actual del equipo es el **backend**. No implementar frontend ni procesamiento científico adicional por iniciativa propia. La solicitud que originó este archivo autoriza documentar el proyecto; no supone autorización para comenzar su implementación.

Comunicarse en español. Antes de cambios importantes, explicar brevemente el objetivo. Diferenciar siempre lo implementado, lo propuesto y lo pendiente de validar.

## Objetivo funcional

Entregar al frontend datos ligeros para evaluar:

- Visibilidad geométrica del Sol, como indicador inicial de disponibilidad de iluminación.
- Visibilidad geométrica de la Tierra, como indicador inicial de línea de vista para comunicación directa (DTE).
- Ventanas de co-visibilidad: períodos donde ambos cuerpos son visibles.
- Comparaciones entre sitios o entre rangos temporales del mismo sitio.
- Exportaciones CSV y JSON con inicio, fin y duración de las ventanas.

No presentar visibilidad solar como generación eléctrica suficiente, ni visibilidad terrestre como enlace de comunicaciones garantizado. Un modelo de batería requiere consumo, capacidad, eficiencia y orientación de paneles; un enlace operativo requiere condiciones de antena, estación terrestre y presupuesto de enlace.

## Tecnología y arquitectura propuesta

TypeScript es la preferencia del usuario para el backend. Node.js + Fastify es la propuesta de trabajo discutida, todavía susceptible de ajuste antes de implementar.

- Fastify recibe solicitudes HTTP, valida entradas, llama a la lógica y entrega JSON; no realiza por sí mismo los cálculos científicos.
- REST es suficiente para el MVP; añadir WebSockets solo si aparece una necesidad concreta.
- Separar rutas/validación, lógica de dominio y acceso a datos mediante módulos sencillos.
- Usar esquemas de entrada y salida y documentar el contrato, idealmente con OpenAPI.
- Comenzar con archivos precalculados y versionados. Incorporar una base de datos solo si un requisito real lo justifica.
- Evitar dependencias científicas o librerías astronómicas sin comprobar su soporte para observadores lunares y marcos de referencia.
- El procesamiento pesado de topografía puede ejecutarse previamente con herramientas adecuadas y producir archivos consumidos por el backend.

## Datos científicos

**LOLA** (Lunar Orbiter Laser Altimeter) es el altímetro láser de Lunar Reconnaissance Orbiter. Sus datos permiten construir modelos digitales de elevación (DEM): cuadrículas de alturas del terreno lunar.

**Efemérides** son posiciones de cuerpos celestes a lo largo del tiempo. Necesitamos el azimut y la elevación del Sol y la Tierra vistos desde el sitio lunar seleccionado.

Fuentes previstas:

- LOLA DEM para topografía y generación de máscaras de horizonte.
- JPL Horizons para efemérides, o resultados precalculados mediante SPICE.
- SPICE no debe asumirse como una dependencia nativa de TypeScript; investigar su integración si resulta necesaria.

Documentación primaria:

- https://ssd-api.jpl.nasa.gov/doc/horizons.html
- https://ssd.jpl.nasa.gov/horizons/manual.html
- https://naif.jpl.nasa.gov/naif/toolkit
- https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/

No inventar coordenadas, máscaras ni efemérides y presentarlas como reales. Los mocks deben identificarse explícitamente, y los datos reales deben registrar fuente, versión y cobertura.

## Modelo matemático

Para un sitio fijo, H(azimut) representa la máxima elevación angular del terreno en esa dirección. En cada instante t:

```text
sun_visible(t)   = sun_elevation(t) > H(sun_azimuth(t))
earth_visible(t) = earth_elevation(t) > H(earth_azimuth(t))
co_visibility(t) = sun_visible(t) && earth_visible(t)
```

La comparación estricta anterior sigue el SRS inicial. Cualquier margen o cambio debe quedar explícito y documentado.

- Cada cuerpo usa el horizonte correspondiente a su propio azimut.
- La máscara prevista tiene 360 a 3600 muestras: resoluciones de 1° a 0.1°.
- Resolver la interpolación entre muestras y la continuidad de 359° a 0°.
- Una máscara regular admite acceso por índice e interpolación entre vecinos en O(1).
- Definir cómo se agrupan ventanas, cómo se tratan los extremos del rango y cómo se refinan los cruces entre muestras.
- No declarar precisión temporal superior a la disponible: un paso de una hora no determina por sí solo un cruce exacto.
- La altura del observador, la curvatura lunar y la extensión del terreno analizado pueden afectar el horizonte.

Antes de validar resultados, fijar marco de referencia lunar, convención de longitud, tipo de latitud, referencia vertical, unidades, origen/sentido del azimut, altura del observador, tratamiento del centro o disco de cada cuerpo y convenciones temporales. Usar UTC en el contrato externo y documentar las conversiones que requiera el proveedor científico.

## MVP y responsabilidades

Empezar por tres sitios predefinidos con máscaras y efemérides precalculadas. El soporte de coordenadas arbitrarias es una ampliación: requiere datos topográficos y máscara específicos para cada ubicación.

Responsabilidad descrita para **Aram — Lógica Algorítmica y Soporte de Backend**:

1. Implementar la lógica pura de visibilidad y co-visibilidad.
2. Estructurar y servir endpoints REST/JSON.
3. Validar elevación y azimut para sitios predeterminados mediante referencias verificables.
4. Detectar ventanas y preparar métricas y exportaciones.

Debe aclararse quién generará las máscaras LOLA y las efemérides. No asumir que esa tarea está resuelta ni que pertenece automáticamente a Aram.

Hitos originales:

1. Datos: preparar heightmaps y máscaras de horizonte de tres sitios.
2. Backend: servir datos y calcular condiciones y ventanas.
3. Frontend: integrar terreno, iluminación y timeline.
4. Integración y presentación: modos de uso, comparaciones y escenario de demostración.

## Contrato inicial del SRS

Solicitud ilustrativa; sus coordenadas e identificador no son un sitio científicamente validado:

```json
{
  "site_id": "shackleton_rim_01",
  "coordinates": { "latitude": -89.9, "longitude": 0.0 },
  "time_range": {
    "start_utc": "2026-11-14T00:00:00Z",
    "end_utc": "2026-12-14T00:00:00Z",
    "step_hours": 1
  }
}
```

El rango de pasos solicitado originalmente es de una hora a un día. Definir límites de rango y cantidad de muestras antes de exponer el servicio. Si se admiten `site_id` y coordenadas juntos, definir su precedencia o rechazar inconsistencias.

Respuesta ilustrativa; los valores son ejemplos, no resultados científicos:

```json
{
  "site_id": "shackleton_rim_01",
  "horizon_mask": [
    { "azimuth_deg": 0.0, "max_elevation_deg": 2.4 },
    { "azimuth_deg": 1.0, "max_elevation_deg": 3.1 }
  ],
  "ephemeris_timeline": [
    {
      "timestamp_utc": "2026-11-14T00:00:00Z",
      "sun": { "azimuth_deg": 145.2, "elevation_deg": 1.1 },
      "earth": { "azimuth_deg": 32.0, "elevation_deg": 6.4 },
      "conditions": {
        "sun_visible": false,
        "earth_visible": true,
        "co_visibility": false
      }
    }
  ],
  "heightmap_url": "/assets/heightmaps/shackleton_20x20_16bit.png"
}
```

El contrato definitivo debe contemplar ventanas, métricas, resolución, procedencia y cobertura de datos. El heightmap necesita metadatos de escala horizontal/vertical y orientación para interpretarse correctamente.

Rutas discutidas como ejemplos, aún no implementadas ni definitivas:

- `GET /sites`
- `POST /analyses`
- `GET /analyses/:id/export` si se decide conservar análisis identificables.

No introducir persistencia de trabajos únicamente para conservar estas rutas de ejemplo.

## Contexto del frontend para la integración

El frontend previsto usa Three.js y posiblemente React. Tiene dos modos que conservan sitio y fecha al alternar:

- Misión: comparación lado a lado, curvas angulares, métricas y exportaciones.
- Explorador: indicadores simplificados de iluminación/enlace y tiempo hasta el próximo cambio. Los indicadores de batería serían ilustrativos salvo que exista un modelo energético.

Incluye timeline con reproducción 1×, 10× y 100×, selección de sitios y presets de misiones. Las coordenadas y el estado de las misiones deben verificarse antes de publicarlas.

La escena plantea un terreno local de 20 × 20 km mediante heightmap PNG de 16 bits, luz direccional según el Sol y representación de la Tierra. La máscara científica puede necesitar terreno fuera de esa extensión. Las sombras del visor son una representación visual y no sustituyen el cálculo de visibilidad.

Para gráficos temporales comparar elevaciones con `H(sun_azimuth(t))` y `H(earth_azimuth(t))`. Una máscara graficada contra azimut no comparte el eje temporal de las efemérides.

Objetivos originales del cliente: 60 FPS, interacción menor a 16 ms, carga inicial de hasta 5 MB, heightmap de hasta 1.5 MB por sitio y navegadores con WebGL 2.0. Son objetivos a medir; no son garantías del backend. Descargar series y reproducir localmente evita depender de solicitudes por frame.

## Investigación pendiente, en orden

1. Confirmar responsables y disponibilidad de máscaras y efemérides.
2. Elegir tres sitios con coordenadas y fuentes verificadas.
3. Probar consultas Horizons desde superficie lunar para Sol y Tierra; revisar formato, cobertura y límites.
4. Acordar convenciones científicas compatibles entre todas las fuentes.
5. Identificar el producto LOLA DEM: resolución, proyección, unidades, cobertura y valores sin datos.
6. Definir generación de horizonte: distancia de búsqueda, curvatura, altura del observador y resolución.
7. Definir interpolación y precisión de ventanas.
8. Obtener casos de referencia y tolerancias de validación.

## Criterios de implementación y verificación

- Priorizar un recorrido demostrable de extremo a extremo antes de ampliar funcionalidades.
- Mantener la lógica matemática pura y separada del servidor para poder verificarla fácilmente.
- Probar casos relevantes: visibilidad continua, oclusión total, igualdad con el horizonte, azimut circular, ventanas cortas y ventanas cortadas por el rango.
- Validar entradas, fechas, coordenadas, pasos y cobertura; devolver errores claros ante datos faltantes.
- No sustituir datos faltantes por valores inventados silenciosamente.
- Registrar limitaciones y precisión del MVP; no presentar el prototipo como herramienta certificada de planificación de vuelo.
- No añadir autenticación, colas, Redis, bases de datos, despliegues complejos ni abstracciones genéricas sin una necesidad concreta.
- Cuando se autorice implementar, usar pruebas proporcionadas al riesgo y verificar el flujo principal. Vitest es una opción propuesta, no una dependencia instalada.
