# SUCE — Fichas de entretenimiento (sin dinero real)

Fichas 100% virtuales: no se compran, no se canjean por dinero real. El admin
las carga manualmente desde su panel. Uso puramente recreativo.

## Estructura del proyecto

```
casino-project/
├── db/
│   ├── schema.sql        ← Correr esto en tu base de Neon
│   └── postgrest.conf    ← Config de ejemplo para levantar PostgREST
└── frontend/
    ├── login.html
    ├── index.html         ← Panel del jugador (catálogo de juegos)
    ├── admin.html          ← Panel del admin
    ├── css/styles.css
    ├── js/api.js           ← Cliente que habla con PostgREST
    └── juegos/
        └── tragamonedas.html   ← Primer juego, plantilla para los otros 14
```

## Pasos para levantarlo

### 1. Base de datos (Neon)
1. Abrí tu proyecto en Neon, entrá a la consola SQL (o usá DBeaver conectado
   a tu connection string de Neon).
2. Corré todo el contenido de `db/schema.sql`.
   - **Importante:** cambiá el string `CAMBIAR_POR_UN_SECRETO_LARGO_Y_RANDOM...`
     por un secreto real (mismo valor en las 2 partes del archivo: la función
     `api.login` y donde lo vayas a poner en `postgrest.conf`).
3. Creá tu primer usuario admin a mano (está comentado al final del schema):
   ```sql
   insert into app.usuarios (username, password_hash, rol)
   values ('admin', crypt('TU_PASSWORD_SEGURA', gen_salt('bf')), 'admin');
   insert into app.wallets (usuario_id, saldo)
   select id, 0 from app.usuarios where username = 'admin';
   ```

### 2. PostgREST (probar local primero)
1. Descargá el binario de PostgREST (https://postgrest.org/en/stable/install.html)
   o corrélo con Docker.
2. Editá `db/postgrest.conf`: poné tu connection string real de Neon (con el
   rol `authenticator` y su password) y el mismo `jwt-secret` que usaste en el paso 1.
3. Arrancalo local para probar:
   ```bash
   postgrest db/postgrest.conf
   ```
   Por defecto queda escuchando en `http://localhost:3000`.

### 3. Frontend (local primero)
1. Abrí `frontend/js/api.js` y confirmá que `API_URL` apunte a
   `http://localhost:3000` mientras probás.
2. Abrí `frontend/login.html` con Live Server de VSCode (no puede ser
   `file://` directo por los fetch).
3. Entrá con el usuario admin que creaste → deberías caer en `admin.html`.
4. Desde ahí creá un usuario jugador y cargale fichas.
5. Entrá con ese usuario jugador → deberías caer en `index.html` y poder
   jugar al tragamonedas.

### 4. Desplegar de verdad: Render + GitHub Pages
1. **Backend (Render):** subí este repo a GitHub, creá un "Web Service" nuevo
   en Render conectado a ese repo, corriendo PostgREST vía Docker (imagen
   oficial `postgrest/postgrest`) con las mismas variables de `postgrest.conf`
   como variables de entorno. Elegí el plan **Starter ($7/mes)** si querés
   que no se duerma — el free tier se duerme a los 15 min de inactividad.
2. Render te da una URL pública tipo `https://tu-app.onrender.com`.
3. **Frontend (GitHub Pages):** en la configuración del repo, activá GitHub
   Pages apuntando a la carpeta `frontend/`.
4. Antes de subir, actualizá `frontend/js/api.js` con la URL real de Render
   en vez de `localhost:3000`.

## Estado de los 15 juegos

**Listos y funcionando (9):** Tragamonedas, Ruleta, Dados, Keno, Rasca y Gana,
Rueda de la Suerte, Alto o Bajo, Cara o Cruz, Carta Más Alta.

**Pendientes (6):** Blackjack, Video Póker, Baccarat, Bingo, Plinko, Minas —
estos necesitan varios pasos de juego (pedir carta, decidir, etc.) en vez de
"apostar → resultado inmediato", así que son más trabajo cada uno. Seguimos
con esos en la próxima vuelta, siguiendo el mismo patrón general.

## Cómo sumar los otros 6 juegos

El patrón es siempre el mismo, tomando `tragamonedas.html` como plantilla:

1. **En `schema.sql`**: agregá una función `api.jugar_<nombre>(p_apuesta bigint)`
   que calcule el resultado del juego **en el servidor** (nunca confiar en lo
   que mande el navegador) y llame a `app.registrar_partida(...)` al final,
   igual que hace `jugar_tragamonedas`. Agregá el `grant execute ... to jugador`
   y una fila en `app.juegos`.
2. **En `js/api.js`**: agregá una función `jugarNombreDelJuego(apuesta)` que
   llame a `llamarRPC("jugar_nombre", {...})`.
3. **En `juegos/`**: copiá `tragamonedas.html`, cambiale la animación/visual
   específica del juego, y llamá a tu nueva función del paso 2.
4. **En `index.html`**: marcá ese juego como `disponible: true` en `CATALOGO_JUEGOS`.

## Pendiente para la próxima vuelta (avisame cuando quieras seguir)
- Función `api.admin_lista_usuarios()` para que el panel admin muestre la
  lista de jugadores y saldos sin tener que ir a DBeaver.
- Los 14 juegos restantes (ruleta, blackjack, dados, keno, bingo, etc.),
  siguiendo el patrón de arriba.
- Historial de partidas visible para el jugador (tabla `app.partidas` ya
  guarda todo, solo falta la vista + pantalla).
- Manejo de expiración del token (actualmente dura 12hs, después hay que
  volver a loguearse — se puede agregar refresh token si lo necesitás).
