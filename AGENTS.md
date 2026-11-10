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

## Feedback Loop (antes de decir "listo")

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

## Git Governance (política objetivo — el repo todavía no existe)

Mientras no haya repositorio, esto es la intención declarada, no una regla vigente:

- **El dueño mergea. Los agentes no.** Abren PR, corren checks, y esperan.
- **Issue-first para código**: la issue (con su alcance) existe antes de la rama. Docs y `odd/` pueden
  viajar sin issue cuando no llevan código.
- **Review nativa (RDD) sobre el candidato ya commiteado**, no sobre el árbol sucio.
- **La puerta de CI es señal, no candado**: el dueño puede mergear sobre un check rojo a propósito, y
  eso se documenta en el PR.
- **Descubrimiento de vulnerabilidades** por el canal privado del repo (advisory), nunca en una issue
  pública.
- **Etiquetas y superficies**: si se adopta el ingreso sólo por issues, la política y su workflow se
  mueven juntos en la misma unidad de trabajo.

## Riesgos aceptados

Un riesgo aceptado se escribe acá con **el disparador que lo reabre**. Si no tiene disparador, no está
aceptado: está olvidado.

## Fuera de alcance (v1)

Catálogo Bandcamp en streaming, `sync`/descargas, temas propios, pantalla de settings dentro de la
card, mouse. Cada uno es una decisión pendiente, no una omisión.
