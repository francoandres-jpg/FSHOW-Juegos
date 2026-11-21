# FSHOW Juegos

Juegos en pantalla para invitados de FSHOW, pensados para vMix: **Adivina el jugador**, **Verdadero o falso** y **Top 5**, con reloj de cuenta regresiva. Se manejan desde un panel de control y salen en una página transparente (`display.html`) que se agrega a vMix como *Web Browser*.

## Páginas

| Página | Uso |
|---|---|
| `/display.html` | Pantalla para vMix (1920x1080, fondo transparente). Solo lectura. |
| `/control.html` | Panel de control con vista previa y reloj. |

## Preguntas en Google Sheets

1. Sube `preguntas.xlsx` a Google Drive y ábrelo con Google Hojas. Luego **Archivo → Guardar como hoja de cálculo de Google**.
2. **Compartir → Acceso general → Cualquier persona con el enlace → Lector**.
3. Copia el enlace y úsalo en la variable `GOOGLE_SHEET`.
4. Edita las hojas `Adivina el jugador`, `Verdadero o falso` y `Top 5` (no cambies los nombres ni los encabezados) y en el control presiona **Recargar preguntas**.

> Cualquiera con el enlace puede ver el Sheet, incluidas las respuestas. No lo compartas.

## Variables de entorno

| Variable | Para qué sirve |
|---|---|
| `GOOGLE_SHEET` | Enlace (o ID) del Google Sheet con las preguntas. Si no existe, usa `preguntas.xlsx`. |
| `CONTROL_KEY` | Clave del control. Si existe, solo `/control.html?key=TU_CLAVE` puede manejar el juego; la pantalla solo recibe lo que ya salió al aire. |
| `PORT` | Puerto (Render lo define solo). Por defecto 3001. |

## Correr en tu computador

```bash
npm install
GOOGLE_SHEET="https://docs.google.com/spreadsheets/d/XXXX/edit" CONTROL_KEY=miclave node server.js
```

Abre `http://localhost:3001/control.html?key=miclave`. Sin variables también funciona: usa `preguntas.xlsx` y no pide clave.

## Desplegar en Render

1. **New → Web Service** y conecta este repositorio.
2. **Build Command**: `npm install` · **Start Command**: `node server.js`.
3. En **Environment** agrega `GOOGLE_SHEET` y `CONTROL_KEY`.
4. En vMix: **Add Input → Web Browser** → `https://TU-APP.onrender.com/display.html` (1920x1080) y ponlo en un Overlay.
5. Control: `https://TU-APP.onrender.com/control.html?key=TU_CLAVE`.

El plan gratuito de Render se duerme tras unos 15 minutos sin uso y tarda cerca de un minuto en despertar: abre el control antes del programa.

## Ajustes de diseño

En `public/display.html`, línea `const CFG`:

- `K`: tamaño de los ítems (1 = más chico, 1.2 = más grande)
- `W`: ancho de cada ítem
- `RX`: distancia al centro (menor = más cerca del invitado)
- `RY`: altura del arco

La esquina superior derecha queda libre para el logo de ESPN. Márgenes seguros de TV: 90 px.
