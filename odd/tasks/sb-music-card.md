# sb-music-card

Extensión de Pi / Gentle Shell `@egkike/pi-streambeats`: card de música (`/sb-music`) que navega la
biblioteca local de StreamBeats y reproduce con mpv, sin sacarle el teclado al editor.
Este documento es la especificación que leen los workers. Sin repo git todavía: **no hay commits**.

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
fallback a `https://mpv.io/installation/` cuando no hay match; `c` copia el comando y `r` reintenta.

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
`enter` entra a una carpeta o reproduce un archivo; `u` y `\u232b` suben de carpeta; `esc` oculta la card salvo en modo filtro, donde primero lo limpia (S18); `l` expande y colapsa (S15);
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

S15 — Dos estados. **Esquina (por defecto):** la card vive abajo a la derecha, chica y anclada, y muestra
sólo tiempo y barra de progreso — el título lo posee la barra de estado (S12). **Expandida:** `l` la abre a la
lista completa de S3 y `l` o `esc` la devuelven a la esquina, sin perder cursor ni carpeta. `/sb-music` abre
expandida; la tecla `overlay` muestra u oculta la card y, si estaba oculta, aparece en la esquina. Al iniciar
una sesión de Pi arranca colapsada.

S16 — Glifos. Una sola familia geométrica: `●` reproduciendo, `○` pausado, `▸` cursor, `▾` expandido, `━`/`─`
progreso. Nunca emoji en el chrome. `settings.asciiGlyphs: true` cambia la familia a ASCII (`*`, `-`, `>`, `v`,
`=`) para terminales donde los geométricos ocupen dos celdas. **No hay detección automática**: es una decisión
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

## Tasks

| ID | S# | Tarea | Ruta | Commit |
|----|----|-------|------|--------|
| T1 | S1 | Scaffolding: `package.json`, `tsconfig.json`, `README.md` | inline | n/a |
| T2 | S2, S10 | `lib/settings.ts`: defaults, lectura, escritura atómica, malformado | worker | n/a |
| T3 | S7 | `lib/types.ts` + interfaz de resolución | worker | n/a |
| T4 | S5, S14 | `lib/library/scan.ts`: carpeta actual sin recursión, extensiones, ocultos, estados | worker | n/a |
| T5 | S3, S11, S13, S15, S18 | `lib/core/model.ts`: estado, cursor, sonando, cola, navegación, teclas y filtro | worker | n/a |
| T6 | S3, S9, S16, S17 | `lib/core/view.ts`: `renderFrame` con roles, glifos, marcadores, truncado, progreso, hits | worker | n/a |
| T7 | S12 | `lib/core/now-playing.ts`: limpieza de nombre y formato del segmento + tests | worker | n/a |
| T8 | S6, S11 | `lib/player/mpv.ts`: spawn, IPC, pausa/next/prev, auto-avance, errores, shutdown | worker | n/a |
| T9 | S1, S4, S12 | `lib/host/` + `extensions/`: overlay, unfocus, shortcuts, status line, comando | worker | n/a |
| T10 | S8 | Test de frontera de capas + test del adaptador con host falso | worker | n/a |
| T11 | S9 | Suite completa verde y reporte | inline | n/a |

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
