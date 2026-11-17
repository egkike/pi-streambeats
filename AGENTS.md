# Agent Conventions & Project Standards

Convenciones para agentes que trabajen en este repositorio. Es un contrato: si algo acá no es
verdad, se corrige el archivo o se corrige el código, nunca se ignora en silencio.

## Project Context & Stack

`@egkike/pi-streambeats` es una **extensión de Pi / Gentle Shell**: una card de música (`/sb-music`)
que navega una biblioteca local y reproduce con **mpv**. No es una app independiente ni una TUI
propia: se monta sobre la UI del host.

- Runtime: el de Pi. Módulos TypeScript ESM cargados **jiti**, sin compilación ni `dist/`.
- Node: el del host (`engines.node >= 22.19`). El piso se declara, no se asume.
- Reproducción: proceso `mpv` controlado por JSON IPC sobre un socket unix.
- Tests: `node --test` sobre TypeScript directo.
- **Cero dependencias de runtime.** Si una tarea parece necesitar un paquete, primero es una decisión
  que se discute, no un `pnpm add`.
- **El host no es una dependencia de runtime.** `@earendil-works/pi-coding-agent` y `@earendil-works/pi-tui` van en
  `peerDependencies` (`"*"`) y en `devDependencies` con la versión que corre el host, para compilar contra las
  declaraciones reales; `lib/host/` los importa **sólo como tipos**. `pnpm-workspace.yaml` existe por eso: pnpm
  exige decidir de forma explícita sobre dos transitivos del host (`@google/genai`, `protobufjs`) cuyos scripts de
  build no necesitamos. No borrar esas claves sin leer este párrafo.

## Source of Truth

`odd/tasks/<feature>.md` es la especificación. Cada `S<n>` cita requisitos del usuario **verbatim** y
cada `L<n>` del `## Log` registra pedidos, correcciones y evidencia. Un agente lee el documento
**hasta el final del `## Log`** antes de escribir código, y responde qué `S#` cubrió. Nunca al revés:
el código no redefine la spec.

## Code Organization

```
extensions/      entry points: registran comando, shortcuts y status line
lib/host/        ÚNICO importador de @earendil-works/* (adaptador de la UI del host)
lib/library/     filesystem: listar la carpeta actual
lib/player/      proceso mpv + socket IPC
lib/core/        puro y sincrónico: estado, reducer, vista, formato del now-playing
lib/settings.ts  JSON con escritura atómica
lib/types.ts     el vocabulario compartido (Album, Track, Target, Failure, roles)
```

Dirección de dependencias, en un solo sentido:

```
extensions → host → {library, player} → core → types
```

## Architecture Invariants (enforced, no aspiracional)

1. **`lib/core/**` no importa `node:fs`, `node:net`, `node:child_process` ni `@earendil-works/*`.**
   Hay un test que lo afirma. Si ese test falla, se arregla el código, no el test.
2. **El núcleo es puro y sincrónico.** Nada de `async` en `lib/core/`: los efectos se devuelven como
   datos y el borde los ejecuta.
3. **Sólo cuatro módulos hacen I/O:** `catalog/` (cuando exista), `library/`, `player/` y `host/`.
   Todo lo demás los recibe como parámetros.
4. **Puertos sólo donde hay segunda implementación o el otro lado es volátil:** resolver de tracks,
   spawn/transporte de mpv, host de UI, reloj/red. Cuatro. Un puerto con una sola implementación y sin
   fake en tests es indirección muerta.
5. **Sin capas de mapeo DTO.** Un tipo por concepto, definido una vez; el parser produce ese tipo
   directamente.
6. **Inyección de dependencias = un objeto de deps como parámetro.** Sin contenedor, sin decoradores
   (`erasableSyntaxOnly`), sin singletons mutables.
7. **Identidad ≠ target.** `Track.id` es estable (path); `Target` es efímero (URL firmada, token que
   expira). La cola se indexa por identidad, nunca por target.

## TUI Rules (terminal craft)

- **Colores por rol, no por muestra.** Todo sale del tema del host: texto, dim, muted, acento, éxito,
  aviso, error, borde, superficie. No hay paletas propias ni detección de fondo.
- **Una sola familia de glifos.** Nada de emoji en el chrome: son celdas de doble ancho y rompen la
  grilla. El estado se distingue por glifo además de color (nunca sólo color).
- **Nunca se envuelve texto.** Se trunca con `…`. Ninguna línea excede su presupuesto de columnas.
- **Sin chrome muerto.** Una fila se gana su lugar. La fila de transporte son teclas anunciadas, no
  botones decorativos.
- **Render barato.** Sin I/O ni recálculo en el camino de render; cachear por `(ancho, alto, tema,
  hover)`.
- **Las teclas viven en una sola tabla** con su texto de ayuda, para que la fila de pie y el manejo de
  input no se desincronicen.

## Testing Standards

- `node --test`. Los tests de core, vista, cola y player **no tocan red, ni la carpeta de música del
  usuario, ni un mpv real**.
- mpv se simula con un **servidor unix real** que registra comandos y responde `success`.
- El render se verifica por **líneas exactas** a 90 y 78 columnas, incluido el truncado y las tres
  combinaciones de marcador (cursor, sonando, ambas).
- Cada comportamiento existente que un cambio toque recibe un test de que sigue funcionando.
- Procesos externos (`spawn`) y `fetch` se inyectan siempre: si un test necesita ejecutar el binario,
  el diseño del módulo está mal.
- **El transporte IPC real se prueba aparte**, no en los tests: `node scripts/ipc-probe.mjs [mpv]` spawnea mpv,
  conecta al socket (Linux/macOS) o al named pipe (Windows), verifica el round-trip y sale distinto de cero si
  falla. La CI lo corre en macOS contra un mpv instalado con Homebrew.
- **macOS no corre el suite.** `lint`, `typecheck` y `test` corren sólo en Ubuntu: el pool de runners de macOS
  sirve aproximadamente un job por run, y pedirle dos (la matriz del `check` más el `ipc probe`) dejaba al que
  perdía la carrera cancelado a los 15 minutos, con `gate` en rojo por infraestructura y no por código. En macOS
  queda **el `ipc probe`**, que es el único que necesita macOS de verdad, y corre cuando el filtro de paths ve
  transporte. La lógica de darwin se cubre en Linux porque las funciones dependientes de plataforma son puras y
  reciben `platform` (S19). Un camino exclusivo de darwin necesita un test que lo cubra desde Linux, o un job
  propio — no una promesa en este archivo.

## Feedback Loop (antes de decir "listo")

Una integración con el host **no está lista cuando el gate está verde**: está lista cuando abre en Pi. La card se
prueba con `pi -e ./extensions/sb-music.ts`, y el ciclo del overlay deja traza con `SB_MUSIC_DEBUG=/tmp/sb-music.log`
(`show`, `toggle`, `create`, `factory`, `applyFocus`, `hide`, y un `custom` que falla). Sin la variable no escribe nada.


```sh
pnpm check             # lint + typecheck + test, en ese orden
```

Un cambio no está terminado si la suite o el typecheck fallan, si quedó una tarea del documento
abierta, o si se agregó una dependencia de runtime sin decisión explícita.

## Security & Robustness

- **`libraryRoot` y todo lo que se navegue es de sólo lectura.** La extensión nunca escribe, renombra ni
  borra dentro de la biblioteca. Lo único que escribe son sus propios archivos: `settings.json` y el
  socket.
- **Sin shell.** Ejecutar procesos con `spawn`/`execFile` y argv explícito: nunca interpolar una ruta,
  un título ni un nombre de archivo en un comando, y nunca `shell: true`.
- **Los nombres de archivo son entrada no confiable.** Un nombre puede contener secuencias de escape
  ANSI/OSC (limpiar pantalla, escribir el portapapeles vía OSC 52). Antes de renderizar, se **neutralizan
  los caracteres de control**; después se truncan. Esto vale para todo texto que venga del disco.
- **Frontera de navegación en el núcleo, no en la vista.** El techo (HOME, o `libraryRoot` si está fuera
  de HOME) se resuelve después de canonicalizar el path (symlinks incluidos); la vista no decide.
- **Permisos de archivos propios**: directorio de config `0750`, `settings.json` `0600`, escritura
  atómica (tmp + rename en el mismo directorio). Settings malformado = defaults + advertencia, nunca
  crash.
- **Socket** en `$XDG_RUNTIME_DIR` (fallback tmpdir **con uid**), nunca un path predecible en `/tmp`
  sin identidad.
- **Sin secretos y sin logs.** Nada de credenciales en código, docs ni en el `odd/` log. Si el catálogo
  llega en un slice posterior: los tokens se resuelven antes de cada play y **jamás** se persisten.
- **Nada de red en v1.** Si entra, todo lo que llega es no confiable: parseo estricto, fallas como
  estados humanos en la UI, la extensión nunca crashea por red, disco o mpv ausente.

## Git & Branch Rules

- Rama `main`. **Nunca `master`** (las librerías de git en JS lo ponen por default; se corrige con
  `git symbolic-ref HEAD refs/heads/main`).
- **El repo fuerza LF** (`.gitattributes`, `* text=auto eol=lf`). Un checkout en Windows con CRLF hace fallar
  `biome ci` ahí aunque la CI de Linux siga verde.
- Los scripts de `package.json` deben funcionar en `cmd.exe` y en `sh`: una comilla simple no protege un glob en
  Windows, y el runner de tests sale con éxito aunque no encuentre ningún archivo.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Un commit = una unidad de trabajo revisable (~400 líneas autoradas), con **tests y docs del mismo
  comportamiento adentro**.
- Unidad que toque un ítem de riesgo alto va en commit propio, para que la review nativa la tome sola.
- Nunca se commitea sin pedido explícito del dueño. `node_modules/`, binarios y sockets nunca entran.
- Los cambios de comportamiento actualizan `odd/tasks/<feature>.md`: `L<n>` nuevo y `S<n>` afectados.

## Git Governance (issue-first, owner merge)

El repositorio es público: `github.com/egkike/pi-streambeats`, rama `main`. El ruleset `main-gate` sobre
`refs/heads/main` tiene `deletion`, `non_fast_forward` y `required_status_checks: gate` (`strict: false`), **sin
bypass**: ni el dueño puede mergear sobre un rojo. Un check requerido se aplica también a los pushes directos, así
que **toda escritura en `main` llega por un PR** — no hace falta una regla `pull_request` aparte. `gate` es el
contexto único y estable (agrega `check` e `ipc`, y acepta `skipped` cuando un filtro decidió que no había nada
que verificar), para que sumar un runner no trabe `main`.

- **El dueño mergea. Los agentes no.** Abren PR, corren checks y esperan.
- **Carriles** (los decide un `paths-filter` en `pr-gate`, no una convención):
  - **Código** (`extensions/**`, `lib/**`, `tests/**`, `scripts/**`, `package.json`, `pnpm-lock.yaml`,
    `tsconfig.json`, `biome.json`): issue con `status:approved` **antes** de la rama → PR con `Closes #N` → checks
    verdes → merge del dueño.
  - **Docs y tracking** (`docs/**`, `design/**`, `README.md`, `AGENTS.md`, `odd/**`, `.github/**`): PR, sin issue
    cuando no viaja código.
  `status:approved` lo pone el dueño. El agente puede pre-marcarlo **sólo** cuando el dueño ya autorizó ese ciclo
  en la conversación: la autorización de ciclo no se auto-autoriza y no se extiende al ciclo siguiente.
- **`pr-gate` es señal, no candado**: exige `Closes #N` con la issue aprobada y exactamente un `type:*`, y **se
  saltea en el carril de docs/tracking**. Salteado, no verde: un verde afirmaría que verificó algo. El único check
  requerido es `gate`.
- **Review nativa (RDD) sobre el candidato ya commiteado**, no sobre el árbol sucio.
- **Descubrimiento de vulnerabilidades** por el canal privado del repo (advisory), nunca en una issue pública.
- **Etiquetas**: `status:approved`, exactamente un `type:feature|bug|docs|refactor|chore` por PR, y
  `size:exception` cuando un PR pasa la heurística de ~400 líneas autoradas (guarda de carga de review, advisory).
- **Ingreso sólo por issues**: todavía no está adoptado. Cuando se adopte, el `CONTRIBUTING.md` y el workflow que
  lo hace cumplir se mueven juntos en la misma unidad de trabajo.

## Review nativa (RDD)

El interruptor lo posee el dueño. Cuando está encendido, el candidato se evalúa **antes** del delivery y el orden
nunca se improvisa.

**Delivery, siempre igual y siempre desde el worktree que tiene el candidato:**

```
commit → assess → review nativa si está debida (las correcciones van como commits del mismo candidato)
       → git push → gh pr create
```

- **`git switch main` no trae commits.** Antes de ramificar: `git pull --ff-only`. Una `main` local atrasada hace que el
  assess mida el candidato contra un `origin/main` más nuevo y cuente como propio el trabajo ya mergeado (medí 1596
  líneas en vez de 26 por esto).
- Los comandos de delivery van **solos** y con `cd` literal. Mezclar cambio y entrega en un mismo comando se
  rechaza a propósito, y en pipes el guard no puede atribuir el directorio.
- **Nunca se empuja una rama que no es la chequeada en el directorio actual.** El guard evalúa el candidato del
  worktree donde estás parado: desde otro lado queda desactivado en silencio. Los worktrees vinculados se registran
  antes de usarlos.
- **`reviewDue: true`** → la review corre **antes** del push, y las correcciones entran en el mismo candidato. El
  guard bloquea el push de todos modos.
- **`reviewDue: false` en el carril de CÓDIGO no se resuelve solo:** se le informa al dueño el veredicto del assess y
  se espera su decisión — dejarlo pasar con auto-verificación, o correr la review igual. "Código" son los paths del
  carril de código de arriba, **no** el motivo que devuelva el proveedor: `AGENTS.md` también vuelve como
  `executable_change`, y usar ese motivo como señal haría que todo cambio de documentos pida permiso.
- **Carril de docs/tracking con `reviewDue: false`: se procede sin aviso.** La auto-verificación (gate verde más
  lectura del cambio) sigue siendo obligatoria en los dos casos; lo que cambia es quién decide entregar.
- Revisar **antes** del push tiene un costo concreto: una corrección posterior obliga a un segundo run de CI sobre
  el mismo PR.
- Una review aprobada no autoriza el delivery: commit, push, PR y release siguen la política ordinaria del repo.

## Riesgos aceptados

Un riesgo aceptado se escribe acá con **el disparador que lo reabre**. Si no tiene disparador, no está
aceptado: está olvidado.

- **Publicación en el hub de Gentle diferida.** El repo no lleva ningún topic todavía, incluido
  `gentle-hub-project`, que es el que lo hace aparecer en el hub. Publicar una tarjeta que lleva a un README
  sin nada instalable gasta la primera impresión, y los topics se agregan después en un comando.
  **Revisar cuando** el backlog de v1 esté cerrado: sin tareas abiertas en `odd/tasks/sb-music-card.md` (hoy
  T10, T12, T21 y T22) y sin hallazgos de review pendientes de arreglar. El disparador anterior —"que exista un
  slice que corra de verdad"— **ya se cumplió** y el dueño lo reemplazó por éste: la publicación va al final, con el
  proyecto terminado, no con el primero que funcione (L59). Ese día se agregan los topics y el hub lo crawlea en
  horas.

## Fuera de alcance (v1)

`sync`/descargas, temas propios y pantalla de settings dentro de la card. Cada uno es una decisión pendiente, no
una omisión. El **catálogo Bandcamp en streaming** salió de esta lista: es la **S20 / T14** del documento de tareas
y su ciclo arranca después de la duración y del endurecimiento. Toda decisión de producto que viva acá necesita
un disparador que la reabra; si no lo tiene, no está fuera de alcance, está olvidada.

El **mouse no está acá**: S17 lo pide (click sobre una fila la selecciona y activa, rueda recorre la
lista, hover resalta), `L12` registró la decisión del dueño ("Mouse completo") y `T6` ya entrega el
mapa de `hits` del render. Lo que falta es el cableado en el host, no una decisión de alcance.
