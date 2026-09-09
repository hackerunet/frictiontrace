# walmart-cam-qa-audit

Auditoría de performance del customer journey de los 13 storefronts VTEX IO de Walmart
Centroamérica, con Playwright + Chrome DevTools. Produce la familia completa de
reportes: captura por tienda, comparativos entre corridas, resúmenes ejecutivos y
tendencia histórica.

Diseñado para correr **solo, tres veces al día**, bajo un scheduler.

---

## Idea central: evidencia inmutable, reportes vivos

Dos cosas distintas que antes vivían en la misma carpeta:

| | Qué es | Cómo se maneja |
|---|---|---|
| `reports/runs/<corrida>/` | **Evidencia.** Lo que se midió en una ejecución concreta. | Una carpeta por ejecución. Nunca se reescribe. |
| `reports/<categoría>/*.html` | **Vista.** Lectura actual de toda la evidencia. | Nombre fijo. Se reescribe en cada ejecución. |

De ahí salen las reglas que ordenan todo lo demás:

- El identificador de corrida lleva **hora**: `20260821-0600`. Con tres ejecuciones
  diarias una fecha sola no alcanza para distinguirlas — se pisarían entre sí.
- Los comparativos, resúmenes y tendencias **no llevan fecha en el nombre**. El enlace
  que guardes hoy sigue mostrando el estado actual mañana.
- **Una columna de comparación es un día, no una corrida.** Ver abajo.

`reports/index.html` es el portal: estado de la última ejecución, enlaces a cada
categoría y la lista de corridas con su detalle por tienda.

---

## Una columna es un día, no una corrida

La cifra de cada etapa es el **promedio de las lecturas de ese día**, y el encabezado dice
cuántas fueron.

Una sola lectura es una muestra de un proceso ruidoso: un mal momento del CDN, una promo
de media mañana, un GC con mala suerte. Publicarla como si describiera al día fue la
debilidad que esto reemplaza. Tres lecturas promediadas dan un punto medio que sí
describe al día — y, más útil todavía, una **dispersión** que dice si las tres
coincidieron.

La dispersión es la parte que valida el dato. Se muestra como **±** sobre la celda, con
las lecturas individuales en el tooltip, cuando difieren entre sí más de lo configurado
(`dispersionWarn`, 40% por defecto). Un promedio de tres que esconde un 4s y un 40s es
peor que no tener número; la marca es lo que impide que se esconda.

Vale la pena notar **de qué comparación se trata**: una tienda contra sí misma, el mismo
día, con el mismo método. Es la única población donde una diferencia significa algo
distinto de "son dos negocios distintos" o "son dos regímenes de medición distintos" —
que es exactamente el motivo por el que la detección de atípicos entre tiendas y entre
fechas sigue apagada.

Los reportes se regeneran **después de cada captura**, no solo al final del día. A las
06:00 dicen "1 lectura", a las 13:00 "2 lecturas", a las 20:00 "3 lecturas". El documento
está siempre al día y va ganando solidez a medida que avanza la jornada, en vez de
mentir sobre cuánta evidencia tiene detrás.

`--per-run` en el trend report deshace el colapso y muestra cada ejecución por separado,
para mirar un día de cerca.

---

## Instalación

```bash
npm install
npx playwright install chromium
cp .env.example .env    # WALMART_LOGIN / WALMART_PASS
```

Esto es para una máquina de trabajo. Para dejarlo corriendo solo en un servidor Linux,
ver *Instalación en la nube*.

**Sobre las credenciales.** `lib/env.js` busca en dos lugares, en orden: `qa-audit/.env`
y `../walmart-perf-attribution/.env`. Desde el 21 de agosto de 2026 este proyecto tiene su
propio `.env` (permisos 600), así que el pipeline **no depende de ninguna carpeta hermana**
— verificado corriéndolo aislado. El respaldo queda como red de seguridad, pero el archivo
local siempre gana.

Solo se copiaron `WALMART_LOGIN` y `WALMART_PASS`. `CRUX_API_KEY` **no** está acá a
propósito: qa-audit nunca la lee, y duplicar un secreto que no se necesita solo amplía su
exposición. Las métricas de campo (CrUX) siguen viviendo en `walmart-perf-attribution`.

---

## Uso

### El pipeline completo (lo que corre el scheduler)

```bash
npm run pipeline              # captura + todos los reportes
npm run pipeline:reports      # solo reportes, sin tocar producción
npm run pipeline:plan         # imprime el plan y no ejecuta nada
```

Opciones útiles de `bin/run-all.js`:

| Flag | Para qué |
|---|---|
| `--run <id>` | Fuerza el id de corrida en vez de derivarlo del reloj |
| `--skip-capture` | Regenera reportes desde las corridas ya en disco |
| `--only a,b` / `--skip a,b` | Ejecuta o salta pasos por id |
| `--stores walmart-cr,paiz-gt` | Acota la captura a un subconjunto |
| `--dry-run` | Muestra el plan sin ejecutar |

Ids de paso: `capture`, `comparativo`, `consolidado`, `ejecutivos`, `tendencias`, `index`.

### Pasos sueltos

```bash
npm run capture -- --stores walmart-cr     # una tienda
npm run capture -- --handoff               # asistido: la persona cierra el tramo final
npm run report:comparativo
npm run report:consolidado
npm run report:ejecutivos
npm run report:trend
npm run report:index
npm run report:historico                   # registro fijo del episodio de agosto
npm run report:render -- --run 20260820    # re-renderiza HTML/CSV desde el JSON
npm run runs                               # lista las corridas visibles
npm run prune                              # simula la poda de corridas viejas
```

---

## Orden de ejecución (y por qué es ese)

`bin/run-all.js` es el único punto de entrada. El orden es el contrato:

1. **`capture`** — Golpea producción y escribe `reports/runs/<corrida>/`. Nada corriente
   abajo tiene algo que decir hasta que esto terminó.
2. **`comparativo`** — Comparación por etapa sobre la serie de corridas.
3. **`consolidado`** — Una cifra por tienda, **la misma serie**. Va pegado al anterior:
   un lector que ve series distintas en los dos documentos no tiene cómo reconciliarlos.
4. **`ejecutivos`** — Resúmenes por tienda y consolidado, misma serie.
5. **`tendencias`** — Recorre todas las corridas de todas las raíces, así que tiene que
   ir después de la captura o el punto más nuevo faltaría. Colapsa las lecturas de cada
   día en un punto: una línea trazada por ejecución mostraría el ruido intradía como si
   fuera movimiento — un 13:00 lento junto a un 20:00 rápido se lee como una regresión y
   una recuperación que nunca pasaron.
6. **`index`** — El portal. Último, porque informa sobre lo que los pasos anteriores
   efectivamente produjeron.

**Política ante fallos:** un paso que falla no aborta el resto. La captura puede fallar
contra una tienda —o entera— y los reportes derivados siguen valiendo la pena desde las
corridas ya en disco. Todo resultado queda en `reports/run-status.json`, que es lo que
debería leer un monitor.

**Lock:** `run-all.js` toma un lock por pid en `logs/pipeline.lock`. Una captura lleva
casi una hora; si una se cuelga, el disparo siguiente no debe levantar una segunda flota
de navegadores encima.

---

## Automatización tres veces al día

```bash
bash bin/install-schedule.sh install     # agente launchd, 06:00 / 13:00 / 20:00
bash bin/install-schedule.sh status
bash bin/install-schedule.sh uninstall
bash bin/install-schedule.sh crontab     # imprime la línea de crontab equivalente
```

**launchd antes que crontab en macOS.** Una entrada de cron que cae con la máquina
dormida simplemente se pierde; launchd la recupera al despertar. La línea de crontab
está disponible igual para quien prefiera ese camino o corra en un servidor.
Para un servidor de verdad —Linux, sin sesión de escritorio, corriendo solo— el
procedimiento completo está en *Instalación en la nube*.

`bin/cron-run.sh` es lo que el scheduler ejecuta de verdad. Existe porque cron y launchd
arrancan un proceso casi sin entorno: sin perfil de shell, sin nvm, muchas veces sin
`PATH` usable. Un `node bin/run-all.js` pelado en el crontab funciona probado desde una
terminal y falla en silencio a las 06:00. El wrapper fija intérprete, directorio y
destino de logs, y rota `logs/cron.log`.

Si nvm cambia de versión, la ruta del intérprete cambia: `export QA_NODE_BIN=$(which node)`
o reinstalá el agente.

> **Lo que esto le hace a producción.** Cada ejecución abre sesión y agrega **un**
> producto al carrito en las 13 tiendas. Tres al día son 39 inicios de sesión y 39
> carritos diarios sobre la cuenta de prueba. La compra nunca se confirma. Es una
> excepción explícita y acotada a la regla GET-only de `../CLAUDE.md`, no una licencia
> general — ver *Reglas de operación*.

---

## Instalación en la nube

### Antes de todo: mover la medición cambia el dato

Este proyecto mide **desde donde corre**. El TTFB, el PoP que elige el CDN y la latencia
de las APIs de VTEX dependen de la ruta de red entre la máquina y el origen — que es,
literalmente, el experimento de *geo split* que plantea `../CLAUDE.md`. Toda la serie
diaria se capturó desde un equipo en Centroamérica. Una VM en `us-east-1` mide otra cosa.

Esto ya pasó una vez y la respuesta está más abajo en este mismo README: el baseline de
julio se tomó en una VDI, y por eso **los tiempos absolutos de julio no son comparables**
con los de hoy. La misma regla aplica acá, con la misma salida: lo que sobrevive a un
cambio de entorno de medición son los **conteos** —requests, terceros, tags—, no los
segundos.

Hay que elegir uno de los dos caminos, a conciencia:

- **Continuar la serie.** La VM va en una región cercana al punto de captura actual y se
  copian las corridas históricas. Los tiempos siguen siendo aproximadamente comparables,
  y conviene marcar el día del corte igual que se marcó el episodio de agosto.
- **Empezar una serie nueva.** La nube pasa a ser el punto de medición. No hay que tocar
  nada para arrancar: `lib/series.js` descarta los `baselineDays` que no están en disco,
  así que una instalación limpia simplemente arma la serie con los días que va midiendo.
  Cuando haya un par de días que sirvan de referencia, se fijan en `baselineDays`. Es la
  opción honesta si la región no se parece a Centroamérica.

Lo que no se puede es mezclar las dos sin decirlo. Aparecería como una mejora —o un
desplome— de un día para el otro, y sería el cambio de máquina.

### 1. La máquina

| | Mínimo | Por qué |
|---|---|---|
| SO | Linux x86_64 (probado sobre Ubuntu 22.04 / 24.04 LTS) | `launchd` es solo macOS: en Linux cambia el scheduler, no el pipeline |
| CPU | 2 vCPU | Con 1 vCPU Chromium compite consigo mismo y con el trace de DevTools; los tiempos suben sin que el sitio haya cambiado |
| RAM | 4 GB | Navegador más trace. Con 2 GB el proceso muere a mitad de corrida en las tiendas más pesadas |
| Disco | 40 GB | Una corrida pesa ~31 MB; tres al día con `keepRuns: 90` (30 días) son ~2,8 GB, más el cache de navegadores de Playwright (~1 GB en el equipo actual) |
| Red | Salida directa, sin proxy TLS interceptor | Un proxy que reescribe el handshake altera el TTFB que se está midiendo |

No hace falta IP fija ni puertos entrantes, salvo que se quiera publicar el portal (paso 8).

### 2. Base del sistema

```bash
sudo apt update && sudo apt install -y curl ca-certificates rsync
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v                                   # v22.x
```

### 3. Zona horaria, antes de programar nada

`config/pipeline.json` declara el horario en **hora local** (`America/Guatemala`). Las VMs
arrancan en UTC. Sin corregirlo, las 08:00 caen a las 02:00 locales y las tres lecturas
diarias quedan en franjas distintas a las de toda la historia. Eso no da error: da
números que no se pueden comparar con los de ayer.

```bash
sudo timedatectl set-timezone America/Guatemala
timedatectl                               # confirmá "Local time" y "Time zone"
```

### 4. El proyecto

`reports/` y `logs/` están en `.gitignore`, así que el código y la evidencia viajan por
separado.

```bash
sudo useradd -m -s /bin/bash qa
sudo -iu qa

# el código: clonalo si está en un repositorio, o copialo tal cual
git clone <repo> ~/qa-audit
#   rsync -av --exclude node_modules --exclude .env --exclude reports --exclude logs \
#     usuario@equipo-actual:~/walmart/qa-audit/ ~/qa-audit/

cd ~/qa-audit
npm install
npx playwright install --with-deps chromium
```

`--with-deps` no es opcional. Instala las bibliotecas de sistema que Chromium necesita
(`libnss3`, `libatk`, `libgbm`, fuentes); en macOS venían con el SO. Sin ellas
`chromium.launch()` falla por un `.so` faltante y el mensaje no dice cuál.

Para conservar la serie histórica, copiá las corridas aparte (~1,6 GB):

```bash
rsync -av usuario@equipo-actual:~/walmart/qa-audit/reports/ ~/qa-audit/reports/
```

### 5. Credenciales

```bash
cp .env.example .env && chmod 600 .env
# completar WALMART_LOGIN y WALMART_PASS
```

`lib/env.js` también busca en una carpeta hermana (`../walmart-perf-attribution/.env`) que
en la nube no existe: acá el `.env` local es la única fuente. `CRUX_API_KEY` se deja vacío
—qa-audit nunca la lee, y copiar un secreto que no se usa solo amplía su exposición.

**Nunca dentro de la imagen ni del snapshot.** Un snapshot con `.env` adentro se clona con
las credenciales puestas.

### 6. Probar antes de agendar

```bash
npm run pipeline:plan                       # imprime el plan, no ejecuta nada
npm run capture -- --stores walmart-cr      # una tienda, ~3 min, sí toca producción
npm run pipeline:reports                    # todos los reportes, sin tocar producción
```

La captura de una tienda es la prueba real: ejercita el navegador headless, el login, el
carrito y el checkout completo. Si esa pasa, lo que queda es agendar.

### 7. Agendar — systemd, no launchd

`bin/install-schedule.sh` registra un agente launchd y **solo sirve en macOS**. El wrapper
`bin/cron-run.sh` es el mismo en los dos sistemas; lo que cambia es quién lo dispara.

systemd es la opción recomendada porque `Persistent=true` recupera la corrida que se
perdió con la máquina apagada — exactamente la razón por la que en macOS se prefiere
launchd sobre cron.

`/etc/systemd/system/qa-audit.service`:

```ini
[Unit]
Description=walmart-cam-qa-audit — captura y reportes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=qa
WorkingDirectory=/home/qa/qa-audit
Environment=HOME=/home/qa
Environment=QA_NODE_BIN=/usr/bin/node
Environment=TZ=America/Guatemala
TimeoutStartSec=7200
ExecStart=/home/qa/qa-audit/bin/cron-run.sh
```

`/etc/systemd/system/qa-audit.timer`:

```ini
[Unit]
Description=Tres corridas diarias — 08:00, 15:00, 20:00

[Timer]
OnCalendar=*-*-* 08,15,20:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qa-audit.timer
systemctl list-timers qa-audit.timer        # próxima ejecución
journalctl -u qa-audit.service -f           # seguimiento en vivo
```

Las dos variables de entorno son obligatorias, no decorativas:

- **`HOME`** — Playwright guarda los navegadores en `~/.cache/ms-playwright`. Sin `HOME` el
  lanzamiento falla, y el respaldo que trae `cron-run.sh` es una ruta de macOS que en
  Linux no existe.
- **`QA_NODE_BIN`** — `cron-run.sh` prueba primero una ruta de nvm de macOS; al no
  encontrarla cae a buscar `node` en el `PATH`, que bajo un servicio es mínimo. Fijarla
  saca la adivinanza del medio.

`TimeoutStartSec=7200` queda por encima del techo real: `config/pipeline.json` corta la
captura a los 90 minutos y una corrida normal termina en 40–45.

**Con cron, si se prefiere.** `bash bin/install-schedule.sh crontab` imprime la línea base.
Hay que agregarle las mismas variables e instalarla con el usuario `qa`, nunca con root —
los navegadores viven en el cache de ese usuario:

```cron
HOME=/home/qa
QA_NODE_BIN=/usr/bin/node
TZ=America/Guatemala
0 8,15,20 * * * /home/qa/qa-audit/bin/cron-run.sh
```

Cron no recupera lo que se perdió con la máquina apagada. En una VM que nunca se detiene
da lo mismo; en una que se apaga de noche para ahorrar, no.

### 8. Publicar el portal (opcional)

`reports/index.html` es estático y todos sus enlaces son relativos, así que alcanza con
servir la carpeta:

```bash
sudo apt install -y nginx
sudo chmod 755 /home/qa                     # nginx tiene que poder atravesar el home
```

```nginx
server {
  listen 80;
  root /home/qa/qa-audit/reports;
  index index.html;
  auth_basic "QA";
  auth_basic_user_file /etc/nginx/.htpasswd;
}
```

Los reportes **no** contienen credenciales —se leen en tiempo de ejecución y no se
escriben en ningún artefacto—, pero sí llevan los datos ficticios de la cuenta de prueba
y cifras internas de rendimiento de toda la cadena. Detrás de autenticación o en red
privada; no abiertos a internet.

### 9. Qué vigilar

- **`reports/run-status.json`** — resultado por paso con una bandera `complete`. Es lo que
  debería leer un monitor: se reescribe después de cada paso, no al final.
- **`logs/cron.log`** — el wrapper lo rota a las 20.000 líneas y borra los `run-*.log` de
  más de 30 días.
- Todavía no hay alertas (está en *Pendientes*). El chequeo mínimo es que
  `run-status.json` traiga `complete: true` y una marca de tiempo de menos de 12 horas.

> **Una instancia a la vez.** El costo sobre producción no depende de dónde corra: tres
> ejecuciones diarias por 13 tiendas son 39 inicios de sesión y 39 carritos sobre la misma
> cuenta de prueba. Dejar la nube andando *además* del equipo local lo duplica. Al migrar,
> descargá primero el scheduler local con `bash bin/install-schedule.sh uninstall` y recién
> después habilitá el timer.

---

## Qué corridas entran en los comparativos

Se decide en `config/pipeline.json`, no en el código:

```jsonc
"series": {
  "baselineDays": ["20260722", "20260805"],  // fijados: la referencia del análisis
  "recentDays": 3,                            // los N días más recientes
  "aggregate": "mean",                        // cómo colapsan las lecturas de un día
  "dispersionWarn": 0.4,                      // discrepancia a partir de la cual se marca ±
  "minStoreCoverage": 0.6,                    // piso de cobertura para entrar
  "excludeRuns": ["20260811", "20260812"]     // corridas en disco, fuera de todo cálculo
}
```

`aggregate` acepta `mean` o `median`. El promedio usa las tres lecturas; la mediana
descarta dos pero es inmune a una sola lectura salvaje. Con cualquiera de las dos, los
reportes imprimen `n` y marcan las celdas discrepantes, así que un promedio arrastrado
por una mala corrida se ve en vez de esconderse.

Tres guardas, cada una por un motivo concreto:

- **`baselineDays`** están fijados porque Julio 22 y Agosto 5 son la referencia contra la
  que se mide toda la atribución. No pueden salirse del reporte a medida que se acumulan
  corridas nuevas. Están exentas del piso de cobertura: fijar es una decisión humana y
  una regla automática no debería revertirla en silencio.
- **`minStoreCoverage`** mantiene fuera a las ejecuciones parciales. Una corrida que
  murió tras tres tiendas no es una medición flaca: es una ausencia, y graficarla se
  lee como diez storefronts cayendo a cero ese día. Quedan en disco y siguen listadas
  en el portal; solo no entran a los comparativos.
- **`excludeRuns`** son capturas que están en disco pero no son mediciones. Las del 11 y
  12 de agosto mandaban una cabecera propia en cada petición, lo que forzó un preflight
  CORS que el CDN rechazó y mató una cuarta parte de los recursos de cada página. Una
  tienda que no carga **parece más rápida**, así que esos tiempos halagan al storefront.
  `comparativo-historico.html` existe para dejar el episodio documentado. La exclusión es
  **por corrida**, no por día: si una de las tres lecturas de un día resulta inválida, se
  excluye esa y el día sigue vivo con las otras dos.

`--dates 20260805,20260820` sobreescribe todo, para inspección deliberada.

---

## Estructura

```
bin/
  run-all.js                  Orquestador — el único punto de entrada del scheduler
  cron-run.sh                 Wrapper que ejecuta el scheduler (entorno + logs + rotación)
  install-schedule.sh         Instala/quita el agente launchd; imprime crontab equivalente
  com.walmart.qa-audit.plist  Plantilla del agente (06:00 / 13:00 / 20:00)
  prune-runs.js               Poda de corridas viejas, con guardas

config/
  stores.json                 13 storefronts: id, dominio, país, cuenta VTEX, contenedor GTM
  ago05-baseline.json         Tiempos publicados de Ago-05 (ver nota de procedencia adentro)
  pipeline.json               Serie, flags de captura, horario, retención

lib/
  paths.js                    Dónde vive todo: raíces, ids de corrida, categorías
  series.js                   Qué días compara un reporte y cómo colapsan sus lecturas
  stages.js                   Extracción de etapas + agregación por día (readDay, spread)
  stats.js                    Detección de atípicos (mediana + MAD) — apagada, ver abajo
  catalog.js                  Umbrales, categorías, detectores de tags, recomendaciones
  trace.js                    Captura de trace DevTools (CDP) + agregación de eventos
  analyze.js                  Puntos de fricción, severidad, buckets, presupuesto
  journey.js                  Primitivas de interacción (login, mapa, fecha, carrito)
  render-html.js              Reporte por tienda
  render-csv.js               CSV del journey por tienda
  env.js, pagetype.js         Lectura de .env; URL → page_type

scripts/
  capture/                    Recolección — lo único que toca producción
    audit-auth.js             Journey autenticado de 11 pasos (el del pipeline)
    audit.js                  Variante GET-only, contexto fresco por paso
    interactive.js            Modo asistido: vos manejás, esto graba
  reports/                    Generación — solo leen JSON, nunca la red
    comparativo.js            Por etapa, 13 tiendas, pestañas por país
    comparativo-consolidado.js  Una cifra y un total por tienda
    comparativo-historico.js  Registro fijo del episodio de agosto (fuera del pipeline)
    resumen-ejecutivo.js      13 por tienda + consolidado
    trend-report.js           Histórico completo, pestaña por tienda
    index.js                  Portal
    render-from-json.js       Re-renderiza HTML/CSV sin volver a navegar
  tools/                      Auxiliares de desarrollo, fuera del pipeline
    inspect-modal.js, inspect-pdp.js, inspect-selectors.js

reports/                      ← TODA la salida vive acá
  index.html                  Portal
  run-status.json             Resultado de la última ejecución (para monitoreo)
  runs/<YYYYMMDD-HHMM>/       Evidencia inmutable: json/ csv/ html/ network/
  comparativos/               Nombre fijo, se reescriben
  ejecutivos/
  tendencias/
  archivo/                    Reportes publicados antes de esta organización;
                              ningún script los regenera

logs/
  run-<corrida>.log           Salida completa de cada paso
  cron.log                    Bitácora del scheduler (rotada)
  pipeline.lock               Lock por pid mientras hay una ejecución en curso
```

`../reportesaproducir/` **quedó vacía el 21 de agosto de 2026**. Sus capturas son ahora
corridas normales bajo `reports/runs/`, y sus reportes publicados están en
`reports/archivo/`. Ver `../reportesaproducir/LEIDME.md` para el mapa completo.

Si hace falta leer un archivo externo de corridas (el de un colega, por ejemplo), sigue
existiendo el mecanismo: `QA_ARCHIVE_DIRS=/ruta/a/otro/archivo`. Esas raíces son de solo
lectura; nunca se escribe en ellas.

---

## El journey canónico son 11 pasos

Las comparaciones solo significan algo contra una definición idéntica de journey:

`homepage → search → pdp → add-to-cart → login-page → login-submit → cart → email →
profile → shipping → payment`

El objetivo es la pantalla de selección de método de pago. **La orden nunca se confirma.**

Cada paso medido es el costo de **avanzar** a ese paso, incluidas las llamadas de backend
que dispara la transición, porque eso es lo que un comprador espera.

---

## Reglas de operación

De `../CLAUDE.md`, aplicadas en código:

- **Secuencial y throttled.** Una página a la vez, 1.5s entre pasos, 5s entre tiendas.
  Esto es una medición, no una prueba de carga.
- **Un carrito por tienda por corrida.** Nunca en bucle. La orden nunca se confirma.
- **Sin cabeceras propias.** La identificación va en el sufijo del User-Agent. Se probó
  `X-Diagnostics-Client` para cumplir la regla de "identificar al cliente" y resultó
  dañino: una cabecera propia vuelve *non-simple* a toda petición cross-origin y fuerza
  un preflight CORS. Donde el CDN lo rechaza, el recurso muere. Medido en
  walmart.com.gt: **107 de 369 peticiones fallidas con la cabecera contra 53 sin ella**,
  y entre las bajas estaban el polyfill de VTEX y las fuentes del tema. El User-Agent no
  dispara preflight.
- **La excepción autorizada.** `audit-auth.js` se aparta de la regla GET-only por
  instrucción explícita: agrega exactamente un producto por tienda por corrida, hace un
  login, y escribe nombre/teléfono/dirección en la cuenta de prueba porque VTEX no
  renderiza los pasos siguientes sin eso. Las credenciales salen de `.env` y no se
  escriben en ningún artefacto de reporte.

---

## Sobre el hardware de medición

Las corridas son **sin throttling de CPU** por defecto. El objetivo es reflejar a un
comprador real, y para eso la máquina debe correr sin limitar.

El baseline de julio 2026 se capturó en una **VDI**, no en un equipo de usuario.
Calibrar contra esa VDI reproduciría una particularidad del entorno de captura, no la
experiencia de nadie.

Consecuencia directa: **los tiempos absolutos de julio no son comparables** con los de
hoy, y esa diferencia no es mejora del sitio. Lo que sí se sostiene entre fechas son los
**conteos de requests, de terceros y de tags**, que no dependen del hardware y son el
eje confiable para comparar.

`--cpu-throttle 4` sigue disponible para medir deliberadamente un perfil de móvil de
gama media (el estándar de Lighthouse). Es otra pregunta, igual de válida, pero distinta
de "igualar a julio".

---

## Scoring

Cada umbral, etiqueta de categoría, recomendación y detector de tags en `lib/catalog.js`
se derivó de las 460 auditorías de página que ya estaban en `../reportesaproducir/`, así
que un reporte generado hoy se puntúa con el mismo criterio que uno de julio.

| Métrica | Bueno | Malo |
|--------|------|------|
| Long tasks (cantidad) | ≤ 10 | > 50 |
| Peor long task | ≤ 100ms | > 500ms |
| Timer fire events | ≤ 500 | > 2000 |
| Recálculos de estilo | ≤ 200 | > 800 |
| Eventos de GC | ≤ 10 | > 30 |
| Evaluaciones de script | ≤ 50 | > 150 |
| Peticiones de red | ≤ 150 | > 300 |
| % de terceros | ≤ 30% | > 60% |

Veredicto global: 2+ métricas POOR → `CRITICAL`; 1 POOR o 3+ NEEDS_IMPROVEMENT → `POOR`.

Las long tasks se cuentan **solo en hilos principales de renderer** (`CrRendererMain`).
Contar `RunTask` en los procesos de browser y GPU infla el número con trabajo que la
página nunca esperó.

---

## Lectura de los deltas

Los deltas se muestran como tickers bursátiles, una columna por transición:

| | significado |
|---|---|
| ▲ rojo | el tiempo **subió** → regresión |
| ▼ verde | el tiempo **bajó** → mejora |
| ▬ | sin cambio |
| — | sin dato para esa fecha |

Las tablas por país promedian cada etapa entre las tiendas de ese país. Una tienda sin
dato en una etapa se excluye de ese promedio, no se cuenta como cero.

---

## Detección de valores fuera de rango — desactivada

Ojo con no confundirla con la marca **±** de dispersión intradía, que **sí** está activa
y descrita arriba. Son cosas distintas: ± compara una tienda contra sí misma dentro del
mismo día; lo que sigue compara contra una población histórica, y esa población todavía
no es válida.

`lib/stats.js` existe y funciona (mediana + MAD, `--outliers` para activarla), pero está
apagada. La única población válida es la misma tienda contra su propia historia bajo el
mismo método, y hasta ahora hay una sola corrida así.

Agrupar tiendas compara negocios distintos: Walmart GT y MaxiDespensa GT difieren
legítimamente, y marcar una contra la otra reporta una diferencia que nunca fue anomalía.
Agrupar fechas compara regímenes distintos: Homepage da 43s en la VDI de julio y 8s sin
limitar, así que la mediana agrupada no describe ninguna configuración real y todo valor
actual parece "atípico".

**Esto se habilita solo cuando el horario de tres corridas diarias haya acumulado
historia suficiente por tienda bajo el mismo método** — que es, en buena medida, para lo
que existe el horario. La dispersión intradía es el primer paso en esa dirección: es la
misma idea aplicada a la única ventana donde ya hay repeticiones comparables.

---

## El paso de envío: qué se resolvió y qué falta

No es un desafío antibot. Es el flujo de compra pidiendo un punto en el mapa dentro de
una geocerca, más una fecha de entrega. Ya automatizado en `lib/journey.js`:

- Pin válido vía geolocalización por país (`GEO_BY_COUNTRY`) + `#location-btn`;
  `#confirm` solo se habilita dentro de la geocerca, así que sirve de señal de validez
- El panel de dirección que aparece tras confirmar el pin (`#input-street`,
  `#input-complement` → "Aceptar")
- Fecha de entrega del react-datepicker
- Re-relleno de calle y receptor, que el re-render del mapa vacía

**Pendiente:** `btn-go-to-payment` sigue oculto con "Hay un error de validación" y ningún
campo marcado. Método sugerido para cerrarlo: comparar el `orderForm` de la API entre una
sesión completada a mano y una automatizada, para ver qué campo queda sin setear — en vez
de seguir infiriendo desde el DOM.

Mientras tanto, `npm run capture -- --handoff` funciona y dio 13/13: automatiza 10 pasos
y la persona hace el tramo final. **Este es el motivo por el que el pipeline desatendido
todavía no llega a `payment`**: las etapas de pago quedan excluidas de los reportes en
vez de publicarse como si fueran mediciones.

---

## Retención de disco

Una corrida pesa unos 32 MB, de los cuales ~22 MB son el volcado de red por petición. A
tres corridas diarias son ~2.9 GB al mes.

```bash
node bin/prune-runs.js                        # qué se podaría
node bin/prune-runs.js --network-only --apply # tira los volcados, conserva el JSON
node bin/prune-runs.js --keep 30 --apply
```

`--network-only` es la opción a la que conviene ir primero: recupera cerca del 70% del
espacio y deja cada corrida regenerable, porque los reportes leen el JSON de auditoría,
no el volcado. Nunca se borra sin `--apply`, nunca se tocan las raíces de archivo, y
nunca se tocan las corridas de la serie activa ni las baselines fijadas.

---

## Detalle conocido en `trend-report.js`

El script viene del `reportesaproducir/trend-report` original. Su bucle de GTM/Catchpoint
recorre las carpetas de fecha de más nueva a más vieja sobreescribiendo sin condición, así
que gana el dato de contenedor **más viejo** pese al comentario `// use most recent`. Se
dejó como está para que la salida siga siendo idéntica a la de corridas anteriores.

Lo que sí se cambió, porque el horario lo obligaba: la deduplicación de sesiones ahora es
**por corrida, no por día**. Tres ejecuciones diarias son tres muestras independientes;
colapsarlas a una descartaría dos tercios del registro y escondería justo la variación
intradía que el horario existe para capturar.

---

## Estado al cierre del 21 de agosto de 2026

- Proyecto reorganizado: captura y reportes separados, salida propia en `reports/`,
  orquestador único en `bin/run-all.js`, horario listo para instalar.
- `../reportesaproducir/` vaciada: capturas a `reports/runs/`, reportes publicados a
  `reports/archivo/`. Un solo hogar.
- Los comparativos, resúmenes y tendencias trabajan **por día**, promediando las lecturas
  de la jornada y marcando las que no coinciden entre sí.
- `20260820/` sigue siendo la corrida buena: 13/13 con sesión, carrito y pantalla de
  método de pago, sin throttling.
- Serie activa de los comparativos: Julio 22 → Agosto 5 → Agosto 20.
- Pendiente principal: cerrar la transición envío → pago (ver arriba). Hasta entonces el
  pipeline desatendido mide 10 de los 11 pasos y `--handoff` cubre el resto.

---

## Estado al cierre del 3 de septiembre de 2026

### Lo que está corriendo

Tres capturas diarias, **08:00 / 15:00 / 20:00**, desde el 21 de agosto. El agente launchd
**no está instalado**: las corridas se han lanzado con `bin/cron-run.sh`. Para dejarlo
automático, `bash bin/install-schedule.sh install`.

Datos: **20260821 → 20260903**, 14 días. Las tres corridas del 3 de septiembre completas,
13/13 cada una.

### El pipeline tiene 8 pasos

`capture → comparativo → consolidado → ejecutivos → tendencias → impacto →
impacto-ejecutivo → index`

Los dos de impacto se agregaron el 3 de septiembre y van **después** de las comparaciones
a propósito: citan esos reportes y enlazan a ellos como evidencia. Generados con horas de
diferencia, los dos citaban números distintos para el mismo día y el enlace dejaba de ser
una verificación.

### Análisis de impacto de liberaciones

`config/releases.json` lista las 14 liberaciones con su alcance escrito como ids de tienda
explícitos, para que la evaluación no se pueda ensanchar sola. Dos reportes:

- `reports/comparativos/impacto-liberaciones.html` — sustentación: tabla por tienda, la
  etapa que más cambió, gráfica diaria con la liberación marcada, y de dónde sale cada
  cifra. Escribe además un `.json` con los veredictos.
- `reports/ejecutivos/impacto-liberaciones-ejecutivo.html` — una página para stakeholders.
  **Lee el JSON del anterior en vez de recalcular**, así no puede contradecirlo.

Resultado con datos al 3 de septiembre: 3 con mejora, 2 con desmejora, 3 no atribuibles,
5 sin medición previa (son del 10, 12 y 19 de agosto, anteriores a la medición diaria),
1 sin fecha.

**Dos detectores que cambiaron conclusiones.** "El cambio precede a la liberación" tumbó la
mejora de Costa Rica: el search de MaxiPali cayó de 27s a 12s el **23**, y la liberación
fue el **24**. "Esta métrica no sostiene una conclusión" descartó el driver de Guatemala,
cuyo homepage oscila entre 5s y 20s todo el período sin forma.

### Reglas de lectura que costó llegar a ellas

- **Un valor de un día es el promedio de sus lecturas.** Una captura individual muestra una
  sola. Enlazar a una captura para justificar un promedio es irreconciliable — por eso los
  enlaces van a los comparativos, que sí trabajan con medias diarias.
- **El "recorrido" es la suma de 7 etapas**, no una página. De ahí salen los ~60s por tienda.
- **Nada de signos en el texto**: se escribe "mejoró 4.7%" / "empeoró 12.6%", porque un −4.7%
  se lee como algo malo cuando es lo contrario.

### Pendientes

1. **`series.recentDays` está en 3**, así que los comparativos muestran Jul 22, Ago 5 y los
   últimos 3 días. Los enlaces de 3 de las 7 liberaciones medidas apuntan a un reporte que
   no contiene sus fechas. Subirlo a ~14 lo resuelve y ensancha los comparativos.
2. **Instalar el agente launchd** para que las tres corridas salgan solas.
3. **Nadie se entera si una corrida falla.** Queda en `run-status.json` y en `logs/cron.log`.
   Falta leer ese JSON y avisar cuando `ok` sea `false`.
4. **Walmart NI: paso de pago con mediana de 136s**, el peor de la cadena y estable en 38
   lecturas. Hallazgo abierto, sin relación con ninguna liberación.
5. **El episodio de Guatemala del 25 al 30 de agosto** sigue sin explicación: 18 cuelgues de
   Walmart GT que además tumbaron tres corridas enteras. Ya no puede repetirse (ver abajo),
   pero no se sabe qué lo causó.
6. **Walmart SV y La Despensa SV no llegan a pago** por `sin-días-disponibles`. Falta
   verificar a mano si el storefront realmente ofrece fechas de entrega — puede no ser un bug.

### Presupuestos de captura (3 de septiembre)

Una tienda enferma llegó a consumir 96 minutos y a dejar tres corridas con 1 o 2 tiendas de
13. Ahora hay dos topes: **3 minutos por paso** y **12 por tienda**. Al agotarse, la tienda
se abandona conservando lo medido y la corrida sigue con la siguiente. Ambos topes son
necesarios: un paso llegó a 1.034 s pese a tener timeouts de 60 s y 25 s configurados, así
que los de Playwright no siempre disparan.

---

## Estado al cierre del 9 de septiembre de 2026

68 corridas, 20 días medidos (21 ago → 9 sep), **95.2% de las lecturas utilizables**.
El pipeline corre solo a las 08:00 / 15:00 / 20:00 y regenera los ocho pasos en cada pasada.

### Análisis de impacto de liberaciones

`config/releases.json` — 14 liberaciones con **doble alcance declarado**: qué tiendas y qué
etapas. Lo segundo importa tanto como lo primero: medir un cambio de facturación contra el
tiempo de la Home compara páginas que el cambio nunca tocó.

Dos reportes, uno fuente del otro:

- `reports/comparativos/impacto-liberaciones.html` — sustentación. Tabla por tienda, etapa
  que más cambió, gráfica diaria con la liberación marcada, funnel de calidad de datos, y
  las lecturas individuales detrás de cada promedio. Escribe un `.json` con los veredictos.
- `reports/ejecutivos/impacto-liberaciones-ejecutivo.html` — una página para stakeholders.
  **Lee ese JSON en vez de recalcular**, para que no pueda contradecirlo. Ya pasó una vez:
  mostraba "12.6% < piso 1.0%" porque calculaba su propia cifra sobre otra métrica.

### Reglas de lectura que costaron llegar a ellas

Cada una nació de un error concreto que llegó a estar publicado:

- **El alcance no se ensancha solo.** Se escribe como ids de tienda explícitos. "GT — Walmart,
  Súper, Bodegas" son los tres formatos *dentro de Guatemala*, no los tres formatos de la cadena.
- **Cada liberación se mide donde pudo impactar.** Al aplicarlo, 4 de 7 veredictos cambiaron
  de signo — los anteriores eran artefactos de medir en etapas ajenas al cambio.
- **Piso de detección por métrica.** La Home varía **22.9%** entre días sola; el recorrido
  completo, 5.4%; el paso de pago, 1%. Una mejora menor que eso no se declara.
- **Bajo 1% no se declara dirección.** Ni mejora ni desmejora: "sin impacto medible".
- **Menos de 3 días después de la liberación, no hay veredicto.** Con un día, la mediana de
  tres tiendas dijo "mejora 13.9%" mientras una de ellas se triplicaba.
- **Un día en curso no es un día.** Solo entran días con sus tres lecturas completas.
- **Cambio de régimen sobre lecturas individuales, no sobre promedios.** El promedio diario
  de Mas x Menos CR rebotaba entre 11s y 19s según cuántas lecturas de 26s cayeran ese día;
  lo que cambió el 29 de agosto es que el modo lento **dejó de aparecer**. Un test de medias
  no puede ver eso.
- **Los enlaces van al reporte que trabaja con la misma media diaria** — consolidado para
  totales, por etapa para etapas, con ancla al país. Enlazar a una captura suelta es
  irreconciliable: esa muestra una lectura, el reporte muestra el promedio de tres.

### Funnel de calidad de datos

Control **por lectura, no por corrida**: un paso que falló a las 08:00 no invalida el mismo
paso a las 15:00. El 24 de agosto Walmart GT perdió cinco pasos en una corrida y ese día se
sostiene sobre las dos que funcionaron.

Cuatro motivos de descarte, todos declarados en el reporte: navegación fallida, cuelgue,
carrito vacío, pago no alcanzado. Antes se descartaban en silencio.

### Arreglos de captura del 9 de septiembre

**Esperas ciegas reemplazadas por señales.** El paso de checkout hacía `location.hash` y
dormía 4 s fijos antes de buscar los campos. Si el render tardaba más, reportaba "sin
formulario de perfil" — un render lento registrado como formulario ausente. Así fallaron
las dos tiendas de Nicaragua ese día. Ahora espera a que el paso renderice y sigue apenas
lo hace: `profile` pasó de 4.0 s constantes a 0.5 s reales, y ambas tiendas volvieron a 9
etapas con pago alcanzado.

Ese fallo escondía todo lo demás: sin perfil no hay envío, y sin envío el mapa de la
geocerca nunca se ejecutaba — aunque el código para resolverlo existía desde agosto.

**Pasos con error descartados.** Una navegación fallida registraba ~10-30 ms y se leía como
"la Home cargó en 0.0 s". 51 mediciones en dos semanas, todas sesgando hacia abajo, o sea
capaces solo de inventar mejoras. El error ya estaba en la captura; no se consultaba.

**Presupuestos de captura.** 3 min por paso y 12 por tienda. Una tienda enferma llegó a
consumir 96 min y dejó tres corridas con 1 o 2 tiendas de 13. Al agotarse, se abandona
conservando lo medido y sigue con la siguiente.

### Pendientes

1. **`add-to-cart` conserva un `sleep(6000)` ciego** — mismo patrón que rompió el perfil.
   La Unión NI falló ahí el 9 de septiembre con "no se encontró el botón".
2. **`profile` y `email` cambiaron de método hoy**: de espera fija a espera real. Conviene
   marcarlo como quiebre de comparabilidad para esas dos etapas, igual que se hizo con `payment`.
3. **`mapa=no-se-pudo-confirmar` aparece incluso cuando el funnel avanza.** Ese estado
   reporta un fallo que no lo es; revisar si oculta o inventa problemas en otras corridas.
4. **`series.recentDays` está en 3**, así que los comparativos muestran los últimos 3 días y
   los enlaces de las liberaciones de agosto llevan a un reporte sin sus fechas.
5. **Sin alertas.** Si una corrida falla, queda en `run-status.json` y en `logs/cron.log`, y
   nadie se entera.
6. **Walmart NI: paso de pago con mediana de 136 s**, el peor de la cadena, estable en 38
   lecturas. Sin relación con ninguna liberación.
7. **El agente launchd no está instalado**; las corridas se lanzan con `bin/cron-run.sh`.
8. **Métrica dirigida por liberación** — propuesta y validada con datos, sin implementar. La
   cantidad de tags distintos tiene **0.0%** de ruido contra 22.8% del tiempo de la Home;
   la CPU de tags, 6.4%. Medir un cambio de tags contra el total tira la señal a un pozo.
   Hallazgo de paso: **el 27 de agosto no cambió la cantidad de tags en ninguna tienda.**
