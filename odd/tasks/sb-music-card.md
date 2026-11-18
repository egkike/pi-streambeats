# sb-music-card

Extensión de Pi / Gentle Shell `@egkike/pi-streambeats`: card de música (`/sb-music`) que navega la
biblioteca local de StreamBeats y reproduce con mpv, sin sacarle el teclado al editor.
Este documento es la especificación que leen los workers. Repo público `github.com/egkike/pi-streambeats`,
rama `main`; lo commiteado es andamiaje, gobierno y diseño — **cero código de producto**: T2–T9 y T12 abiertas.

## Specs

S1 — El paquete se llama `@egkike/pi-streambeats` y expone el comando `/sb-music`, sin argumentos.
Manifiesto `package.json` con `"pi": { "extensions": ["./extensions"] }`, ESM, `files` acotado a
`extensions/` y `lib/`, `engines.node >= 22.19`. Sin dependencias de runtime. En modo no-TUI el comando muestra un
mensaje claro y no rompe. Los `peerDependencies` (`@earendil-works/pi-coding-agent` y `@earendil-works/pi-tui` en
`"*"`) se declaran junto con el primer import de tipos del host (T9), no antes: declararlos sin código obliga a
instalar el árbol completo del host en desarrollo sin que nada lo use.

S2 — Settings en `$XDG_CONFIG_HOME/pi-streambeats/settings.json` (default `~/.config/pi-streambeats/`):
`{ "libraryRoot": "<path>", "shortcuts": { "overlay", "playPause", "next", "prev" }, "asciiGlyphs": false }`.
Defaults: overlay `ctrl+alt+z`, playPause `ctrl+alt+space`, next `ctrl+alt+n`, prev `ctrl+alt+p`.
Archivo ausente → defaults y se escribe una vez (dir 0750, file 0600, escritura atómica tmp+rename).
Archivo malformado → defaults + advertencia, nunca crash. Claves desconocidas se ignoran.

S3 — Estado **expandido** de la card: reproduce el artboard `design/sb-music-card/01-lista-unica.html` (el
estado por defecto es la esquina, S15):
fila de encabezado con `sb-music` (énfasis) + breadcrumb (dim) + `N tracks · M:SS` a la derecha;
filas con **columna de marcador de 2 celdas** (celda 1 cursor `▸`, celda 2 reproducción `●`), nombre con
truncado `…`, duración alineada a la derecha con dígitos tabulares; fila del cursor con superficie elevada;
fila sonando con el nombre en rol de éxito; fila de pie con hints de teclas a la izquierda y
`M:SS ━━━╸─── M:SS` a la derecha. Las tres combinaciones (solo sonando / solo cursor / ambas) se leen
sin ambigüedad. Nunca se envuelve texto: se trunca. Anchos de referencia: 90 columnas cómodo, 78 mínimo.
Todos los colores salen de roles del tema del host; no hay paletas propias.

S4 — La card no es modal: el overlay queda visible y el editor recupera el teclado
(`handle.unfocus({ target: editorComponent })`). Se oculta y muestra con `setHidden()` y la **misma tecla**
(`overlay`) la abre y la cierra. Si la referencia al editor no se puede obtener, se entrega overlay modal
cerrable con `esc` y se reporta explícitamente.

S5 — La biblioteca es de **solo lectura**: se lista la **carpeta actual** sin recursión — hijos directos,
carpetas primero y después audio, ambos en orden alfabético. Nunca se escribe ni se borra nada. Extensiones de
audio, las mismas nueve del repo Go: `.mp3 .flac .ogg .oga .opus .m4a .aac .wav .wma`; el resto se ignora.
Se saltean las entradas ocultas (dotfiles, `._*` de macOS, `.DS_Store`): sin esa regla la cola se cuela por
archivos indecodificables (bug real del repo Go, issue #88). Estados obligatorios: carpeta sin audio (dice qué
falta, muestra la ruta actual **y** el `libraryRoot` configurado, y nombra el archivo de settings), ruta
inexistente o sin permiso (mensaje propio con la ruta).

S6 — Reproducción con mpv: spawn con `--idle --no-video --no-terminal --input-ipc-server=<socket>`, socket en
`$XDG_RUNTIME_DIR/pi-streambeats/mpv.sock` (fallback tmpdir + uid), protocolo JSON por líneas con correlación
de `request_id`. `loadfile <path> replace` (mpv 0.41), `set_property` para pausa/volumen, `force-media-title`
para el título. Reglas de cola, avance y errores: S11. mpv **muere con Pi** (sin
`detached`/`unref`); `session_shutdown` cierra el socket y manda `quit`. Sin mpv → estado guiado del artboard
con el comando del gestor detectado en `/etc/os-release` — `apt`, `dnf`, `pacman`, `zypper`, `apk`, `brew` — y, en Windows, `winget install shinchiro.mpv` (o `mpv-player.mpv-CI.MSVC` para el build de CI oficial);
fallback a `https://mpv.io/installation/` cuando no hay match; `c` copia el comando y `r` reintenta. En Windows el
instalador de `shinchiro.mpv` **no agrega mpv al PATH**: queda en `C:\Program Files\MPV Player\mpv.exe`, así que
la detección prueba PATH y después ubicaciones conocidas, y el mensaje posterior a una instalación guiada no puede
anunciar éxito hasta que el binario responda a una ejecución real (`--version`).

S7 — Costura de resolución desde v1: `resolve(item) → Target | Failure` con `target`, `expiresAt`,
`prefetchable` y taxonomía de fallas (`missing`, `network`, `not-found`, `scrape`, `expired`). v1 tiene una
sola implementación (local). El player tiene **un solo camino**: pide un target jugable y lo carga. La
identidad del track (`id`) es estable y distinta del `target` efímero.

S8 — Arquitectura: módulos `extensions/`, `lib/host/` (único que importa `@earendil-works/*`, más los tipos
en los entry points), `lib/core/` (puro y sincrónico, devuelve efectos como datos), `lib/library/`,
`lib/player/`, `lib/settings.ts`, `lib/types.ts`. Sin capas de mapeo DTO. Un test afirma que `lib/core/**`
no importa `node:fs`, `node:net`, `node:child_process` ni `@earendil-works/*`.

S9 — Tests con `node --test` sobre TypeScript directo. Los tests de core, view, queue y player no tocan red,
ni el disco del usuario, ni un mpv real: mpv se simula con un servidor unix real que registra comandos.
El render se verifica por líneas exactas a 90 y 78 columnas, incluido el truncado con `…` y las tres
combinaciones de marcador.

S10 — `libraryRoot`, `settings.json` y el socket usan la convención XDG con fallback a HOME/tmpdir. Ningún
camino absoluto hardcodeado a `/home/<user>`.

S11 — Reglas de reproducción. `enter` sobre un tema arma la cola con **todos los temas de la carpeta actual,
en orden, desde el tema elegido** y lo reproduce; auto-avance al terminar cada tema. Cambiar de carpeta en la
vista **no corta** lo que suena: la cola vive en el reproductor y la vista es independiente. Al terminar el
último tema de la cola se detiene: la barra de estado deja de mostrar el segmento de música y la card muestra
`playlist ended` en su fila de pie. Un archivo que no se puede abrir se informa como
`<nombre>: cannot open, skipping` y se salta al siguiente; si el que falla es el último, se comporta como fin de
cola — un archivo roto nunca corta el resto del álbum. Sin loop: al terminar la cola no vuelve a empezar.
`s` (stop) corta la reproducción y vacía la cola: silencio y sin segmento en la barra de estado. `z` alterna
shuffle sobre la cola restante: el tema actual sigue sonando y el cursor no se mueve; el estado se muestra como
`shuffle on` / `shuffle off`. Volumen: no se persiste, arranca en 70 y se controla con `+`/`-` dentro de la card
(rango 0–100).

S12 — Formato del now-playing en la barra de estado. Sonando: `● <título limpio> · <carpeta>` y el tiempo
`<m:ss>/<m:ss>` a la derecha; pausado: el mismo formato con `○` y el tiempo congelado. El glifo distingue el
estado, no solo el color. Sin nada reproduciendo o al terminar la cola **no hay segmento de música**.
Título limpio: se quita el prefijo de número de pista seguido de `" - "` y la extensión de audio; si el nombre
de archivo no coincide exactamente con ese patrón se muestra tal cual **con** su extensión, sin adivinar. La
carpeta es el nombre del directorio contenedor. Si no entra en el ancho disponible se trunca con `…` y el
segmento de tiempo es lo último en ceder. La barra de estado es la **única dueña del título**: la card en la
esquina no lo repite (muestra sólo tiempo y progreso) y la barra no muestra volumen (S11).

S13 — Teclas dentro de la card, todas anunciadas en su fila de pie: `↑`/`↓` y `k`/`j` mueven el cursor;
`enter` entra a una carpeta o reproduce un archivo; `u` y `\u232b` suben de carpeta; `esc` oculta la card salvo en modo filtro, donde primero lo limpia (S18); 
`/` abre el filtro (S18); `space` pausa o continúa; `s` stop; `n`/`>` siguiente y `p`/`<` anterior; `+`/`-` volumen; `z` shuffle.
Las teclas de selección respetan las keybindings de Pi (`tui.select.*`) cuando estén disponibles. El mapa de
transporte de la app Go se hereda como **teclas**, no como fila visual: esa fila del repo Go es decorativa
(README: "The transport row at the bottom is visual only") y el piso de craft prohíbe chrome muerto.

S14 — Navegación y frontera: la card arranca en `libraryRoot` y navega el árbol hacia arriba hasta **HOME**
inclusive como techo; si `libraryRoot` está fuera de HOME, el techo es `libraryRoot`. En el techo `u` avisa
(`at home`) y no se mueve. Breadcrumb: ruta **relativa a `libraryRoot`** cuando la carpeta actual está dentro de
él (`StreamBeats/Chillhop`, como el artboard); si está por encima, se muestra con `~/…`. Nunca se muestran rutas
absolutas con `/home/<user>`. `libraryRoot` por default es el directorio de música XDG (`XDG_MUSIC_DIR` de
`user-dirs.dirs`, fallback `~/Music`), **sin** sufijo `StreamBeats`. Ni la carpeta ni el cursor se persisten
entre sesiones: la card siempre abre en `libraryRoot`.

S15 — Tres estados. **Oculta (estado inicial):** nada en pantalla; la barra de estado es la única superficie de
música (S12). **Esquina (por defecto al mostrarse):** la card vive abajo a la derecha, chica y anclada, y muestra
sólo glifo de estado y tiempo con su barra de progreso — el título lo posee la barra de estado (S12).
**Expandida:** la lista completa de S3, sin perder cursor ni carpeta.

`ctrl+alt+z` (tecla `overlay`) **cicla los tres estados en orden fijo**, y funciona igual desde el editor que con
la card enfocada: oculta → esquina → expandida → oculta. La primera pulsación llega a la esquina **cuando hay algo
sonando**, porque ahí está su única lectura; **sin música abre directo la lista**, porque la esquina sólo mostraría
`nothing playing` y obligaría a una segunda pulsación para llegar a lo útil. La siguiente pulsación expande y toma el
teclado; la última oculta.

`l` no existe. El tamaño dejó de ser una tecla aparte porque dependía de un foco que la esquina no tiene: al colapsar,
el teclado vuelve al editor, así que `l` no podía ejecutarse de nuevo y la card quedaba sin forma de volver a
expandirse (L38). `esc` oculta siempre, salvo en modo filtro (S18). `/sb-music` abre directo en expandida. Al iniciar
una sesión de Pi la card arranca **oculta**.

La esquina es pasiva y no toma el teclado; la expandida sí, y el editor lo recupera cuando la card se oculta.

La card expandida **lleva su propio contorno** (una celda por lado, rol `border`), porque sin él se lee como fondo
de la terminal. El contorno va **por fuera del padding**, como el artboard anida `.hd{padding:0 1ch}` dentro del
borde de la card: el contenido pierde dos columnas y las filas pierden dos, que las paga el alto de la card y no la
lista (`overlayHeight`). Una card demasiado chica para enmarcarse no dibuja contorno — nunca uno apilado sobre el
contenido. La esquina no lleva contorno: mide dos filas y el recuadro se comería la superficie.

S16 — Glifos. Una sola familia geométrica: `●` reproduciendo, `○` pausado, `▸` cursor, `▾` expandido, `━`/`─`
progreso, `─` la línea de separación, y `┌ ┐ └ ┘ │` el contorno de la card. Nunca emoji en el chrome.
`settings.asciiGlyphs: true` cambia la familia a ASCII (`*`, `-`, `>`, `v`, `=`, `-`, `+`, `|`) para terminales
donde los geométricos ocupen dos celdas. **No hay detección automática**: es una decisión
del usuario, no una adivinanza del código.

S17 — Mouse. Un click sobre una fila la selecciona y la activa: carpeta → entra, archivo → reproduce. La rueda
recorre la lista. El hover resalta la fila bajo el puntero para que el click sea predecible. `renderFrame`
devuelve, además de las líneas, un mapa de zonas por fila (`hits`), de modo que resolver el impacto no acopla la
vista a coordenadas de pantalla.

S18 — Filtro. `/` entra en modo filtro sobre la **carpeta actual**: se escribe y la lista se reduce por
coincidencia de nombre, incremental. `enter` confirma y deja la selección en el primer resultado; `esc` limpia el
filtro y sale del modo. Si no hay resultados, la card lo dice mostrando el término activo y ofreciendo limpiarlo
— nunca una lista vacía sin explicación. Con el filtro vacío, `esc` oculta la card: el modo más interno se
resuelve primero.

S19 — Plataforma. El target IPC y los directorios dependen del SO: socket en `$XDG_RUNTIME_DIR` (Linux) o
tmpdir (macOS), y `\\.\pipe\pi-streambeats-<uid>` en Windows; config en `$XDG_CONFIG_HOME` / `~/.config/pi-streambeats/`
o `%APPDATA%\pi-streambeats\`. Las dos funciones que dependen de la plataforma son **puras y reciben `platform`
como parámetro**, para poder testear los tres casos desde Linux. La conexión al socket/pipe se reintenta (~100 ms
hasta 5 s): mpv tarda en crearlo. Las diferencias se resuelven en `lib/player/` y `lib/settings.ts` — los módulos
que ya son dueños de I/O — sin puerto ni módulo nuevo.

**Verificado en Windows 11, mpv 0.42.0, Node 22.23.2**: spawn con `--input-ipc-server=\\.\pipe\<name>` + JSON por
líneas responde `{"error":"success"}` a `get_property` y a `quit`; la conexión necesitó un reintento de 100 ms.

S20 — Catálogo StreamBeats como segunda fuente. El proyecto replica `streambeats-player` como extensión, y eso
fueron **dos** fuentes desde el principio: L2 dice "Lo que ya tenemos en streambeats-player (catalogo streambeats +
biblioteca local)". S1–S19 cubren sólo la biblioteca local; esta spec cierra ese hueco.

Alcance **dentro**: navegar el catálogo de `streambeats.bandcamp.com` desde la misma card y reproducir una pista con
el mismo `mpv` (S6), con la identidad de pista de S3 y el now-playing de S12 funcionando igual que con archivos
locales.

Alcance **fuera**, por decisión del dueño en L2 ("Mi idea es solo navegar, entrar a una carpeta local y darle play a
las músicas que hay ahí… no pensaba en ningún sync"): `sync`, descargas y caché de **audio**. La caché de
**metadatos** del catálogo sí entra: es redescargable y se guarda en `$XDG_CACHE_HOME/pi-streambeats/catalog.json`
(dir 0750, archivo 0600, tmp+rename), **sin ninguna URL de audio adentro**. Escritura de cualquier tipo en la
biblioteca sigue prohibida: la extensión escribe `settings.json`, el socket y esa caché, nada más.

Invariantes que ya obligan y no se renegocian: las URLs firmadas se resuelven **antes de cada play** y **jamás se
persisten** (`AGENTS.md`, Security); todo lo que llega de la red es entrada no confiable (parseo estricto, fallo como
estado humano en la UI, la card nunca crashea por red); los caracteres de control se neutralizan antes de renderizar,
igual que un nombre de archivo.

Decisiones **abiertas**: sólo queda (c) cómo se presenta en la card la mezcla de dos fuentes sin romper la
navegación de una sola lista (S3/S15); el precedente del proyecto de referencia es catálogo como lista principal y
biblioteca local como modo aparte, y se decide al abrir T14.

**Mecanismo resuelto** (investigado en `egkike/streambeats-player`, `internal/catalog/`, L33). Bandcamp embeda el
catálogo en el HTML; no hace falta API ni selectores:

1. Listado: `GET https://streambeats.bandcamp.com/music` y una regex `href="/album/([a-z0-9-]+)"` sobre el HTML,
deduplicada por slug. El slug es la identidad del álbum.
2. Pistas: `GET /album/<slug>`, se aísla el atributo `data-tralbum="…"`, se des-escapa y se parsea **como JSON**:
`trackinfo[]` trae `title`, `duration`, `title_link` (`/track/<slug>`) y `file["mp3-128"]`, la URL de audio con token.
`duration` llega gratis en el mismo payload.
3. Token fresco **por play**: antes de cada reproducción se re-baja la página del álbum y se busca la pista por slug.
Una URL cacheada es una URL vencida. Un reintento único a 150 ms cubre el blip de red.
4. Refresh tolerante: un álbum 404 o una página malformada se saltea; falla sólo si no se scrapeó **cero** álbumes.
Timeout total 30 s, `dial` acotado a 5 s.
5. **Nuestro contrato manda sobre el de referencia**: `fetch` se **inyecta** (no hay `http.Client` dentro del
módulo), los dos HTML reales de referencia se copian como fixtures de test, y el módulo vive en `lib/catalog/` con
las mismas reglas de pureza que `library/`. Sin red en los tests.

Riesgo declarado: las dos regexes son acoplamiento al HTML de Bandcamp y pueden romperse en silencio. Mitigación
obligatoria: fixtures que fijan el contrato, error explícito `no albums found` en vez de lista vacía, y el caso
"el catálogo no está disponible" como estado humano en la card — nunca un crash ni una card vacía sin explicación.

S21 — Endurecimiento. Cinco defectos distintos, verificados en código, que no se juntan en una sola unidad
revisable porque tienen respaldo y costo desiguales. Nada de esto es una feature: son incumplimientos y bordes.

1. **Latch del primer scan** (`lib/host/host.ts`): `show()` marca `loaded = true` antes de escanear y
   `loadFolder` en fallo sólo avisa; `loaded` nunca vuelve a `false`. Con `libraryRoot` inexistente o sin permiso
   al abrir, la card queda **vacía toda la sesión** con un toast efímero. **Incumple S5**, que pide el estado con
   su ruta, y no hay tecla de recarga en `KeyAction`.
2. **Rechazos del player** (`applyEffects`): `play`, `pause`, `resume`, `stop`, `setVolume`, `quit` se invocan con
   `void` y sin `.catch`. `#request` resuelve siempre (no rechaza), pero un `socket.write` que tira escapa como
   rechazo no observado y la política de Node decide, no la card. El reloj además arranca antes de que la promesa
   resuelva.
3. **`ctrl+c`** (`lib/host/component.ts:79-90`): la card consume `\u0003` y lo convierte en un `escape`, así que
   con la card enfocada **Pi no puede interrumpirse**. Decisión del dueño (L34): **`ctrl+c` pasa al host**; `esc`
   sigue siendo la tecla que oculta la card. El test `tests/host/component.test.ts:126` pina la intención vieja y
   se invierte junto con el código.
4. **Tick permanente** (`host.ts`, `defaultTick`): el `setInterval` de 1 s se agenda siempre y `refresh()` no
   filtra nada salvo `!ctx || closing`, así que fuerza `requestRender(true)` **cada segundo durante toda la
   sesión**, incluso sin música y sin overlay. Defecto de costo, no de correctitud: no tiene `S#` que lo respalde.
5. **Scanner asíncrono** (T21). `scan` deja de ser "synchronous by contract": usa `realpath`/`readdir`/`stat`
   de `node:fs/promises` y devuelve una promesa, porque corre dentro de `onKey` y de `show()`, en el camino de input
   del host, y una carpeta grande o un mount de red congelaban el editor. La falla sigue siendo **dato**
   (`ScanResult`), nunca una excepción, y el core sigue puro y sincrónico: el resultado entra como el evento
   `folder-loaded` que ya existía, sin que el core vea una promesa en su vida.
   - **Camino de input.** `handleInput`, `dispatch` y `applyEffects` siguen devolviendo `void`. Un `load-folder`
     **arranca** la lectura y vuelve; la respuesta entra después como evento. Ningún camino del host espera una
     promesa, porque el host no puede esperarla: `Component.handleInput` es sincrónico por contrato.
   - **Guarda de secuencia.** Sólo el resultado del **último** pedido puede escribir estado; uno viejo se descarta.
     Sin ella, entrar a una carpeta y enseguida a otra deja ganar a la primera si resuelve más tarde, y la card
     muestra la carpeta equivocada. La introduce este cambio: con `scan` sincrónico el problema no existía.
   - **Estado de lectura (decisión del dueño, L62).** Mientras una lectura está en vuelo el pie dice
     `reading <ruta>`. La card no se pinta vacía: una carpeta vacía y una carpeta que todavía no llegó se ven
     igual, y es justo en el mount lento donde esa diferencia importa. El fallo reemplaza la lectura con su
     `notice`, que sigue mandando en el pie.
   - **Latch de L46 intacto.** Se pone en el éxito, dentro del camino async; un fallo lo deja en `false` y el
     próximo `show()` reintenta. Lo que cambia es dónde se asigna, no la regla.
   Rompe el `ReturnType<typeof scanFolder>` de los tests del scanner, que ahora esperan la promesa, y deja
   intactos los dos tests del host que pinan la sincronía: **el pedido sigue saliendo en el camino de input**, lo
   que deja de ser sincrónico es la **respuesta**. Eso es lo que hay que conseguir —que el editor no espere el
   disco—, no diferir el pedido, que sólo agregaría una vuelta sin quitar la espera.

Orden decidido (L34): este ciclo es **sólo T15**. Endurecimiento es T16, en su propio ciclo y con su propio
recorte; (1), (2) y (3) son los que tienen respaldo directo.

S22 — Teclas descubribles y reconfigurables, y las tres de transporte vivas. Pedido del dueño, verbatim: "hagamos
esta opción E con /sb-music --keys clave=valor y todo lo que recomiendas. Se implementan las 3 teclas
(pausa/siguiente/anterior)". Contexto de la decisión, también verbatim: "podría solo abrir un menú de settings o
keybinds" — se descartó: `ctrl+alt+z` no siempre está (conflicto con Pi, AltGr en teclados no-US, TUI no-fullscreen),
así que `/sb-music` sigue abriendo la card porque es el camino de rescate y el de descubrimiento.

Requisitos, todos verificables:

1. **Las tres de transporte se registran** y funcionan desde el editor, con la card abierta u oculta: `playPause`
   alterna pausa/reanudación, `next` avanza, `prev` retrocede. Despachan a los efectos que ya existen; no abren una
   segunda vía de reproducción.
2. **`/sb-music` sin argumentos abre la card**, como hoy.
3. **`/sb-music --keys` sin argumentos imprime**: las teclas efectivas, cuáles están registradas, la ruta resuelta de
   `settings.json`, y las teclas que funcionan dentro de la card. No escribe nada.
4. **`/sb-music --keys clave=valor`** valida y guarda. Varias parejas en una invocación son **atómicas**: si una falla,
   no se escribe ninguna. `=default` restaura el default documentado.
5. **Validación**, con mensaje humano en cada caso: modificador obligatorio (una letra pelada le robaría la tecla al
   editor); sin duplicados entre las cuatro teclas; el valor tiene que ser producible por el host; el nombre de clave
   tiene que existir.
6. **Toda escritura** reusa el escritor atómico existente y avisa que el cambio rige en la próxima sesión, porque las
   shortcuts se registran al bindear la sesión.
7. **`/sb-music --help`** imprime la tabla y la sintaxis.
8. **Las dos descripciones dejan de mentir**: el comando anuncia la tecla del ciclo y el shortcut describe el ciclo de
   tres estados (oculto → esquina → expandida), no un show/hide.
9. **El README documenta las teclas** y distingue las que funcionan en el editor de las que funcionan dentro de la card.

## Tasks

| ID | S# | Tarea | Ruta | Estado | Commit |
|----|----|-------|------|--------|--------|
| T1 | S1 | Scaffolding: `package.json`, `tsconfig.json`, `README.md` | inline | hecho | `872d5c2`, `f6da358` |
| T2 | S2, S10 | `lib/settings.ts`: defaults, lectura, escritura atómica, malformado | inline | hecho (PR #2) | `430a2da` |
| T3 | S7 | `lib/types.ts` + interfaz de resolución | worker | hecho | `872d5c2` |
| T4 | S5, S14 | `lib/library/scan.ts`: carpeta actual sin recursión, extensiones, ocultos, estados | worker | hecho (PR #5) | `87be737` |
| T5 | S3, S11, S13, S15 | `lib/core/model.ts`: estado, cursor, sonando, cola, navegación y teclas | worker | hecho (PR #8) | `c29a5e5` |
| T5b | S18 | `lib/core/model.ts`: filtro sobre la carpeta actual (unidad 2 de T5) | worker | hecho (PR #13) | `4f961c1` |
| T6 | S3, S9, S16, S17 | `lib/core/view.ts`: `renderFrame` con roles, glifos, marcadores, truncado, progreso, hits | worker | hecho (PR #10) | `b00943f` |
| T7 | S12 | `lib/core/now-playing.ts`: limpieza de nombre y formato del segmento + tests | worker | hecho (PR #16) | `6f3b70d` |
| T8 | S6, S11 | `lib/player/mpv.ts`: spawn, IPC, pausa/next/prev, auto-avance, errores, shutdown | worker | hecho (PR #17) | `5828bd5`, `a083366` |
| T9 | S1, S4, S8, S12 | `lib/host/` + `extensions/`: overlay, unfocus, shortcuts, status line, comando | worker | hecho (PR #25) | `bf2ebf3` … `c259e87` |
| T10 | S8 | Test de frontera de capas + test del adaptador con host falso | worker | abierta — frontera hecha, falta el host falso | `872d5c2` (parcial) |
| T11 | S9 | Suite completa verde y reporte | inline | **hecho** — 320 tests / 79 suites, `pnpm check` verde y `gate` verde en `main` (L51) | — |
| T12 | S19 | Soporte Windows: target IPC por pipe, `%APPDATA%`, descubrimiento de mpv fuera del PATH | worker | abierta | — |
| T13 | S17 | Mouse: cablear `hits` del render al host y al reducer (click, rueda, hover) | worker | **hecho** — verificado por el dueño en el host (L53) | `e0d22a0`, `eb081c2` (PR #52) |
| T24 | S17 | Hit map fresco: invalidarlo cuando el modelo cambia antes del frame, y una sola guarda para el click repetido | worker | **hecho** — verificado en el host junto con T13 (L54) | `1f7fcc9` (PR #55) |
| T25 | S22 | Registrar las tres shortcuts de transporte: pausa, siguiente y anterior desde el editor | worker | **hecho** — verificado por el dueño en el host (L57) | `1c5fa54` (PR #58) |
| T26 | S22 | `/sb-music --keys` lee y reconfigura las teclas: validación, escritura atómica, `--help` y tabla del README | worker | **hecho** — verificado por el dueño en el host (L59) | `08ba81d` (PR #59) |
| T14 | S20 | Catálogo StreamBeats como segunda fuente: resolver listado + URL de audio por play, sin persistir tokens | worker | abierta — arranca después de la duración y el endurecimiento (L32) | — |
| T15 | S12, S15 | Duración total desde el player: consulta disparada por `file-loaded` y transporte a las tres superficies | worker | **hecho** — verificado por el dueño en el host (L37) | `e3af22b` (insuficiente), `17f002b` |
| T16 | S21 | Endurecimiento: latch del scan, rechazos del player, `ctrl+c` cierra la card, tick ocioso | inline | **hecho** — verificado por el dueño en el host (L50); el reenvío de `ctrl+c` a Pi sigue en T22 | `5435f72` (latch, rechazos, tick, PR #46), `7140488` (cierre por `ctrl+c`, PR #49) |
| T21 | S21 | Scanner asíncrono: el dep `scan` deja de ser sincrónico y el dispatch pasa a esperar sin congelar la TUI | inline | **hecho** — verificado por el dueño en el host (L64) | — |
| T22 | S21 | Hacer que `ctrl+c` llegue a Pi con la card enfocada: requiere un camino en el host, no en la card | worker | abierta — bloqueada por la API del host (L48) | — |
| T17 | S13, S15 | Ciclo de tres estados en `ctrl+alt+z`; se retira `l` y el tamaño deja de depender del foco | worker | **hecho** — verificado por el dueño en el host (L41) | `77ce72f`, `714df3c` |
| T18 | — | Política de runners macOS en `gate`: `macos-26` sale del `check`, queda sólo el `ipc probe` | inline | **decidida** — PR #37, registrada en `L40` | `55ec075` |
| T19 | S3, S16 | Borde exterior de la card expandida (va por fuera del padding; 2 filas pagadas por el alto) + hallazgos R3-rule-width-empty, R2-001..004 y R2-jargon-refs | worker | **hecho** — verificado por el dueño en el host (L49) | `c857843` (PR #39) |
| T20 | S3, S12 | La card no pide más ancho del que entra, y las filas aprenden la duración del player sin `--:--` | inline | **hecho** — verificado por el dueño en el host (L44) | `b3023c1` |

El diseño no es una tarea aparte: `design/sb-music-card/handoffs.json` da por implementado `01-lista-unica.html`
(la card real es `lib/core/view.ts` + `lib/host/component.ts`, T6 y T9). `03-mini-card.html` **no se implementó y no
debe implementarse**: quedó superado por la implementación, que es más chica (L61). Se conserva como referencia de la
dirección «card de esquina», no como especificación.

## Log

L1 (pedido original, verbatim): "Implement the design artboard design/sb-music-card/01-lista-unica.html …
Implement it in the project's real stack. Use the artboard as the visual spec: map its parts to the project's
existing components and styles, and do not copy the artboard HTML verbatim."

L2 (decisiones de producto, verbatim del usuario): "1- Lo que ya tenemos en streambeats-player (catalogo
streambeats + biblioteca local) con setting de la carpeta local como lo tenemos hoy…"; "Mi idea es solo
navegar, entrar a una carpeta local y darle play a las músicas que hay ahí… no pensaba en ningún sync";
"2- Me cierra @egkike/pi-streambeats."; "3- Utilizaremos un comando /sb-music."; "3- setup guiado con el
comando del package manager según /etc/os-release."

L3 (UI y teclas, verbatim): "1- El overlay queda visible mostrando qué suena, y el editor recupera el
teclado. Combinado con setHidden(true/false)."; "2- (b) Tecla en nuestro settings + tu idea de uno de
transporte (play/pause/next) que funcione sin abrir nada."; "1. Ok, 2. Si, 3. Si para poder cerrar con la
misma tecla, 4. Ctrl+Alt+Z y confirmar que no roban nada."

L4 (arquitectura, verbatim): "Si me cierra tu propuesta de arquitectura."

L5 (corrección de alcance sobre S2): "4- settings queda solo con libraryRoot." quedó superada por L3
(teclas configurables en settings); settings lleva `libraryRoot` + `shortcuts`.

L6 (ciclo de vida de mpv, selección del usuario): "mpv muere con Pi" — interpretado como: mpv es un hijo
común, no `detached`; sobrevive a un cambio de sesión y muere con el proceso. Sin política de huérfanos.

L7 (estado del repo, verbatim): "Borralo" — sin repositorio git en el proyecto, por decisión del usuario.
Por eso esta tabla no tiene commits y las unidades de trabajo no se commitean.

L8 (entorno verificado): node v24.20.0, npm 11.19.0, pi 1.5.2, mpv v0.41.0, Ubuntu 26.04 (ID_LIKE=debian),
`XDG_RUNTIME_DIR=/run/user/1000`, red npm disponible.

L9 (reglas de reproducción y now-playing, selecciones del usuario verbatim): "La carpeta es la cola";
"Para al final, salta en error"; "Título · carpeta · tiempo"; "● / ○ y vacío si no hay nada". Consecuencias
anotadas en S11 y S12: enter reproduce desde el tema elegido y sigue con el resto de la carpeta; fin de la
carpeta muestra `playlist ended` y silencio; archivo roto informa `cannot open, skipping` y no corta el álbum;
título limpio sin `03 - ` ni extensión, y si el nombre no matchea el patrón se muestra tal cual; sin nada
reproduciendo la barra no lleva segmento; círculo lleno/vacío para sonando/pausado.

L10 (navegación, teclas y frontera, selecciones del usuario verbatim): "Hasta HOME"; "El directorio de música";
"Las dos, dentro de la card"; "esc oculta, u sube". Consecuencias anotadas en S5, S11, S13 y S14: la card navega
hasta HOME inclusive como techo (o hasta `libraryRoot` si está fuera de HOME); default del root = directorio de
música XDG sin sufijo `StreamBeats`; `s` stop y `z` shuffle viven dentro de la card y no tienen tecla global;
`esc` oculta y `u`/`\u232b` sube, igual que el navegador del repo Go. Las nueve extensiones de audio y la exclusión de
entradas ocultas se copian del repo Go (issue #88).

L11 (toolchain de la capa A/B aplicado, con dos correcciones): el gate quedó verde — `pnpm install` (6 paquetes),
`biome format`, `biome ci`, `tsc -p .` y `node --test` con 4/4. Hallazgo: pnpm 12 **no reconoce
`auto-install-peers` desde `.npmrc`** (`pnpm config get auto-install-peers` devuelve `undefined` aun con el archivo
presente), así que instaló los `peerDependencies` como árbol real (126 paquetes) y el install murió con
`ERR_PNPM_IGNORED_BUILDS` por `@google/genai` y `protobufjs`, transitivos de `pi-coding-agent`. Corrección:
sacar `peerDependencies` del manifiesto hasta T9 y borrar el `.npmrc` que prometía una protección inexistente.
Lección: un archivo de configuración que no se verifica es una suposición con formato de decisión.

L12 (anclaje, glifos, mouse y filtro, verbatim): "Esquina, expandible"; "Geométricos + escape hatch"; "Mouse
completo"; "Filtro en la carpeta". Consecuencias: la card vive en la esquina por defecto y `l` la expande al
artboard 01 (S15); el `esc` resuelve primero el modo filtro y después oculta (S18); los glifos llevan escape
hatch `asciiGlyphs` en settings (S2, S16); el mouse necesita mapa de impactos en el render (S17).

L13 (barra, volumen, arranque y mpv, verbatim): "Barra siempre, card no repite"; "Solo dentro de la card";
"libraryRoot"; "Seis gestores + fallback al sitio". Consecuencias: el título lo posee la barra de estado y la card
en la esquina muestra sólo tiempo y progreso (S12, S15); el volumen no tiene segmento permanente (S11); no se
persiste carpeta ni cursor entre sesiones (S14); el setup guiado cubre seis gestores con fallback a mpv.io (S6).

L14 (primera validación en Windows real, VM `Windows11`, Node 22.23.2): tres hallazgos, dos son bugs nuestros.
(1) `pnpm lint` **falla** en Windows por CRLF: git convierte LF→CRLF al hacer checkout y `biome ci` exige LF, así
que cada archivo «difiere del formateo» mientras la CI de Linux sigue verde. Arreglo: `.gitattributes` con
`* text=auto eol=lf`. (2) `pnpm test` **corre 0 tests y sale con éxito**: el script usaba comillas simples
(`node --test 'tests/*.test.ts'`), que en `cmd.exe` llegan literales a Node y el glob no matchea. Arreglo:
comillas dobles, probadas en las dos plataformas. Es el mismo mal de todo el día: una puerta que pasa sin haber
probado nada. (3) `winget install --id mpv` **no existe**: el paquete real es `shinchiro.mpv` (0.42.0) o
`mpv-player.mpv-CI.MSVC` (0.41.0); S6 corregido. Lo que sí funcionó: `corepack enable` + `pnpm 12.18.0`, el
binario nativo `@typescript/typescript-win32-x64` y `@biomejs/cli-win32-x64`, `pnpm install` (6 paquetes, 5.7 s) y
**`tsc -p .` sin errores en Windows**. Nota de entorno: `pnpm` debe invocarse como `pnpm.cmd` en PowerShell, porque
`pnpm.ps1` lo bloquea la política de ejecución.

L15 (transporte en Windows, verificado): el named pipe **funciona**. Probe real sobre Windows 11 con mpv 0.42.0 y
Node 22.23.2 — spawn con `--input-ipc-server=\\.\pipe\sbprobe`, `net.connect("\\\\...")`, `get_property mpv-version`
responde `{"data":"mpv v0.42.0-3-g902818753","error":"success"}` y `quit` cierra limpio. La conexión necesitó 1
reintento de 100 ms. Y un cuarto caso del mismo mal del día: `winget` dijo "Successfully installed" pero mpv **no
fue invocable** — el instalador no toca el PATH y el binario quedó en `C:\Program Files\MPV Player\mpv.exe`. De ahí
la regla nueva en S6: una instalación guiada no puede anunciar éxito sin ejecutar el binario. Con esto Windows deja
de ser una promesa sin respaldo: el transporte, el discovery y los directorios son trabajo de T12, no investigación.

L16 (plataformas, verbatim del usuario): "Windows desde arranque v1" y, para macOS, un CI "similar al que usamos
en el repo de Go". Consecuencias: Windows nativo es **promesa de v1** — T12 bloquea la publicación, no es un slice
posterior; macOS se valida por CI como contrato de soporte (no hay hardware de referencia), con `macos-26` arm64;
`macos-26-intel` y `windows-latest` quedan como pendientes explícitos (el segundo llega con T12, cuando el mpv
falso de los tests hable pipes). El job `gate` agrega los resultados y es el nombre único que llevará el
`required_status_checks` del ruleset, para que sumar un runner no trabe `main`.

L17 (estados de la card; corrección encontrada al revisar y confirmada por el usuario): el documento se
contradecía en dos puntos. (1) S15 decía que la card «arranca colapsada» — o sea visible en cada sesión de Pi
 aunque nadie haya puesto música; corregido a **arranca oculta**. (2) S15 decía que `esc` desde la expandida
vuelve a la esquina, mientras S13 decía que `esc` oculta; unificado en **`esc` oculta siempre**, con la excepción
del modo filtro. El modelo de teclas separa **presencia** de **tamaño**: `ctrl+alt+z` es la única puerta que
funciona con el teclado en el editor (`l` sólo actúa con la card enfocada), `l` expande/colapsa y `/sb-music`
abre expandida. Mostrar siempre lleva a la esquina, aunque se haya ocultado estando expandida. Efecto colateral
bueno: el diseño deja de depender de la incógnita «¿el shortcut dispara con el overlay enfocado?», porque `esc`
cubre la salida desde adentro.

L18 (sincronización de estado; pedido verbatim): "Primero sincroniza y actualiza la doc para que quede limpio."
Hechos verificados contra el repositorio: existe y es **público** en `github.com/egkike/pi-streambeats`, rama
`main` con HEAD `66ede1e` empujado a `origin/main` y árbol limpio; 10 commits de andamiaje, gobierno y diseño.
El ruleset `main-gate` está activo sobre `refs/heads/main` con dos reglas, `deletion` y `non_fast_forward`: los
`required_status_checks` que anunciaba L16 **todavía no están configurados**, y tampoco hay PR obligatorio.
Esto **supera L7**: hay repositorio otra vez y las unidades de trabajo se commitean. Corregido en consecuencia:
el header de este documento (decía «no hay commits»), la tabla de Tasks — que ahora lleva columna `Estado` con
los commits reales — y el encabezado de Git Governance en `AGENTS.md`, que describía la política como objetivo
futuro. Hallazgos al revisar: T1 y T3 estaban hechos sin marcarlo, y de T10 sólo existe el test de frontera. Nada
de código de producto todavía. Con la política ya vigente, la próxima unidad de código abre issue antes de la rama.

L19 (T2 cerrado, con la evidencia): `lib/settings.ts` + `tests/settings.test.ts` en la rama `feat/t2-settings`,
commit `430a2da`, PR #2, issue #1. Rutas puras por `platform`/`env`/`home`, XDG con fallback a `~/.config`,
`%APPDATA%` en Windows; archivo ausente → defaults escritos una vez (dir 0750, file 0600, tmp+rename); malformado
→ defaults + advertencia **sin reescribir** el archivo; valores válidos ganan, los inutilizables vuelven a su
default y se nombran, claves desconocidas se ignoran; `libraryRoot` = directorio de música XDG con fallback
`~/Music`. Test-first: 12 tests escritos antes del módulo, RED observado; el segundo RED fue del test (esperaba
separadores mezclados en el path de Windows), no del código. Hallazgo de toolchain: `tsc` rechazaba
`import "…/settings.ts"`; faltaba `allowImportingTsExtensions` en `tsconfig.json` (`noEmit` ya estaba) — el hueco
iba a morder en cada módulo nuevo. Local: `pnpm check` verde, 16/16 tests. CI del PR: `changes`, tres `check`
(ubuntu 22.19 y 24, macos-26 24), `ipc probe (macOS, real mpv)` y `gate`, todos en verde — el contexto que el
ruleset va a exigir ya reportó una vez. La ruta de T2 quedó `inline`, no `worker`: una sola unidad de
comportamiento, más chica que el costo de arrancar un subagente.

L20 (gobierno tomado del repo Go, decisión del usuario verbatim): "Habíamos quedado en tomar como ejemplo el
repo de https://github.com/egkike/streambeats-player … verifica como tenemos ahí las rulesets y CI para veri si
sirven para este proyecto", y ante la comparación: "Todo como la referencia". Verificado en la referencia: el
ruleset `main-ci-gate` tiene `deletion`, `non_fast_forward` y `required_status_checks` con **un solo contexto**
(`strict: false`), `bypass_actors: []` y `current_user_can_bypass: "never"`; **no lleva regla `pull_request`**,
porque un check requerido también se aplica a los pushes directos y uno salteado se rechaza (GH013), así que toda
escritura en `main` pasa por un PR de todos modos. Su `ci.yml` filtra a nivel de job y el job requerido siempre
corre ("a SKIPPED check does not satisfy it"); el nuestro llega al mismo objetivo con el agregador `gate`
(`if: always()`, acepta `skipped`), que ya reportó verde dos veces en el PR #2 — se conserva, es el contexto
estable que evita reeditar el ruleset al sumar runners. Transferido: `required_status_checks: gate` al ruleset
`main-gate` sin bypass (y por lo tanto la línea de `AGENTS.md` que permitía mergear sobre un rojo se reescribe:
ahora dice la verdad del ruleset); `pr-gate.yml` adaptado, que exige `Closes #N` con la issue en
`status:approved` y exactamente un `type:*`, como **señal y no candado** porque el único check requerido es
`gate`; y las etiquetas `status:approved`, los cinco `type:*` y `size:exception`. Descartado a propósito:
`close-unsolicited-prs.yml` (implementa una política de ingreso sólo por issues que este repo todavía no
declaró) y `release.yml` (publica binarios; acá no hay artefacto compilado).

L21 (el rojo del carril de docs, corregido): el primer run de `pr-gate` sobre el PR #3 falló con `no issue
linkage`, que era el comportamiento copiado de la referencia (docs viaja sin issue y mergea con el check en rojo).
Encontrado en vivo, no en revisión: un check rojo permanente en cada PR de docs entrena a ignorar el rojo. Corrección:
un job `lane` con `paths-filter` decide el carril con la lista de AGENTS.md, y `issue-gate` se **saltea** cuando el
PR no toca código. Salteado y no verde: un verde afirmaría que verificó algo. `.github/**` pasó al carril de
tracking (es gobierno, no código de producto), y el `tipo:*` y la vinculación siguen exigidos en el carril de
código.

L22 (T4 cerrado, y un gate que mentía): `lib/library/{scan,paths,names}.ts` + `tests/library/`, commit `87be737`,
PR #5, issue #4. Una carpeta por vez, nueve extensiones, ocultos por prefijo, `realpath` antes de listar, techo puro
sobre paths canónicos, y tres estados de falla como datos en vez de excepciones. Delegado a `gentle-ai-worker` con
handoff acotado; el worker **se colgó** después de un `bash` y devolvió control por timeout, pero los archivos ya
estaban escritos: 38 tests verdes y sólo formato pendiente. Lección de orquestación: el bloque fue en modo `task`
(espera bloqueante) con la política de background encendida; en `background` habría seguido trabajando y la
notificación me despertaba, en vez de quedarme cuatro minutos parado. Hallazgo propio, no del worker: `pnpm test`
usaba `tests/*.test.ts`, que **no entra en subdirectorios**, así que el gate corría 16 tests de 54 y salía verde —
la tercera aparición del mismo mal (L14 fue el glob de Windows). Arreglado a `tests/**/*.test.ts`; el número visible
ahora es 54. Queda anotado que revertir ese glob no lo detecta ningún test: es fragilidad conocida, no resuelta.
Assess nativo sobre el candidato: medium, `reviewDue: false`; 631 líneas autoradas, `size:exception` en el PR porque
partirlo separaría los tests del código del mismo comportamiento.

L23 (matriz de Node; pregunta del usuario): "Nosotros tenemos ubuntu 26.04... deberíamos actualizar algún CI?"
Verificado contra el calendario oficial de Node y las releases de cada action, no de memoria: el runner ya es
`ubuntu-26.04` (coincide con la máquina, 26.04.1 LTS) y las cuatro actions están en su major actual —
`actions/checkout@v7` (v7.0.1), `actions/setup-node@v7` (v7.1.0), `pnpm/action-setup@v6` (v6.1.1, que ya soporta
pnpm v12), `dorny/paths-filter@v4` (v4.0.3). El agujero estaba en la matriz de Node: probábamos 22.19.0 (el piso
declarado, hoy Maintenance LTS con EOL 2027-04-30) y 24 (Maintenance LTS desde el 2026-10-20, y lo que corre el
dueño), pero **no 26**, que es Active LTS desde el 2026-10-28 (`Lithium`, hoy 26.13.1). Decisión del usuario:
"Sumar 26 y conservar 24". La matriz queda en 22.19.0 y 24 y 26 sobre ubuntu-26.04, más macOS en 26, y el probe
IPC pasa a 26. Ninguno de los dos pendientes reales se arregla con un bump: Windows necesita T12 (el mpv falso por
named pipes) y `macos-26-intel` sigue sin hardware de referencia (L16).

L24 (T5 partido en dos unidades, y el modelo cerrado): `lib/core/model.ts` (471 líneas) + `tests/core/model.test.ts`
(651), commits `dbd23bd` (mover `LibraryEntry` a `types.ts`) y `c29a5e5`, issue #7. El documento tenía T5 con S3, S11,
S13, S15 y S18 juntos; se parte en la entrega para no duplicar la carga de review: **T5** queda con S3/S11/S13/S15 y
**T5b** toma S18 (filtro), que es una interacción autocontenida. Preparación hecha por el padre, no por el worker:
`LibraryEntry` vivía en `lib/library/scan.ts` y el estado de la card tiene que guardarlo, así que importarlo desde
`lib/core` invertía la dirección de dependencias — el test de frontera no lo habría visto, porque vigila `node:*` y el
host, no a `library`. Ahora vive en `lib/types.ts` y `scan.ts` lo re-exporta. Decisiones del worker donde la spec
callaba, todas registradas en su reporte: step de volumen 5; cursor sin wrap y reseteado por carpeta; `p` en el
primer tema es no-op y `n` en el último termina la cola; `advance()` es el único camino de avance (auto, `n` y falla);
un último tema roto conserva `cannot open, skipping`; cargas de carpeta optimistas hasta que llega `folder-loaded`;
`node:path` dentro de core sólo para `dirname`, sin filesystem; `/` **no** entra en la tabla de teclas todavía
(anunciar una tecla que no hace nada viola "sin chrome muerto"). Pendiente declarado: `focus` lo maneja el host, así
que T9 debe cablear `focus`/`blur` o `l` no responde después de `/sb-music`; y las fallas de scan de S5 todavía no
tienen evento — llegan con T6/T9. Gate local: 113/113.

L25 (T6 cerrado, y una contradicción abierta): `lib/core/view.ts` (467 líneas) + `tests/core/view.test.ts` (416),
commit `b00943f`, issue #9. 38 tests, **151/151** en el gate. Todas las aserciones son arrays de líneas exactas a 90 y
78 columnas con un tema falso que no imprime escapes, más un segundo tema que imprime el rol (`{success}`) para probar
quién pintó cada tramo: una línea que entra por casualidad no es una línea que entra. Decisiones del worker donde la
spec callaba: duración desconocida → `--:--` y el header omite el total en vez de mostrar una suma parcial como si
fuera total; esquina de 46 celdas (artboard 03) clampeada al ancho, sin título (S12); progreso desde
`options.elapsedMs`/`totalMs`, y sin total conocido la barra **no se dibuja** en vez de inventarse; marco de altura
exacta con el pie fijo en la última línea y ventana centrada en el cursor cuando el listado desborda; fila angosta
pierde la columna de duración antes que el último carácter del nombre, y bajo 2 celdas el cursor gana sobre la
reproducción; carpetas con `/` y celda de duración vacía; breadcrumb en el root muestra el basename (un breadcrumb
vacío no se lee) y un path absoluto está prohibido; los `hits` incluyen sólo filas de entrada (el header y el pie no
tienen acción, así no hay zonas muertas). Riesgos declarados: `ViewTheme` sólo tiene `fg`, así que la fila del cursor
pide el rol `surface` como **fondo** y T9 debe mapearlo a background o el resaltado sale mal; los anchos se cuentan en
code points y no en celdas East Asian, así que un nombre CJK o emoji puede exceder el presupuesto visual (necesitaría
tabla de wcwidth); a anchos muy angostos el pie trunca y puede perder `esc`. **Contradicción sin resolver**: `AGENTS.md`
lista el mouse como fuera de alcance de v1, mientras S17 y T6 piden el mapa de `hits` y `L12` registra "Mouse completo"
del usuario. Se entregó el mapa como dato y sin cableado; falta que el dueño decida cuál de los dos documentos manda y
se corrija el otro.

L26 (el mouse es de v1; contradicción resuelta por el dueño, verbatim): "Lo del mouse deberíamos hacer lo que dicen
S17/T6/L12 que es la doc oficial." Queda escrito en los dos lados: `AGENTS.md` **saca** el mouse de "Fuera de alcance
(v1)" y deja explícito que S17 lo pide, `L12` registró "Mouse completo" y T6 ya entrega el mapa de `hits`; lo que
faltaba era cableado, no decisión de alcance. Se agrega **T13** (S17) con ese cableado pendiente — click sobre una
fila la selecciona y activa, rueda recorre la lista, hover resalta — que necesita tres cosas: el evento de click en
`lib/core/model.ts`, la traducción de coordenadas a fila en `lib/host/` y que el host entregue los eventos de mouse
del overlay. El corte de S17 que T6 respetó sigue siendo válido: el render devuelve datos, no maneja el mouse.

L27 (T5b cerrado: el filtro, y el `esc` que resuelve por término): `lib/core/model.ts` y `lib/core/view.ts`
extendidos, +18 tests de modelo y +13 de vista; **183/183** en el gate. Decisiones donde la spec callaba, todas
defendibles: `esc` resuelve por **término y no por flag de modo**, así que un filtro confirmado con cero resultados no
es un callejón sin salida y la oferta "esc clears" no miente; el término queda después de `enter` (el listado sigue
angostado) pero `blur` cierra el modo y conserva el término mientras ocultar limpia todo; el filtro es de la carpeta,
así que `loadFolder`/`folder-loaded` lo limpian; la coincidencia es substring case-insensitive sobre el nombre
mostrado, nunca sobre el path, sin fuzzy ni folding de acentos; mientras el modo está abierto, las teclas imprimibles
escriben y el transporte se suprime; el input reemplaza la fila del pie (los hints mentirían mientras las teclas son
texto) y el término se trunca por el **principio** con `…` para que el caret quede visible. Riesgos declarados: con el
input en el pie, el `notice` (por ejemplo `cannot open, skipping`) no se ve hasta salir del modo; `/` funciona en la
esquina pero la línea de input sólo la dibuja el marco expandido, porque las dos filas de la esquina son de
reproducción (S12/S15). Costo de anunciar `/`: el pie perdió 2 celdas de barra a 90 columnas y 4 a 78.

L28 (T7 y T8 cerrados, y el CRITICAL que encontró la review): `lib/core/now-playing.ts` (PR #16, `6f3b70d`) y
`lib/player/mpv.ts` (PR #17, `5828bd5` + corrección `a083366`). 243 tests en `main`. **T7**: la regla del título es
`^\d+ - ` + extensión conocida y nada más — `2024-11-10 - live set.mp3` no se toca, y `folderLabel` usa el
directorio del archivo que suena, no la carpeta que estás navegando. **T8**: correlación de `request_id`, `play`
limpia `pause` porque la propiedad sobrevive a `loadfile`, sólo `eof` avanza y sólo `error` falla, target IPC puro
por plataforma, reintento de conexión acotado, y tests contra un `net.Server` real. Lo importante del día: la review
nativa sobre T8 encontró un **CRITICAL determinístico** que 32 tests no veían — si mpv no contestaba `loadfile`, el
`Promise.all` descartaba las respuestas y el track no emitía ni `ended` ni `failed`: la cola se congelaba en silencio
(R4-001). Corregido con un test que reproduce el caso. Asses nativo de los dos: `reviewDue: false`; la review de T8
corrió por decisión explícita del dueño, y la de T7 también. Tres lecciones de proceso que ya están en `AGENTS.md`:
se commitea **antes** de pedir assess (un rango commiteado no se puede evaluar con archivos sin commitear); el
delivery sale **desde el worktree que tiene el candidato** (empujar una rama ajena desde `main` desactiva el guard en
silencio, y así se entregó T7 sin assess); y revisar antes del push ahorra un run de CI (T8 corrió CI dos veces).
Pendiente declarado de la review de T8, con dueño: `R1-001` (el default de macOS cae en el tmpdir con uid, path
predecible) y `R4-004` (`quit()` durante el arranque filtra mpv), las dos a decidir en T9/T12.

L30 (T9/T9b cerrado: la extensión montada, y seis bugs que sólo el smoke vio): `lib/host/{host,component,keys,theme}.ts`
+ `extensions/sb-music.ts`, 13 commits (`bf2ebf3` … `c259e87`), PR #25, issue #24. **295 tests**, `tsc` limpio, install
congelado verde, review nativa `high` cerrada con corrección acotada y validador dirigido. Los tipos del host se
instalan de verdad (`devDependencies` 1.5.2 + `peerDependencies` `"*"`), como hace `heohlee/pi-yt`: el bloqueo era
`ERR_PNPM_IGNORED_BUILDS` de pnpm, resuelto con `strictDepBuilds: false` + `ignoredBuiltDependencies` en
`pnpm-workspace.yaml` — el mismo intento que `L11` había puesto en `.npmrc`, donde pnpm 12 no lo lee. El smoke real
(en Gentle Shell, cinco rondas) destapó seis bugs que la suite no podía ver: (1) el camino modal liberaba el foco a
`null` y dejaba el terminal sin teclado; (2) la card parseaba teclas con una tabla ANSI propia mientras Pi exporta
`matchesKey` — `j`/`k` andaban y `esc`/flechas no; (3) `ctx.ui.custom` se resuelve con `done()` y Pi maneja una
pantalla por vez, así que pedir otra sin esperar descartaba el pedido en silencio; (4) la geometría se fija al crear
el overlay, así que cambiar de tamaño exige reconstruirlo; (5) `cornerFrame` devolvía cero líneas sin tema sonando y
un overlay vacío es indistinguible de una tecla muerta; (6) `esc` cerraba el overlay sin bajar `presence`, y el primer
`ctrl+alt+z` siguiente era un no-op — el CRITICAL que encontró la review, no el smoke. Método que faltaba: se
instrumentó con `SB_MUSIC_DEBUG=<path>` (traza opt-in de show/toggle/create/factory/focus/hide) y eso resolvió en una
corrida lo que cuatro hipótesis seguidas no. **Lección**: una integración con el host no está lista cuando el gate está
verde, está lista cuando abre en el host; el handoff decía "el smoke lo corre el dueño" y era cierto, lo que estuvo mal
fue entregar tres veces antes de que ese smoke ocurriera.

L31 (los cinco fixes que salieron de la primera reproducción real): PR #28, issue #27, commits `bc9317f` … `053e656`.
La card reproduce, y ese primer uso con sonido destapó tres defectos que ningún test veía porque todos viven en el
comportamiento del host con un tema sonando: (1) cada efecto `play` liberaba el teclado, así que después del primer
`enter` `space`/`n`/`p` escribían en el editor y la única vuelta era cerrar y reabrir perdiendo cursor y carpeta — S4
pide que la card **no sea modal**, no que suelte el teclado en cada acción, así que ahora lo conserva mientras está
enfocada y el editor lo recupera al ocultarla o cerrarla; (2) la barra de estado recibía el segmento correcto cada
segundo y no se pintaba, porque `requestRender()` no marca el pie como sucio y sólo lo forzaba algo externo (ocultar
la card) — ahora se pide un frame completo; (3) el segmento se dimensionaba al ancho de la terminal y el pie del host
**envuelve** lo que no entra, así que el título salía partido en dos líneas — presupuesto de 44 celdas, el ancho del
panel. De paso: la esquina ya no imprime `1:20 / --:--` cuando el total es desconocido (se lee como error y la barra
de progreso igual no se puede dibujar), y murió el booleano `releaseKeyboard` que quedó sin callers — código muerto
con un contrato que ya nadie cumple. Detectado a mano, no por la suite: **295/295 seguía verde con los tres bugs
dentro**, y el único test que "cubría" la liberación de teclado pasaba por un `unfocus` que el overlay hace igual al
abrirse. Pendiente declarado y con decisión propia: la duración total, que mpv conoce apenas carga el archivo y que
daría barra de progreso en la esquina, `m:ss/m:ss` completo en la barra y el total en el header.

L32 (hueco de tracking: el catálogo StreamBeats nunca fue tarea; pedido del dueño, verbatim): "No veo entre los
pendientes agregar lo de streambeats-player... se supone que el proyecto es replicar lo mismo que
https://github.com/egkike/streambeats-player pero como una extension para gentle-shell/pi. Donde quedó eso?"

El pedido no era un error de memoria: era un **defecto de la ficha**. L2 registró la decisión de producto (dos
fuentes: catálogo + biblioteca local) y `README.md` la prometió ("later slice"), pero ninguna de las dos se tradujo
en spec ni en tarea, y la tabla de `## Tasks` se arma desde los `S#` — sin `S#` no hay `T#`, y sin `T#` el pendiente
no existe para nadie que lea la tabla o el resumen de sesión. `AGENTS.md` lo tenía en "Fuera de alcance (v1)" con la
frase correcta ("una decisión pendiente, no una omisión"), que es exactamente el lugar donde una decisión **sí** se
vuelve una omisión cuando no tiene tarea ni disparador.

Corrección aplicada: nueva **S20** con el alcance que L2 ya había fijado (catálogo dentro, `sync`/descargas fuera,
URLs firmadas resueltas por play y nunca persistidas) y sus tres decisiones técnicas abiertas declaradas en vez de
inventadas; nueva **T14** en la tabla, `abierta`. Prioridad elegida por el dueño: **después de la duración y del
endurecimiento**, no antes.

Lección de proceso: una decisión de producto sin `S#` no está registrada, está perdida con buena letra. El test es
mecánico y va antes de cerrar cualquier ciclo — ¿cada `L#` con contenido de alcance tiene su `S#`, y cada `S#` su
`T#`?

L33 (investigación pedida por el dueño, verbatim): "En el proyecto https://github.com/egkike/streambeats-player ya
resolvimos eso, podrías ver o investigar como hacerlo de ahí?"

Hallazgo, en `internal/catalog/` del proyecto de referencia (lectura del repo público, no de memoria):

- `parse.go`: el catálogo **no** requiere API ni scraping de DOM. `ParseMusicPage` saca los slugs de álbum con una
  regex `href="/album/([a-z0-9-]+)"` sobre `/music`; `ParseAlbum` aísla el atributo `data-tralbum`, lo des-escapa y
  lo parsea como **JSON**: `trackinfo[]` con `title`, `duration`, `title_link` y `file["mp3-128"]` (URL con token).
- `stream.go`: `ResolveStream` re-baja la página del álbum **antes de cada play** y busca por slug. El token de
  Bandcamp expira; nunca se confía en una URL cacheada. Un reintento a 150 ms.
- `store.go`: caché en `$XDG_CACHE_HOME/streambeats/catalog.json`, tmp+rename, 0750/0600, y **vacía todos los
  `StreamURL` antes de guardar**. `Refresh` saltea álbumes 404 o malformados y falla sólo si scrapeó cero álbumes.
- `client.go`: timeout total 30 s con `dial` acotado a 5 s (issue #62: un SYN perdido colgaba ~7,5 s).

Correcciones que esto impuso a S20: (1) **error mío** — había puesto "caché en disco" en el alcance fuera; la caché
de metadatos entra, la de audio (`sync`) sigue afuera; (2) la decisión abierta (b) la resuelve nuestro propio
`AGENTS.md`, que ya lista `catalog/` como módulo de I/O hermano de `library/`; (3) queda abierta sólo (c), la
presentación de dos fuentes, con el precedente de referencia (catálogo = lista principal, biblioteca = modo `l`).

Diferencia deliberada: el proyecto de referencia usa `http.Client` dentro del paquete y se testea con fixtures; acá
`fetch` se **inyecta** por contrato, los dos HTML de `testdata/` se copian como fixtures y los tests no tocan red.
Riesgo declarado en S20: las regexes acoplan al HTML de Bandcamp y pueden romperse en silencio; se mitiga con
fixtures y con el fallo como estado humano en la card.

L34 (recorte del ciclo, decisiones del dueño, verbatim): "1. ¿Qué entra en este ciclo? — Sólo A: la duración";
"2. ¿Qué hace ctrl+c con la card enfocada? — Pasa al host: Pi manda, la card no lo consume".

Se registran cinco defectos de endurecimiento que **sólo vivían en un resumen de sesión**: mismo defecto de
proceso que el catálogo (L32). Ahora son S21 + T16, con su recorte y su ciclo.

Verificación de los cinco antes de decidir, con `path:line`: el latch está en `show()` (`loaded = true` antes de
escanear) y en la rama de fallo de `loadFolder`; los seis `void player?.…` están en `applyEffects`; `ctrl+c` se
consume en `component.ts:79-90` y su test lo pina; el tick es un `setInterval` incondicional en `startSession` y
`refresh()` fuerza un frame completo cada segundo; el scanner es sincrónico por contrato del dep y corre dentro de
`onKey`.

Corrección de una afirmación previa mía: dije que el tick "estaba atado a la reproducción" y era al revés — está
siempre agendado y repinta de más. Sólo B1 cambia de naturaleza (costo, no correctitud); B2 tampoco era "un ítem
más": cambia el contrato del dep `scan` y rompe dos tests que pinan la sincronía, por eso va a T16 y no a este
ciclo.

**T15 implementado** (S12, S15). El renderer ya sabía dibujar el total y la barra (`view.ts` `totalOf`, corner y
pie expandido, `SegmentOptions.totalMs`); lo que faltaba era el productor. `Track.durationMs` viene del scanner, que
lee nombres y no tags, así que en producción siempre era `undefined` y las cinco superficies decían `--:--`.

Cambio, en dos módulos y **sin tocar `lib/core/`**:
- `lib/host/host.ts`: `PlaybackClock.durationMs`; `readDuration()` consulta `["get_property", "duration"]` por el
  `command()` que ya existía con correlación de `request_id` (sin tocar `#handleEvent`), **después** de que el
  `loadfile` se confirma — bajo `--idle` mpv no tiene la propiedad antes de cargar nada; se pide en cada play
  porque el total es del tema; una respuesta tardía para un tema que ya no suena se descarta; y `resume` conserva el
  total en vez de reconstruir el reloj sin él. El dato llega al segmento de estado y a las opciones de la vista.
- Fallback intacto: player sin mpv, timeout o propiedad no expuesta dejan el total desconocido y las superficies
  siguen imprimiendo lo que ya imprimían.

**Prueba contra mpv real** (la que los tests unitarios no pueden dar, y que valida las dos premisas del cambio):
con `--idle` y un WAV de 2.000 s generado al efecto, `get_property duration` **antes** del `loadfile` responde
`{"error":"property unavailable"}` y **después** responde `{"data":2.0,"error":"success"}`. Es decir: la consulta
tiene que ir después del load, y el `error` no-success del fallback es el caso real, no una precaución teórica.

Cinco tests nuevos en `tests/host/host.test.ts` (uno por regla): la consulta se emite y el segmento dice
`0:00/4:05`; la esquina dibuja `0:00 / 4:05` con su barra; una respuesta de error conserva `--:--`; una respuesta
tardía de otro tema se ignora; el total sobrevive pausa y resume. `pnpm check` verde: 300 tests (eran 295), 71
suites, `biome` 33 archivos, `tsc` limpio.

Sin commit: AGENTS.md pide pedido explícito del dueño, y el carril de código exige issue aprobada antes de la rama.

L35 (prueba en el host real, verbatim del dueño): "Hice una prueba con /sb-music y veo lo siguiente: 1-en la card de
Integratios el tiempo muestra así 1:15/--:--, en la esquina de abajo a la derecha sale en punto y el tiempo pero no
sale el nombre de la musica o barra de avance... hay un espacio entre el punto y el tiempo".

**T15 no cumplía: el total seguía desconocido en el host.** Causa raíz medida con mpv real, sin el `sleep` que mi
prueba anterior tenía: el `reply` del `loadfile` llega a los **2 ms** —antes de que el archivo esté cargado— y la
consulta inmediata devuelve `{"error":"property unavailable"}`. mpv avisa cuándo **está** cargado con el evento
`file-loaded` (35 ms en la medición), y recién entonces `get_property duration` responde `{"data":2.0}`.

Mi verificación anterior tenía un `time.sleep(0.4)` entre el `loadfile` y la consulta: ese sleep hacía el trabajo y
escondía el error. Lección: una prueba de integración que **espera** está probando otra cosa que la que corre en
producción. El `loadfile` acuse no es un hecho de carga; `file-loaded` sí.

Diseño corregido: el jugador es quien conoce los hechos de mpv, así que la duración entra por el canal de reportes
que ya existe y ya atribuye cada hecho a su `trackId` — `{ kind: "duration", trackId, durationMs }` — emitido cuando
llega `file-loaded` y la consulta responde. El host deja de consultar y sólo aplica el reporte si el `trackId`
sigue siendo el que suena. Revertir la consulta del host es parte de la corrección, no un extra.

Las otras dos observaciones: el **nombre** del tema no va en la esquina por diseño (S12: el título lo posee la barra
de estado; la esquina muestra sólo glifo, tiempo y progreso) — no es un defecto. La **barra de avance** tampoco
aparece porque depende del total, o sea que cae con esta misma corrección. El **espacio entre el glifo y el tiempo**
sí es real: `cornerStateLine` alinea el tiempo a la derecha, así que con un tiempo corto el hueco del medio queda
grande. Se corrige junto con esto y se pina con un test de línea exacta.

L36 (corrección de T15 verificada por el padre, no por el reporte del worker): la duración se dispara con el evento
`file-loaded` y viaja como `PlayerReport { kind: "duration", trackId, durationMs }`. `lib/player/mpv.ts`: `#handleEvent`
conserva `end-file` sin cambios y suma `file-loaded` → `#onFileLoaded()`, que no consulta si no hay `#trackId`, usa
el `#request` de siempre y descarta la respuesta si el tema cambió mientras tanto. `lib/host/host.ts`: muere
`readDuration()` y la consulta del adaptador — **el host ya no interroga a mpv** — y `onReport` aplica el total sólo
si ese `trackId` sigue sonando. `Player.command()` queda sin llamador de producción: se conserva como escape hatch
documentado, retirarlo cambiaría la interfaz pública y es otra decisión.

Tests: tres nuevos en `tests/player/mpv.test.ts` sobre el servidor unix falso (la consulta se emite **después** de
`file-loaded` y nunca antes; un `file-loaded` sin tema propio no reporta; una respuesta para un tema reemplazado se
descarta) y los cinco de `tests/host/host.test.ts` reescritos para entrar por `playerReport`, con el andamiaje
`playerControl` que yo había agregado retirado por muerto. `pnpm check` verificado por el padre: **303 tests / 72
suites, 0 fallos**, `biome` 33 archivos, `tsc` limpio.

Queda pendiente lo único que decide si esto está listo (`AGENTS.md`, Feedback Loop): **la prueba en el host** con
`pi -e ./extensions/sb-music.ts` — `m:ss/m:ss` en la barra de estado y la barra en la esquina. Hasta entonces esta
tarea no se cierra, por tercera vez con la misma lección.

L37 (verificación en el host, verbatim del dueño): "Listo ya hice la prueba y funcionço todo. El tiempo en la card
sale asi 0:44/2:51 y en la esquina ya sale la barra de avance también".

**T15 cerrada**, y esta vez por el camino que las dos anteriores no tuvieron: la prueba en Pi con el código del
candidato. `m:ss/m:ss` en la barra de estado y la barra de progreso en la esquina, que eran las dos superficies que
S12 y S15 piden y que llevaban tres ciclos diciendo `--:--`.

El saldo de esta tarea es un método, no una línea de código: **una integración con el host no está lista cuando el
gate está verde, está lista cuando abre en Pi** — y una prueba de integración que *espera* (el `sleep` de mi primera
verificación) está probando otra cosa que la que corre en producción. Las dos veces que T15 se declaró lista sin
eso, el host la desmintió en un minuto.

L38 (la tecla `l` es un viaje de ida; decisión del dueño, verbatim): "La tecla l dice expandir al pié de la ventana
expandida... al presionar l minimiza, y al dar nuevamente l solo se escribe en el chat... No expande en realidad. No
sería más logico que se Expanda y Minimice con Ctrl+Alt+z y quitemos la tecla l?"

Diagnóstico: no era una tecla rota, era un callejón sin salida construido por dos decisiones correctas. `ctrl+alt+z`
mostraba la esquina con `show("corner", false)` —sin foco—; `l` alternaba el tamaño, y al colapsar `dispatch`
reconstruía el overlay con `hadFocus = false`, devolviendo el teclado al editor; la esquina no toma foco nunca, y `l`
sólo actúa con la card enfocada. Resultado: el pie anunciaba `l expand` y no había forma de expandir salvo
`/sb-music`. S15 separaba presencia de tamaño; S4/S15 piden que colapsar devuelva el teclado. Juntas, dejan la
esquina sin entrada de teclado.

Decisión: **un solo comando que cicla los tres estados** (oculta → esquina → expandida → oculta). Elimina la
dependencia de foco en lugar de parchearla, mantiene la esquina pasiva, y conserva "la primera pulsación llega a la
esquina". Costo declarado y aceptado: S15 se reescribe (el tamaño ya no es una tecla aparte), `l` sale de S13 y del
pie, y tres tests que pinan el comportamiento viejo se reescriben a propósito —`model.test.ts:179`,
`host.test.ts:413` y `:559`— porque borrarlos destruiría la evidencia de que el cambio fue deliberado.

L39 (segunda prueba en el host, verbatim del dueño): "Funciona bien las 3 secuencias pero hay un detalle: La primera
vez que presiono ctrl+alt+z no hay ventana expandida y me sale en la esquina: ○ nothing playing, luego la segunda vez
que presiono ctrl+alt+z ya sale la ventana expandida... y tercero oculta. Otro detalle es que la fila de botones del
pié se confunde con toda la ventana [...] quizás valga la pena que tengan una linea por arriba o recuadro, colores en
las teclas quizás... Qué te parece?"

**El pie se confundía porque el artboard tiene tres bordes y el frame no dibujaba ninguno.** `01-lista-unica.html`:
`.card{border}`, `.hd{border-bottom}`, `.ft{border-top}`. L1 declara el artboard spec visual, así que no era una
opinión de diseño: era una desviación. Se dibujan los **dos internos** (`─` en rol `border`, ancho completo, sin
padding; glifo `rule` en la misma familia S16, con su versión ASCII). El **borde exterior no**: cuesta 2 filas + 2
columnas de cada frame y a la esquina de 46 celdas le come 4 de contenido. Las **teclas con color propio tampoco**:
el artboard pone todo el pie en `muted`, y en este proyecto el artboard cambia primero.

Costo declarado y aceptado: los divisores salen del alto del frame, no lo agrandan. En 15 filas, la lista pasa de 13
renglones a 11. La alternativa —crecer la card 2 filas— se la come el editor, y se descartó.

**El ciclo ahora es consciente del contenido**: sin música, `ctrl+alt+z` abre directo la lista; con algo sonando
empieza en la esquina. Sin esa regla la primera pulsación mostraba `nothing playing` y obligaba a una segunda para
llegar a lo útil.

**Defecto que la revisión del padre atrapó y el worker había tapado subiendo alturas**: con alto 4 —el piso de
`overlayHeight`— los dos divisores dejaban `listRows = 0`, o sea header, separador, separador, pie, sin fila de lista
y sin poder mostrar el estado de "sin coincidencias" de S18. Ahora los divisores exigen una fila de lista entre ellos
(`height >= 5`) y hay un test que pina que en 4 filas no se dibuja ninguno.

Verificación: `pnpm check` exit 0 — **305 tests / 72 suites**, `biome` 33 archivos, `tsc` limpio. La actualización de
las líneas exactas de `view.test.ts` la hizo un worker con instrucción explícita de no borrar ni aflojar aserciones:
censo 77 → 79 asserts (los dos nuevos son del glifo `rule`), 0 borradas.

Operativo, y es la tercera vez en la sesión: `main` volvió a quedar **rojo por cola de runners macOS**, no por código.
Los dos jobs de `macos-26` se cancelaron a los 15m01s (`abandoned`) y `gate` falló por regla; los tres de ubuntu
pasaron, y en el run del PR #33 el `ipc probe` probó que la imagen funciona. Se resolvió con rerun las tres veces.
Queda como **T18**: decidir si `gate` debe exigir los tres nodos de macOS o alcanza el `ipc probe`, que es el único
que ejercita macOS de verdad.
L40 (política de runners de macOS, decisión del dueño, verbatim): "En qué momento hacemos esto: 2. Sacar
macos-26 del check y dejar sólo el ipc probe en macOS.?" — elegida con `AGENTS.md` actualizado en el mismo commit.

Evidencia que la motivó, de la sesión: la cola de runners de macOS sirve **aproximadamente un job por run**, y el
workflow pedía dos (`matrix.os` del `check` más `ipc`). El que perdía la carrera se cancelaba a los **15m01s**
exactos y `gate` fallaba por `abandoned`; cuatro runs en una tarde, con todos los jobs de Ubuntu verdes. La prueba
de que es cola y no imagen: en un rerun el `check` de macOS pasó y el `ipc probe` se canceló; en otro, al revés.

Cambio: `macos-26` sale de la matriz de `check`. En macOS queda el `ipc probe` —el único que necesita macOS de
verdad: mpv real, sockets reales— y sigue filtrado por `transport`, así que un PR que no toca transporte **no pide
ningún runner de macOS**. `gate` no se tocó: sigue aceptando sólo `success` y `skipped` deliberado, así que un job
cancelado o abandonado lo sigue volteando. Lo que cambió es qué lo alimenta, no su regla.

**Cobertura que se pierde, verificada por un verificador independiente y no a ojo**: el suite en macOS real (Node
darwin, `tmpdir()`, `realpathSync` con symlinks de macOS) y —hallazgo que no había visto— la **ruta de producción
del socket en darwin** (`~/Library/Caches/…/mpv.sock`, `lib/player/mpv.ts:81`): el `ipc probe` no la importa, usa la
suya, así que esa ruta no se ejecuta nativamente en ninguna parte. La lógica de plataforma sí sigue cubierta desde
Linux, porque las funciones son puras y reciben `platform` (S19): `tests/player/target.test.ts:24,65`,
`tests/settings.test.ts:44`, `tests/library/paths.test.ts:28-29`.

Deuda declarada: la ruta del socket de darwin no tiene cobertura nativa. Se cierra cuando alguien haga que el probe
importe el target de producción, o con un job propio — no con una promesa en un documento.

`README.md` decía "plus macOS 26 for the darwin code path": esta entrada corrige el README en el mismo commit, porque
un documento público que promete cobertura que no existe es peor que la falta de cobertura.

L41 (verificación del ciclo y los divisores en el host, verbatim del dueño): "Hice mi prueba y todo funciona bien.
Algo que agregaría es linea de contorno o bordes de la ventana expandida... para que no se mezcle con el fondo de pi.
De paso puedes arreglar los 2 issues del review."

**T17 cerrada**, con las dos superficies de S15 confirmadas por el dueño en una sesión de Pi: el ciclo
oculta → esquina → expandida → oculta, y las dos líneas internas (bajo el header, sobre el pie).

Cierra además `R3-doc-t17-stale`: la fila decía "falta la prueba en el host", que se lee como *tests del host* cuando
significaba **la prueba manual del dueño en una sesión de Pi** — y esa prueba ya había ocurrido. El defecto era la
redacción, no el hecho; queda explícito acá y en la tabla.

Lo que el dueño pidió en la misma prueba —el **borde exterior** de la card, el tercero del artboard— no entra acá: es
la issue #36, junto con los hallazgos que las reviews dejaron acumulados (`R3-doc-t17-stale` cerrado por esta entrada,
`R3-rule-width-empty` y `R2-jargon-refs` pendientes).

Estado de entrega de esta unidad, para que quede el rastro completo: PR #35 con `Closes #34`, review nativa aprobada
(`review-fbb7a8f275cb211b`, lentes readability + reliability, 7 hallazgos no bloqueantes), y el delta que trajo la
fusión de `main` revisado aparte (`review-8618d72c78675310`, lentes risk + readability) porque mover la base mueve el
candidato. `main` en `601f713`, CI verde.

L42 (borde exterior de la card, decisión del dueño, verbatim): "Hice mi prueba y todo funciona bien. Algo que
agregaría es linea de contorno o bordes de la ventana expandida... para que no se mezcle con el fondo de pi."

Implementado en `lib/core/view.ts`: `Glyphs.edge` (esquinas y vertical; `+`/`|` en ASCII) y `expandedFrame` enmarca
cuando `width >= 6 && height >= 8`. El marco va **por fuera del padding**, como el artboard anida `.hd{padding:0 1ch}`
dentro del borde de la card: el contenido pierde dos columnas y las filas pierden dos, y esas dos filas **las paga el
alto** (`overlayHeight` expandida pasa a `rows - 4` con piso 7), no la lista. Los `hits` del render se desplazan una
fila por el borde superior. La esquina no lleva marco: mide dos filas.

**Corrección a la propia issue.** El texto decía que el borde *reemplazaba* el padding y el ancho no cambiaba. Falso:
con el contenido pegado al borde (`│sb-music`) se lee mal, y el artboard mantiene su padding adentro. El comentario
del código dice la versión correcta.

**Regresión atrapada revisando el trabajo del worker.** Al unificar el padding en un solo umbral, en frames de 4-5
columnas la fila perdía el nombre, porque `entryLine` usaba `>= 6` y el resto `>= 4`. El worker acomodó el test de 4 a
6 columnas; eso documenta el defecto en lugar de arreglarlo. Como el padding quedaba adentro del borde, el threading
de `pad` no hacía falta: se retiró y cada línea volvió a su umbral. El test de 4 columnas volvió a su expectativa
original.

Hallazgos de review cerrados acá: `R3-rule-width-empty` (test: en 4×12 no se dibuja ningún glifo de marco, y en
ancho 0 el frame es una lista vacía, no una fila de strings vacíos), `R2-001` y `R2-002` (la invariante de los dos
separadores ahora está nombrada: `listRowFits` y `ruleRows === 2`), `R2-003` (la asimetría `show`/`dispatch` en
`cyclePresence` explicada), `R2-004` (los dos seeds de test dicen por qué hace falta una pista sonando) y
`R2-jargon-refs` (el comentario del workflow expande qué es S19).

Los cuatro hallazgos de la review de esta unidad también se cerraron acá: `R3-001` era un **bug real** —el piso de 7
filas de `overlayHeight` pedía un overlay más alto que la terminal en pantallas de 5-6 filas—, corregido con un tope
en `rows` y fijado por test en 5, 6 y 8 filas; `R3-002` sumó una aserción de geometría en el frame mínimo (6×7, cada
línea exactamente 6 celdas); `R2-frame-thresholds` cambió los números mágicos por constantes derivadas de la misma
invariante que usan los separadores; `R2-underscore-names` renombró `width_`/`rows_` a `contentWidth`/`contentRows`.

Las líneas exactas de `tests/core/view.test.ts` las realineó un worker con instrucción de no borrar ni aflojar
aserciones: censo 81 → 90 (los nuevos son del marco), alturas +2 donde había que conservar las filas de lista. Tests
nuevos: marco en rol `border`, marco ASCII, y card demasiado chica sin marco. `pnpm check` verde: **308 tests / 73
suites**, `biome` 33 archivos, `tsc` limpio.

L43 (primera mirada a la card ya enmarcada, verbatim del dueño): "El borde quedó bien. La lista de musicas muestra la
duración así: Black Sabbath - Paranoid (Official […] Video).flac […] --:--". Ante la pregunta de dónde quedaba el
texto ajeno que no es de la card: "Está DENTRO del recuadro"; sobre las duraciones: "Las dos cosas juntas".

**Dos defectos, y uno era mío de método.**

1. **La card podía pedir más ancho del que entra.** `overlayOptions` pedía `width: "80%"` con `minWidth: 60` fijo: en
   una terminal más angosta que 60 columnas, Pi construía una card más ancha que su área y el terminal **envolvía cada
   línea** — el nombre partido en dos y el texto del host asomando por las columnas que la card no cubría. El renderer
   no tenía la culpa: `renderFrame` emite cada línea exactamente al ancho pedido (verificado en 46, 60, 78, 90 y 120
   con duraciones desconocidas). Lo que estaba mal era **pedir** ese ancho. Ahora el mínimo se deriva del terminal
   (`columns()`, con costura inyectable) y nunca lo excede.

   Antes de eso cometí un error de método que dejo escrito: hice la primera reproducción sobre un `main` local
   **atrasado** (sin el marco), así que el experimento no probaba el código desplegado. La repetición sobre la base
   correcta dio el mismo resultado —cero desbordes en el renderer—, pero la conclusión sólo vale desde la segunda.

2. **Las filas nunca aprendían la duración.** `Track.durationMs` viene del escáner, que lee nombres y no etiquetas
   (S5), así que un archivo local jamás tiene una: la columna decía `--:--` para siempre. Desde #33 la card **sí**
   aprende la duración de mpv, pero la gastaba en la barra de estado y en la esquina, y la olvidaba.
   Ahora `ViewOptions.knownDurations` lleva lo que el player reportó en la sesión y las filas lo usan; y cuando
   ninguna fila visible conoce su largo, **la columna no se dibuja** — una columna de `--:--` es chrome muerto que
   además nunca se llenaba.

Tests: cuatro nuevos en `tests/host/host.test.ts` — el mínimo se recorta a 38 con terminal de 40 columnas y queda en
60 con 120; un reporte de duración llena la fila aunque la pista no esté sonando; sin datos no aparece ningún `--:--`.
Hueco que esto destapó: los tests de vista usaban pistas **con** duración conocida, así que el camino `--:--` no tenía
cobertura y el cambio no se habría detectado solo. `pnpm check` verde: **314 tests / 76 suites**.

Pendiente declarado: el `knownDurations` vive en memoria de la sesión. Persistirlo es una decisión aparte (¿dónde,
con qué invalidación?), y hoy no hace falta: se llena sola con el uso.

L44 (verificación en el host de #42, verbatim del dueño). Preguntado si quedaba algún `--:--`: **"No"**. Preguntado
por el nombre largo: "Sale así en una sola fila: Black Sabbath - War Pigs.flac […] 7:55".

**T20 cerrada.** Las dos reglas de #42 se sostienen en Pi: ninguna fila muestra el placeholder, un nombre largo se
trunca en **una** línea en vez de partirse, y la duración aparece una vez que el tema sonó —el player es la única
fuente, porque el escáner lee nombres y no etiquetas (S5).

La causa del ancho se confirma por observación y no por deducción: con el mínimo derivado del terminal, la línea deja
de envolverse. Queda anotado que el `tput cols` nunca llegó: la corrección es correcta igual, pero la medición que
habría cerrado el diagnóstico sigue faltando.

Deuda viva de esta unidad, ya declarada: `knownDurations` vive en memoria de sesión. Al reiniciar Pi, cada fila vuelve
a no decir su largo hasta que el tema suene una vez. Persistirlo es una decisión aparte.

L45 (el dato que refuta el diagnóstico, verbatim del dueño): "tput cols" → **195**.

**El diagnóstico del ancho era falso.** Para que la card desbordara por el `minWidth: 60` fijo, la terminal tenía que
medir menos de ~62 columnas. Mide 195: el clamp introducido en `b3023c1` **no hace nada** en ese caso.

Queda entonces: el nombre partido que el dueño vio dentro del recuadro **desapareció**, y no sabemos por qué. El otro
cambio de esa unidad —la columna de duraciones con datos reales en vez de `--:--`— altera el ancho disponible en una o
dos celdas, y no alcanza para explicar el síntoma. Las dos hipótesis vivas son (a) un artefacto de observación —la fila
previa en pantalla o el texto de Pi al costado, mezclados al copiar— o (b) algo en cómo Pi compone el overlay que no es
visible desde este repositorio.

El clamp se conserva igual: pedir más ancho del que hay es incorrecto aunque en esta terminal no se note. Y el
`renderFrame` sigue cumpliendo su invariante —cada línea exactamente al ancho pedido—, verificado en 46, 60, 78, 90 y
120 con duraciones desconocidas.

Propuesta para no dejarlo como misterio: una guarda en el borde que, si una línea renderizada excede su presupuesto, la
trunque y lo registre con `SB_MUSIC_DEBUG`. No arregla una causa que no está identificada, pero convierte la próxima
aparición en evidencia en vez de en otra suposición.

L46 (T16, endurecimiento, autorizado por el dueño: "Dale al T16 + el latch del scan"). Cuatro defectos corregidos, y
el quinto —el scanner asíncrono— se separó a **T21** porque cambia el contrato del dep `scan` y no cabe en la misma
unidad revisable.

1. **Latch del primer scan** (el que incumplía S5). `show()` marcaba `loaded = true` **antes** de escanear, así que un
   `libraryRoot` ausente o sin permiso dejaba la card vacía **toda la sesión** con un toast ya desvanecido. Ahora el
   latch se pone sólo si el scan salió bien, y la próxima vez que se muestre la card se reintenta. Además la falla es
   **estado**: nuevo evento `notice` en el modelo, y el pie la mantiene con su ruta hasta que la card cargue otra cosa.
2. **Rechazos del player.** Los seis call sites (`play`, `pause`, `resume`, `stop`, `setVolume`, `quit`) iban con
   `void`; un `socket.write` que tiraba escapaba como rechazo no observado y la política de Node decidía. Ahora pasan
   por `guard()`, que avisa al usuario. En `play` además se limpia el reloj y se despacha `track-failed`: un play que
   nunca cargó no deja un reloj corriendo.
3. **`ctrl+c` — fuera de este ciclo.** La review paró el primer intento con un BLOCKER real (`R4-001`), y al corregirlo
   el validador dictaminó que el criterio original **no es alcanzable**: `Component.handleInput` devuelve `void`, así
   que una card enfocada no puede reenviar la tecla. `lib/host/component.ts` y su test **quedaron en la línea base**
   (comportamiento actual: cerrar la card, que libera el teclado), y la intención original pasa a **T22**, que necesita
   un cambio en el host. Ver **L48**.
4. **Tick ocioso.** `refresh()` forzaba un frame completo **cada segundo durante toda la sesión**, incluso con la card
   oculta y sin música. Ahora sólo repinta si hay overlay o algo sonando.

Tests: cuatro nuevos en `tests/host/host.test.ts` (reintento tras fallo, falla como estado en el pie, rechazo del
player sin reloj, tick silencioso sobre un overlay real ya oculto) y el del componente invertido. `pnpm check` verde:
**318 tests / 79 suites**.

T21 queda abierta: el dep `scan` es "synchronous by contract" y corre dentro de `onKey`; hacerlo asíncrono toca el
dispatch, el borde y dos tests que pinan la sincronía. Es una unidad propia, no un ítem de bolsa.

L47 (una decisión del dueño que no es implementable, y el BLOCKER que la destapó): la review nativa de T16 levantó
`R4-001` como **BLOCKER determinista** —"Ctrl-C with the music card focused is now consumed and dropped"— y tiene razón:
`Component.handleInput?(data: string): void` **no puede declinar una tecla**, así que "que `ctrl+c` pase al host" no se
puede escribir desde la card. Mi versión hacía `return`, que consumía la tecla y no hacía nada: peor que el
comportamiento original.

Decisión efectiva, distinta de la que se había registrado en L34: **`ctrl+c` cierra la card**. No es una preferencia
estética — es el único mecanismo disponible: cerrar libera el teclado, y la pulsación siguiente llega a Pi. Si algún día
el host expone una forma de reenviar la tecla, esto se revisa; hoy no existe.

Estado del trámite, que quedó abierto y **no se resuelve inventando nada**: la review nativa está en
`correction_required` y el plan de corrección **no se pudo enviar** por las vías disponibles — el `collectBinding` del
slot `correction_lines` se rechaza como "missing or stale for current STATUS" incluso tomándolo de un STATUS
inmediatamente anterior (parece invalidarse solo al pedir el siguiente), y `gentle_review_run` rechaza la lineage con
`selector-mismatch` tanto con `origin/main` como con el `base-ref` con el que nació. Todos los intentos registraron
`mutation_performed: false`. La corrección del código se hizo igual, porque el hallazgo era real y verificable a mano.

L48 (la review de T16 se detuvo, y por qué). Secuencia real, que deja rastro útil para la próxima:

1. Las dos lentes corrieron y entraron. El proveedor pidió un **refuter** y lo corrí: dictaminó `correction_required` con un
   **BLOCKER determinista** (`R4-001`) por el `ctrl+c`. El hallazgo era real y lo introduje yo.
2. Corregí el código... **antes** de enviar el plan. Error de secuencia: `--correction-lines` es un forecast
   *pre-edición*, así que al commitear moví el árbol congelado (`7a0bd7f2…`) y el pedido quedó viejo. El tool decía
   "stale for current STATUS" y tenía razón. Se detectó comparando `git rev-parse HEAD^{tree}` con el árbol congelado.
3. Restaurado el árbol (revert no destructivo), el plan se aceptó **por la CLI nativa**
   (`gentle-ai review capture-correction-plan`), no por el facade. 44 líneas de diff, dentro del presupuesto de 92.
4. El proveedor emitió un `validation_request` para `R4-001`. El validador es **host-mediated** para `pi`:
   `--execute` responde "unavailable for pi"; hay que materializar y correr el rol en el host. Se hizo con
   `--materialize` + el subagente `review-validator` + `--input`.
5. Veredicto: `correction_regression.passed = true`, `original_criteria.passed = **false**` — el criterio pedía que
   `ctrl+c` llegara a Pi, y eso **no es implementable**: `Component.handleInput` devuelve `void`.
6. El proveedor escaló (`targeted_validator_rejected`) y la lineage quedó en **stop terminal**
   (`native_stop_required`). No se continúa; el interruptor lo posee el dueño.

**Consecuencia técnica, que es el resultado valioso de todo esto:** la card **no puede** reenviar `ctrl+c` al host. La
decisión de L34 ("`ctrl+c` pasa al host") no es alcanzable desde este lado de la frontera; el comportamiento correcto
—y el que quedó en el código— es **cerrar la card**, que libera el teclado para que la pulsación siguiente llegue a Pi.
Lo que haría falta para cumplir la intención original es un cambio **en el host**, no en la extensión: eso es **T22**.

Estado del código al detenerse: `pnpm check` verde, **318 tests**, `ctrl+c` cierra la card con el motivo escrito, y el
resto de T16 (latch del scan, rechazos del player, tick ocioso) sin observaciones de la review más allá del BLOCKER.

L49 (la prueba en el host de T16 y T19, verbatim del dueño: "T16 con la ventana de sb-music abierta hice ctrl+c y
nada... no hace nada. T19: el borde exterior está perfecto y todo está en su lugar").
**T19 cerrada** con esa verificación. **T16 no**: `ctrl+c` con la card enfocada no producía ningún efecto.

1. **Causa, y por qué la suite no la vio.** `Component.handleInput` comparaba el chunk con el byte crudo
   (`data === "\u0003"`). Pi **negocia el protocolo de teclado de Kitty** (`\x1b[>…u` en `pi-tui/dist/terminal.js`), y
   un terminal que lo responde manda `ctrl+c` como CSI-u, `\x1b[99;5u`. El byte nunca era `\u0003`, así que la rama de
   cierre no se tomaba; después `translateKeys` lo traducía a `interrupt` —el id que el adaptador declara para `ctrl+c`—
   y la tabla de teclas **no conocía ese id**, así que el reducer lo descartaba en silencio. El test no lo vio porque
   presionaba el byte literal: verificaba la codificación que el código ya asumía, no la que el host manda.
2. **Arreglo.** El componente pregunta al host, que conoce todas las codificaciones: `matchesKey(data, "ctrl+c")` y
   `matchesKey(data, "escape")` (verificado: las flechas `\x1b[A`/`\x1b[B` no matchean `escape`, y `\x1b[27u` sí). Y
   `interrupt` recibe su binding `hide` en `KEY_BINDINGS`, para que el id deje de ser un callejón sin acción.
3. **Traza, para que la próxima ronda diagnostique en vez de adivinar.** Con `SB_MUSIC_DEBUG` la card registra ahora
   cada chunk tal como llegó (`input "<crudo>"`), sin escribir nada cuando la variable no está.
4. **Lo que sigue sin ser alcanzable:** al cerrarse, la card consume la tecla. Reenviar `ctrl+c` a Pi cuando la card
   tiene el foco sigue necesitando un camino del host → **T22**, sin cambios.

L50 (T16 cerrada en el host, verbatim del dueño: "Ya hice la prueba y con ctrl+c se cierra la ventana de
sb-music"). El diagnóstico de L49 era el correcto: la tecla no se reconocía por la codificación, no por el camino del
host. `ctrl+c` cierra la card y libera el teclado, que es el efecto que S21 buscaba de este lado de la frontera.

Queda abierto, sin confundirlo con esto: **T22** (reenviar `ctrl+c` a Pi con la card enfocada necesita un camino del
host) y una pregunta de alcance que el dueño todavía no decidió: si la card en **esquina** —pasiva, sin teclado—
debería ocultarse también con `ctrl+c`, lo que exigiría un listener de input sin foco.

L51 (limpieza del documento, autorizada por el dueño: "Solo Limpieza del documentos y otras limpiezas (veamos la
lista). T14 todavía no"). No cambia código: corrige lo que el documento afirmaba y ya no era cierto.

1. **T11 cerrada.** La fila decía "la suite es de 4 tests"; hoy son **320 tests / 79 suites**, `pnpm check` verde y
   `gate` verde en `main`. Era la única tarea abierta cuyo trabajo ya estaba hecho y medido.
2. **T5, T5b y T6 dejan de decir "PR pendiente".** Los tres están mergeados hace ciclos: PR **#8**, **#13** y **#10**.
3. **T16 con sus dos commits.** `5435f72` (latch, rechazos, tick, PR #46) y `7140488` (cierre por `ctrl+c`, PR #49);
   la columna decía "sin commit" porque el commit llegó después de cerrar la fila.
4. **Handoff de diseño.** `01-lista-unica.html` queda implementado: la card real existe en `lib/core/view.ts` y
   `lib/host/component.ts`. `03-mini-card.html` sigue en `sent` a propósito: la card de esquina existe, pero el
   artboard no se comparó contra ella, y marcarlo implementado sin esa comparación afirmaría algo que nadie miró.

L52 (**T13 implementado**, S17: click, rueda y hover cableados de punta a punta). No hay verificación en el host
todavía: el mouse es lo único que CI no puede tocar, así que la fila queda `hecho` con esa deuda escrita.

1. **El contrato del host, leído y no adivinado.** `@earendil-works/pi-tui` expone `Component.handleMouse?
   (event: TuiMouseEvent)`, con `type` `press|release|move|drag|click|wheel` y coordenadas **locales al
   componente**. `TuiBase.dispatchMouseToOverlay` resta `layout.col`/`layout.row` antes de entregar, así que `y`
   es el índice de línea del frame que devolvimos. Y el `click` **se sintetiza**: `handleMouseEvent` en
   `tui-alt-screen.js` sólo lo construye si el `press` anterior fue contestado, y lo reenvía al target del press
   con `retargetMouseEvent`. Consecuencia de diseño: el componente acepta el `press` (aunque no haga nada con él)
   porque si no, el click nunca llega. Verificado contra el código real de dispatch, no contra la firma.
2. **La traducción vive en el adaptador (S17).** `lib/host/component.ts` guarda el `HitMap` del frame que está
   pintando y resuelve `event.y → EntryHit.index`; el núcleo recibe eventos de datos (`PointerEvent`: `hover`,
   `click`, `wheel`) con un índice de `visibleEntries` y nunca una coordenada. `renderFrame` no cambió: ya devolvía
   `hits` desde T6, incluido el corrimiento de una fila por el borde (issue #36).
3. **El reducer (S17).** `click` selecciona y después activa: es exactamente el par `cursor + enter`, así que
   carpeta entra, archivo reproduce con la cola de S11 y sin una segunda regla de activación. `wheel` mueve el
   cursor como las flechas, con tope en los dos extremos y sin tocar la reproducción. `hover` guarda el índice de
   la fila bajo el puntero en el estado, que es lo único que hace que el frame se invalide solo: la caché del
   componente compara identidad de estado, así que un hover que no llegara al estado no podría repintar nunca.
4. **Hover = peso, no un segundo fondo.** El cursor ya es dueño de `surface` + `▸`; un hover con el mismo fondo
   habría dejado dos filas idénticas y hecho impredecible cuál abre `enter`. El puntero cambia **solo el peso del
   nombre** (`theme.bold`): es una señal que no es otro color, no agrega ni mueve una celda (los tests lo
   verifican con líneas exactas y con la misma línea en tema plano), y no toca las celdas de marcador, así que las
   tres combinaciones de S3 siguen leyéndose igual.
5. **El hover se apaga cuando deja de ser cierto.** Con una tecla (el teclado manda), con la rueda (las filas se
   mueven debajo de un puntero quieto), cuando llega otra carpeta y cuando la card se oculta. Límite conocido y
   escrito: el host no emite “el puntero salió del componente”, así que salir de la card sin pasar por otra fila
   deja el resaltado hasta el siguiente evento; se apaga con la próxima tecla o movimiento.
6. **Decisiones que S17 no toma, y por eso no se inventaron.** Un click en la **card de esquina** se ignora: S15
   la declara readout pasivo y no dibuja filas ni `hits`, así que no hay nada que activar. Un click **no pide
   foco**: S17 habla de selección y activación, no del teclado, y S4/S15 piden que la card no se lo quite al
   editor. Queda abierto, para que lo decida el dueño: (a) si el click debería enfocar la card, (b) qué hace el
   mouse en **modo filtro** —acá rige la regla literal de S17, un click activa la fila donde cae—, (c) si la
   esquina debería hacer algo con un click.
7. **Un click repetido se consume.** El segundo click de un doble click se contesta y no se reduce: la lista bajo
   el puntero ya puede ser otra (se entró a una carpeta), y reducir el repetido activaría una fila que nadie
   eligió.
8. **En tmux/zellij/screen el hover se degrada solo.** `tui-alt-screen.js` habilita `1003h` (todo movimiento) sólo
   fuera de multiplexores; adentro pide `1002h` (movimiento con botón apretado), así que ahí el hover no llega y
   click y rueda sí. No es una decisión nuestra y no se compensa desde acá.

9. **Dónde vive el mouse del host, verificado en pi-coding-agent.** `createInteractiveTui`
   (`dist/modes/interactive/tui-renderer.js`) construye `TuiAltScreen` con `tuiMode: "fullscreen"` —el **default** de
   `settings-defaults.js`— y `TuiMainScreen` con `"regular"`. El dispatch de mouse (`dispatchMouseToOverlay`,
   `handleMouseEvent`, el `1003h` de tracking) vive **sólo** en el alt-screen: en modo `regular` el host ni siquiera
   habilita el reporte de mouse, así que S17 se cumple en el modo por defecto de Pi y no en el otro, sin que la card
   pueda hacer nada al respecto. Lo que sí se verificó es que las secuencias de mouse no se convierten en teclas:
   `translateKeys` no las matchea con ningún binding y no llega nada al reducer.

Evidencia: 351 tests / 83 suites, `pnpm check` verde, y la verificación del dispatch real (press → click
retargeteado → índice de fila) hecha con el código de pi-tui, no con un fake. La prueba en Pi queda pendiente:
`pi -e ./extensions/sb-music.ts`, card expandida, click sobre una carpeta y sobre un tema, rueda sobre la lista,
puntero sobre una fila.

Cierre de dos preguntas abiertas, verbatim del dueño (misma sesión que T13):

1. **T23 no se hace.** "Este No lo vamos a hacer: T23 (ctrl+c oculta también la card en esquina), no es necesario."
   La card en esquina es un readout pasivo sin teclado: ocultarla con `ctrl+c` no aporta, y agregarle un listener
   sin foco sería superficie nueva para nada. T23 nunca llegó a ser fila de la tabla; queda como decisión, no como
   pendiente.
2. **Hallazgo, todavía sin decidir:** `settings.shortcuts` declara `playPause`, `next` y `prev`, el parser las
   acepta como claves válidas, y **nada las registra**: sólo `overlay` llega a `pi.registerShortcut`. Son config
   muerta. La decisión —implementarlas o retirarlas— queda abierta, y con ella si `/sb-music --keys` sirve para
   leerlas, escribirlas, o las dos cosas. Motivo del hallazgo: el dueño preguntó "¿no las utilizamos para nada? Es
   así?" revisando las teclas que íbamos a documentar en el README.

L53 (T13 cerrada con la verificación del dueño, verbatim: "Ya hice la prueba y si funciona el mouse"). El mouse
funciona en Pi: hover sobre las filas, click en carpeta y en track, rueda. La deuda que dejó `L52` queda saldada, y la
cadena completa fue: issue **#51** → candidato `e0d22a0` / `eb081c2` → review nativa aprobada (lentes `resilience` +
`reliability`, lineage `review-393f6e47630ac039`, autoridad quemada) → `gate` verde → smoke del dueño → merge
(**PR #52**).

Dos hallazgos **no bloqueantes** de esa review pasan a **T24**, sin reabrir el candidato: el proveedor los declaró
informativos y su receipt sigue en pie.

1. `R4-hit-map-staleness` (WARNING, `lib/host/component.ts:110`): el hit map se captura al renderizar y no se
   invalida si el modelo cambia antes del próximo frame. Un segundo click en esa ventana puede activar una fila
   **in-range del listado anterior**; la guarda del reducer evita el fuera de rango, no la fila equivocada.
2. `R3-002` (SUGGESTION, `lib/host/component.ts:176-180`): el caso `click` con `clickCount > 1` no consulta el hit
   map, así que las dos guardas no coinciden sobre cuál manda. Hoy es benigno porque el `press` ya declinó.

L54 (T24, autorizada por el dueño: "Dale a T24 y luego vemos las dudas"). Los dos hallazgos no bloqueantes de la
review de #52 quedan cerrados en el host, no en el core.

1. **`R4-hit-map-staleness`.** El mapa de `hits` es geometría de un arreglo concreto de filas. La corrección no
   compara el estado entero: eso hubiera dejado al puntero sordo un frame cada vez que el hover cambiaba el estado.
   Lo que invalida el mapa es **lo que mueve las filas**: listado, filtro, cursor (el scroll que implica) y tamaño.
   Todo lo demás —el track sonando, el reloj, el propio highlight— deja las filas donde están. Con eso, un click que
   cae entre el cambio de listado y el próximo frame **no se resuelve**, que es la falla segura: se descarta el gesto
   en vez de activar una fila que nadie clickeó.
2. **`R3-002`.** Una sola guarda decide si hubo fila: el `click` sin hit devuelve `undefined` (no es nuestro) y el
   click repetido se contesta recién después, sin despachar nada. Antes las dos ramas no coincidían sobre cuál manda.

Tres tests nuevos, primero en rojo: la ventana entre el cambio de listado y el frame (con el mapa viejo, el índice
seguía siendo válido y activaba la fila equivocada), la guarda única del click, y la contracara del estrechamiento
—un hover no vuelve obsoleto el frame— para que nadie "simplifique" de vuelta a comparar el estado entero.

L55 (el dueño eligió la opción E de la consulta de teclas, y encendió las tres de transporte). Textual: "Listo,
hagamos esta opción E con /sb-music --keys clave=valor y todo lo que recomiendas. Se implementan las 3 teclas
(pausa/siguiente/anterior)".

Qué se descartó y por qué, para que no vuelva como idea nueva: **convertir `/sb-music` en un menú** de settings. El
argumento era razonable ("ya se hace con `ctrl+alt+z`"), pero la tecla no siempre está — conflicto con un atajo de Pi
que la descarta en silencio, AltGr en teclados no-US, y TUI no-fullscreen — así que el comando tiene que seguir siendo
la puerta. Tampoco hay menú editable: Pi registra las shortcuts al bindear la sesión, así que el cambio rige en la
próxima sesión; un menú que promete inmediatez y entrega un reinicio es peor que un archivo documentado.

Dos unidades revisables: **T25** (issue #56) registra las tres de transporte, **T26** (issue #57) es `--keys` + las
descripciones + la tabla del README. T25 va primero porque el texto que imprime `--keys` tiene que decir la verdad
sobre qué está registrado.

L56 (T25 implementado: las tres de transporte, y las dos descripciones que mentían). Cubre S22 requisitos **1** y **8**.
Sin commit todavía: el carril de código exige issue aprobada antes de la rama y la prueba del dueño en el host antes de
cerrar la fila.

1. **El evento del modelo.** `CardEvent` gana `{ kind: "transport"; action: TransportAction }`, con
   `TransportAction = Extract<KeyAction, "toggle-pause" | "next" | "previous">`: el vocabulario es el de la tabla de
   teclas, así que "pausar", "siguiente" y "anterior" significan una sola cosa en el módulo. **No pasa por `pressKey`**
   a propósito, y el comentario lo dice: la guarda "las teclas sólo llegan a una card en pantalla" es correcta para una
   tecla de la card y exactamente falsa para un shortcut global, que llega con la card oculta — es su razón de ser. Lo
   que sí comparte son las acciones (`togglePause`, `advance`, `previous`), así que sigue habiendo **un** camino de
   reproducción y los efectos siguen saliendo como datos (S8). Se descartó la alternativa de relajar la guarda de
   `pressKey` o agregar un flag de "ignorá la presencia": las dos convertirían una regla honesta en una condicional, y
   cualquier tecla de la card podría colarse por la ventana.
2. **El host registra cuatro.** `registerTransport(key, action, description)` da una sola forma a las tres, para que
   ninguna pueda olvidarse de `startSession(shortcutCtx)`: una shortcut pulsada antes de que la card se abriera tiene
   que construir el modelo y el player sola. Las tres van guardadas por `mode !== "tui"`, igual que `overlay`, y
   despachan por `dispatch({ kind: "transport", … })`, nunca contra el player.
3. **Las descripciones dicen la verdad (requisito 8).** El comando sigue abriendo la card y ahora anuncia la tecla del
   ciclo —`Open the music card · <overlay> cycles it`, con la tecla **configurada** y no un literal, porque el usuario
   puede cambiarla—, y el shortcut del overlay dice `Music card: cycle hidden → corner → expanded` en vez de
   "Show or hide". Las tres de transporte dicen `Music card: pause or resume`, `…: next track` y `…: previous track`.

Test-first, un RED por regla: `tests/core/model.test.ts` (3 fallas reales — el reducer no conocía el evento) para
"pausa y reanuda con la card oculta", "mueve la cola con la card oculta" y "no hace nada sin cola"; y
`tests/host/host.test.ts` (5 de 6 en rojo) para "registra las cuatro", "las descripciones", "construye la sesión sin
que la card se haya abierto", "pausa/reanuda oculta" y "siguiente/anterior oculta". Dos tests son guardas que ya
pasaban por construcción, y se declaran así: **una card oculta sigue ignorando `space`/`n`/`p` como teclas** (la
guarda de presencia no se aflojó) y **ningún shortcut hace nada en un modo sin TUI** (con las shortcuts ausentes
pasaba de forma vacía; ahora pincha si alguien registra sin la guarda). Triangulación: `next` en el último tema
termina la cola (`stop` y barra sin segmento) en vez de envolver, o sea `advance` y no un "skip" nuevo.

`pnpm check` verde: **367 tests / 87 suites**, `biome` 35 archivos, `tsc` limpio.

**Sigue abierto de S22, sin inventarse:** requisitos 2–7 y 9 son **T26** —`--keys`, la escritura atómica, la
validación, `--help` y la tabla del README—. El requisito 2 (el comando abre la card) se conserva tal cual y este
cambio no lo toca. Tampoco se decide acá si las tres teclas deberían **ceder** el paso al editor cuando la card tiene
el foco (hoy Pi las entrega al overlay enfocado y el `overlay` sí se reenvía desde el componente): S22 no lo pide y no
hay tecla duplicada que lo obligue.

Pendiente para cerrar T25: la prueba del dueño en el host —`pi -e ./extensions/sb-music.ts`, reproducir algo, ocultar
la card con `ctrl+alt+z` y probar `ctrl+alt+space`/`n`/`p` desde el editor—, más la verificación de que Pi las acepta
como claves válidas.

L57 (T25 cerrada con la verificación del dueño, verbatim: "Hice la prueba y funciona perfecto"). Las tres teclas
funcionan desde el editor con el modelo y mpv vivos aunque la card nunca se haya abierto, que es justo lo que la
guarda de presencia de `pressKey` habría impedido si el shortcut se hubiera despachado como key id.

Queda abierto de T25, declarado y no verificado: si Pi acepta esas tres combinaciones sin chocar con un binding suyo
y si las despacha con el overlay enfocado. La respuesta a lo primero la va a dar T26 (validación y cambio de teclas);
lo segundo sigue siendo del host.

L58 (T26 implementado: `/sb-music --keys` lee y reconfigura las teclas). Cubre S22 requisitos **3, 4, 5, 6, 7 y 9**;
el 1 y el 8 los cerró T25 y el 2 se conserva tal cual (sin argumentos el comando sigue abriendo la card).

1. **La edición es pura** (`lib/settings.ts`): `editShortcuts(settings, pares, knownKeys)` devuelve la `settings`
   resultante o un error, más la lista de cambios. Una negativa **no devuelve settings en absoluto**, así que el
   llamador no puede escribir medio cambio: eso es la atomicidad, no una bandera. Reglas, cada una con su mensaje:
   modificador obligatorio (`ctrl`/`alt`/`shift`, una letra pelada robaría la tecla del editor), sin duplicados
   entre las cuatro (la comparación es por identidad, así que `alt+ctrl+n` colisiona con `ctrl+alt+n` y también
   colisiona contra una tecla que nadie editó), nombre existente (lista los cuatro), valor producible por Pi
   (lista los válidos agrupados: `a–z · 0–9 · f1–f12 · <nombres> · <símbolos>`), y `=default` restaura el default
   documentado. El escritor es el de siempre, expuesto como `saveSettings(ctx, settings): SaveResult` — un fallo de
   disco vuelve como dato, nunca como excepción.
2. **La gramática es nuestra; el vocabulario es del host.** `@earendil-works/pi-tui` **no exporta** forma de validar
   un key id: `parseKey` va de secuencia cruda a id (en la dirección contraria) y `matchesKey` pide la secuencia, así
   que no hay ida y vuelta. `@earendil-works/pi-coding-agent` sí tiene el schema autoritativo (`dist/core/key-id-schema.js`,
   un `Type.Unsafe` con `pattern`), pero **no está en su mapa de exports** (`"."` y `"./rpc-entry"` solamente), así que
   importarlo sería un deep import privado. Lo que sí es del host es el **vocabulario**: `HOST_KEYS` en `lib/host/host.ts`
   se arma con `Object.values(Key)` —la misma tabla de la que el schema del host deriva sus nombres base— más las
   letras y dígitos sueltos que ese schema agrega. `lib/settings.ts` lo recibe como parámetro y no importa nada del
   host (S8, y el test de frontera lo afirma). Lo que queda propio es el **grammar** (`modifier+…+key`, modificadores
   en minúscula, sin repetir), escrito acá y no en el host.
3. **Superficie de impresión: `ctx.ui.setWidget`.** El `ExtensionUIContext` no tiene un `print`: `notify` es una línea
   de estado (una tabla ahí se mutila) y `custom()` es un overlay interactivo, justo lo que `--keys` no debe construir.
   El widget de strings es la única superficie multi-línea no interactiva (TUI y RPC) y el host la trunca a **10
   líneas** (`InteractiveMode.MAX_WIDGET_LINES = 10`, verificado en el código), así que el reporte mide 7 líneas y
   `--help` exactamente 10; hay un test que falla si el reporte crece más. En **print/JSON** el host instala un UI
   context no-op (`noOpUIContext` en `ExtensionRunner`): ahí no hay superficie para varias líneas, y lo más cercano
   —un `notify` con las líneas unidas— es lo que se usa. `--keys` **no** tiene la guarda `mode !== "tui"` que sí tiene
   abrir la card: es texto, y el texto no necesita pantalla.
4. **Qué dice el reporte, y de dónde.** Las filas salen de lo que esta sesión **registró de verdad**: `registerShortcut`
   anota tecla y descripción al registrar, así que el reporte no puede mentir sobre qué está activo. Las teclas de
   adentro de la card salen de `footerHints()` (la tabla única de S13), no de una segunda lista. Después de guardar,
   el host **no** reescribe su `deps.settings`: Pi bindea las shortcuts al inicio de la sesión, así que la fila muestra
   la tecla activa y, al lado, `· file <nueva>, next session`. Esa es la razón por la que el mensaje de éxito dice
   explícitamente que el cambio rige en la próxima sesión (requisito 6) en vez de prometer inmediatez.
5. **Decisiones donde S22 calla, todas declaradas.** (a) Un argumento desconocido (`/sb-music --key`, `/sb-music next`)
   **no abre la card**: imprime el error y la sintaxis, porque ignorar lo que el usuario escribió es el mismo defecto
   que ignorar una tecla. (b) `super` es válido para el host y **no** se acepta acá: el vocabulario y la gramática
   prometen `ctrl`/`alt`/`shift`, que es lo que S22 nombra. (c) Se acepta `overlay=default` con la palabra exacta;
   `nombre=` vacío se rechaza como «empty». (d) `--help` ignora tokens de más en vez de pelearse por ellos.

Test-first, un RED por regla. `tests/settings.test.ts` (10 nuevos): «applies several pairs and says what changed»,
«refuses a bare key…», «refuses two keys that would become the same, including the overlay key», «refuses a name that
is not one of the four…», «refuses a key name the host cannot produce and lists the valid ones», «refuses an unusable
value: a repeated modifier, an unknown one, or no key at all», «restores the documented default with `=default`»,
«changes nothing when one pair of several is refused», «reads without writing…» y «writes the saved file atomically,
and reports a failure instead of throwing». `tests/host/host.test.ts` (7 nuevos): «prints the effective keys, the
resolved file and the card's own keys, and opens nothing» (incluye el tope de 10 líneas), «prints the syntax with
`--help`», «saves once with the expected settings and says where and when it applies», «writes nothing when one pair
is refused, and names the pair», «will not overwrite a settings file it could not read», «prints instead of refusing in
a mode that cannot host the card» y «refuses an argument it does not know instead of opening the card». RED observado:
las 6 del host fallaban porque los argumentos se ignoraban y la card se abría, y el módulo de settings no exportaba
`editShortcuts`/`saveSettings`. Triangulación que cambió el código: `overlay=f13` daba «has no modifier» y el defecto
era el orden de las reglas —un nombre que no existe no se arregla agregando un modificador—, así que el vocabulario se
chequea antes.

**Una guarda que S22 no pide y S2 sí:** si el archivo no se pudo usar, `loadSettings` lo deja intacto a propósito (L19)
para que el dueño pueda arreglarlo; que `/sb-music --keys` lo reescriba sería la forma de saltarse esa regla, así que
con `warning` presente la escritura se rechaza y el mensaje nombra el problema.

`pnpm check` verde: **384 tests / 89 suites**, `biome` 35 archivos, `tsc` limpio. `README.md` gana **Keys** y
**Changing the keys**: las cuatro globales con lo que hacen, las de adentro de la card, `⌥` para `alt` en macOS, y el
comando más el archivo. Se corrigieron de paso dos frases que ya mentían: `l` (no existe desde L38) y «suelta el
teclado al elegir un tema» (desde L31 lo conserva mientras está enfocada).

**Pendiente para cerrar la fila**, y es la lección repetida del documento: la prueba del dueño en el host —
`pi -e ./extensions/sb-music.ts`, `/sb-music --keys`, `/sb-music --help`, `/sb-music --keys overlay=ctrl+alt+m`, y
ver que la tecla vieja sigue andando hasta reiniciar Pi y la nueva después—, más si Pi acepta la combinación nueva sin
chocar con un binding suyo.

L59 (T26 cerrada, y el hub se va al final). Verificación del dueño, verbatim: "Perfecto, funciona todo". El ciclo S22
queda completo: las cuatro teclas registradas (T25), `/sb-music --keys` leyendo y reescribiendo con las cuatro
validaciones, `--help`, y el README documentando lo que existe.

Decisión de producto del dueño sobre la publicación en el hub de Gentle, verbatim: "La Publicación en el hub de Gentle
recien la haremos cuando el proyecto se encuentre totalmente listo. Dejalo para lo ultimo eso". El disparador que
estaba escrito en `AGENTS.md` —"que exista un slice que corra de verdad"— ya se había cumplido, así que quedaba
vencido; se reemplazó por **el backlog de v1 cerrado** (sin tareas abiertas y sin hallazgos de review pendientes),
que es observable. Un riesgo aceptado sin disparador vigente no está aceptado: está olvidado.
L60 (`R3-001` cerrado: con un `settings.json` malformado, `--keys` imprimía los defaults en memoria sin decir una
palabra, mientras que guardar sí se negaba por el mismo motivo). Era el peor momento para callarse: el usuario
pregunta qué teclas tiene justamente cuando quiere entender por qué no le guarda. El reporte ahora imprime el aviso
del loader y aclara que la tabla son defaults en memoria; sigue sin escribir nada, sin abrir la card, y entra en el
tope de diez líneas del widget (nueve).
L61 (`03-mini-card.html` superado, no pendiente). El artboard se mandó el 10/11 y quedó en `sent` con `startedAt`
`null`: nunca se recogió. No era una fila abierta del backlog sino un handoff huérfano, y la pregunta «¿está
implementado?» tenía respuesta incómoda en las dos direcciones: la **dirección** se entregó (la card de esquina es el
estado por defecto, T17, verificado en el host en `L41`), pero **el artboard no**, y no corresponde entregarlo: dibuja
siete filas —header, barra, carpeta, tema actual, próximo— y anuncia `l browse` en el pie, mientras S15 pide **dos
filas** (glifo, tiempo y barra; el título lo posee la barra de estado) y `L38` retiró `l`. Se dibujó antes de que la
spec se corrigiera.

El canvas sólo entiende `queued`, `sent`, `in_progress` e `implemented` (`canvas-handoffs.js` 
`handoffKind` devuelve `null` para cualquier otro valor), así que «superado» no tiene badge: cerrarlo como
`implemented` habría afirmado algo que nadie miró, que es el error que el propio documento ya anotó. Se quitó la
entrada huérfana de `handoffs.json` —la fila deja de mentir sobre su estado— y el motivo quedó escrito donde se lee:
un aviso al principio del artboard y este `L61`. `chosen` sigue apuntando a `03` porque la dirección elegida es
correcta; lo que envejeció es el contenido del mockup, no la decisión.
L62 (T21 arrancado: el contrato asíncrono y el estado de lectura). Pedido del dueño, verbatim: "Dale al T21".
`S21.5` se reescribe con el contrato que se congela —promesa, falla como dato, camino de input sin esperar, guarda
de secuencia— y con una decisión de producto que la spec vieja no tomaba: qué se ve mientras la lectura está en
vuelo. Se presentaron tres opciones y el dueño eligió, verbatim: "Estado «leyendo <ruta>…» en el pie
(recomendada)". Las otras dos eran pintar la card vacía y llenarla después —barato, pero afirma "carpeta vacía"
durante segundos justo en el mount lento que motiva la tarea— y diferir el paint hasta que llegue el scan, que en
ese mismo mount hace que el comando parezca no hacer nada.

La guarda de secuencia **no** la pidió S21.5 y entra igual: es un defecto que el cambio de contrato **crea**. Hoy,
con `scan` sincrónico, dos pedidos no pueden solaparse; con una promesa, sí, y el que resuelve último gana aunque
sea el pedido viejo. Un cambio que introduce una condición de carrera y no la cierra no está terminado, aunque
compile.
L63 (T21 implementado). Cinco archivos: `lib/library/scan.ts` pasa a `node:fs/promises` (`realpath`/`readdir`/`stat`)
y devuelve una promesa; `lib/host/host.ts` arranca la lectura y vuelve, con token de secuencia, `readingPath` para no
leer dos veces la misma carpeta y el latch de `L46` movido al éxito; `lib/core/model.ts` gana el campo `reading` y el
evento `folder-reading`; `lib/core/view.ts` lo pinta en el pie con la **misma forma del breadcrumb** —nunca una ruta
absoluta de HOME, que S15 prohíbe y un test ya pinaba—; `extensions/sb-music.ts` no cambia, porque el tipo nuevo lo
absorbe.

**Una corrección a S21.5, que ya estaba escrita y ahora se sabe falsa:** decía que arreglar esto «rompe dos tests
que pinan la sincronía». No los rompe. El pedido al scanner sigue saliendo **sincrónicamente** desde `handleInput` y
`show()`, y eso es lo correcto: lo que deja de ser sincrónico es la **respuesta**. Diferir el pedido no habría
quitado ninguna espera, sólo habría agregado una vuelta. La spec se corrigió en el mismo commit.

**Sobre el test-first, con honestidad:** escribí los tests y la implementación en la misma pasada, así que el primer
run fue el suite completo y no un RED aislado. Lo que sí verifiqué es que el test de la carrera es *load-bearing*:
quitando el chequeo del token, `drops an answer for a folder the card already left` falla y el resto sigue verde.
Restaurado y verde otra vez. Un test que no se puede romper no prueba nada.

Tests nuevos: dos en `scan.test.ts` (promesa, y falla por la promesa sin tirar), tres en `model.test.ts` (registra,
limpia al llegar, limpia al fallar), dos en `view.test.ts` (breadcrumb y que el fallo manda), tres en
`host.test.ts` (vuelve sin esperar, descarta la respuesta vieja, no lee dos veces la misma carpeta, y sobrevive
un dep que tira). Todos los de `scanFolder` pasan a `await`. `pnpm check` verde: **396 tests / 91 suites**, biome 35
archivos, `tsc` limpio.

**Verificación independiente (`gentle-ai-verify`, riesgo ítem 4):** siete afirmaciones, siete HOLDS —scan asíncrono
sin `*Sync` y con rechazo imposible, camino de input sin `await`, token sin corredor (los dos callbacks chequean
antes de tocar `readingPath`/`loaded`/`dispatch`), latch sólo en éxito, `reading` limpio en los dos desenlaces con
breadcrumb, y `lib/core` sin `async`. Devolvió **un agujero residual real**: si un dep mentiroso lanzaba
sincrónicamente, el throw escapaba al editor **con `readingPath` ya seteado**, y esa carpeta quedaba trabada para
toda la sesión —un candado invisible que ningún test cubría—. Se cerró con un `try/catch` alrededor de la llamada y
un test que lo pinea; esta vez el RED se observó aislado, como corresponde: falló ese test solo, 53 en verde.

**Pendiente para cerrar la fila**, la prueba del dueño en el host: `pi -e ./extensions/sb-music.ts`, abrir una
carpeta grande y una lenta, ver que el editor sigue respondiendo mientras se lee, que el pie dice `reading <carpeta>`
y que después aparece la lista. Es la misma lección de siempre: el gate verde no es la prueba.

**Hallazgo que no es mío y no toqué:** el `notice` de fallo sigue imprimiendo la ruta absoluta (`cannot show
/home/…: missing`), que contradice la regla de S15 sobre rutas de HOME. Queda anotado como follow-up: cambiarlo
toca un test que pina el mensaje de S5, y no entra en esta unidad.
L64 (T21 cerrada). Verificación del dueño en el host, verbatim: "Ya hice la prueba... abrí la carpeta mp3 e hice
busquedas / y funcionó bien". La navegación a una carpeta real y el filtro seguido por teclado son el camino que
el cambio tocaba: cada `/` sobre la carpeta recién leída pasa por el estado de lectura, por el token y por el
latch. El caso del mount lento sigue sin medirse con un reloj, y no se afirma que esté medido: lo que está
probado es que el camino funciona y que el editor no esperó al disco en ninguno de esos pasos.
