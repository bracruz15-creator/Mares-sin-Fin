# Mares Sin Fin — servidor (guardado por cuenta de Google + multijugador en tiempo real)

El servidor hace tres cosas: **sirve el juego** (`public/index.html`), **guarda la partida por cuenta de Google** (SQLite) y ofrece **tiempo real por WebSocket** (barcos de otros jugadores en el mapa, chat y noticias de leyendas).
El juego sigue funcionando sin servidor (como el Artifact): el módulo de nube solo se activa cuando detecta `/api/config`.

## 1. Probar en tu ordenador (sin Google)
```bash
npm install
DEV_AUTH=1 npm start          # http://localhost:3000
```
En Ajustes aparece "Entrar (pruebas)". Abre dos ventanas con nombres distintos para ver presencia y chat.

## 2. Crear el Client ID de Google
1. https://console.cloud.google.com → proyecto nuevo → **APIs y servicios → Pantalla de consentimiento de OAuth** (tipo Externo; nombre de la app, correo).
2. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**.
3. En **Orígenes de JavaScript autorizados** añade tu dominio exacto (p. ej. `https://mares.tudominio.com`) y, para probar, `http://localhost:3000`.
4. Copia el Client ID (`xxxx.apps.googleusercontent.com`). No hace falta secreto de cliente.

## 3. Desplegar (necesita HTTPS y una base de datos persistente)
Con `DATABASE_URL` el servidor guarda en **Postgres** (recomendado en Render/Railway, sin disco). Sin ella usa SQLite en `DATA_DIR` (pruebas o VPS con disco).

Variables de entorno: `GOOGLE_CLIENT_ID`, `SESSION_SECRET` (cadena larga aleatoria: `openssl rand -hex 32`), `NODE_ENV=production`, `DATA_DIR` (carpeta del disco persistente), `PORT` (lo pone la plataforma).

- **Render / Railway / Fly.io (con Docker):** usa el `Dockerfile` incluido + una base Postgres (`DATABASE_URL`). Una sola instancia (la presencia vive en memoria). En Render usa un plan de pago (el gratuito se duerme y corta las conexiones en tiempo real).
- **VPS propio:** Node 20+, `npm install --omit=dev`, `npm start` detrás de Caddy o nginx con HTTPS (y reenvío de WebSocket en `/ws`).

Copia de seguridad: con Postgres, las copias automáticas del proveedor; con SQLite, copia `DATA_DIR/mares.db` (usa `sqlite3 mares.db ".backup copia.db"` en caliente).

## 4. Qué hace
- `POST /api/auth/google` verifica el ID token de Google y abre sesión (cookie firmada, 30 días).
- `GET/PUT /api/save`: una partida por cuenta, con versión. Si otro dispositivo guardó antes, devuelve 409 y el juego deja elegir **nube** o **este dispositivo**.
- Al iniciar sesión por primera vez, la partida local se sube a la nube automáticamente.
- `WS /ws`: presencia por mar (cada jugador ve los barcos de su mar), chat global (140 caracteres, 1 mensaje cada 1,5 s) y aviso global cuando alguien llega a la Isla Última Aurora.

## 5. Límites conocidos / siguientes pasos
- Una sola instancia: para varias, mover presencia a Redis y el guardado a Postgres.
- El chat no tiene moderación (solo límite de ritmo y limpieza de símbolos): conviene añadir lista de palabras, silenciar y reportar antes de abrirlo al público.
- Guarda nombre, correo y foto de Google: publica una política de privacidad y ofrece borrar la cuenta (`DELETE /api/save` ya borra la partida).
- El servidor confía en el cliente (guardado completo): sirve para continuidad entre dispositivos, no es anti-trampas; el PvP competitivo exigiría lógica de combate en el servidor.
