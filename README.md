# YouTube Downloader

Aplicacion web local para descargar **tu propio contenido** de YouTube en
**MP3** (audio) o **MP4** (video). Backend en Python/Flask con una API REST y
frontend en HTML/CSS/JavaScript sin dependencias.

> **Aviso legal:** esta herramienta esta pensada unicamente para descargar
> contenido del que seas autor o cuya licencia permita la descarga. Descargar
> material protegido por derechos de autor sin autorizacion puede infringir la
> ley y los Terminos de Servicio de YouTube. El uso es responsabilidad
> exclusiva de quien ejecuta la aplicacion.

---

## Caracteristicas

- Validacion de enlaces de YouTube (`watch`, `youtu.be`, `Shorts`, `embed`, `live`).
- Vista previa del video: titulo, autor, duracion, miniatura, visitas y fecha.
- Descarga en MP3 (192 kbps por defecto) o MP4 (mejor calidad disponible).
- Errores de yt-dlp traducidos a mensajes accionables en espanol.
- Historial persistente reconciliado con los archivos reales del disco.
- Descarga y borrado de archivos desde la interfaz.
- Tema oscuro responsive (movil, tablet y escritorio).
- API REST con contrato uniforme, CORS, logs y manejo de errores tipado.

---

## Requisitos

| Requisito | Version |
|-----------|---------|
| Python    | 3.9 o superior (verificado en 3.13) |
| ffmpeg    | Cualquier version reciente |

> **ffmpeg no es opcional.** YouTube entrega el video y el audio como streams
> separados: ffmpeg es imprescindible para convertir a MP3 y para unir ambas
> pistas en un MP4. Sin el, la aplicacion arranca y muestra la informacion de
> los videos, pero la mayoria de las descargas fallaran.

> **Manten yt-dlp actualizado.** YouTube cambia su firma de streams cada pocas
> semanas y las versiones antiguas de yt-dlp dejan de funcionar (dan
> `HTTP Error 403: Forbidden`). Si algo deja de descargar, lo primero es
> `pip install -U yt-dlp`.

---

## Instalacion

### 1. Crear y activar el entorno virtual

```bash
# Linux / macOS
python3 -m venv venv
source venv/bin/activate
```

```powershell
# Windows (PowerShell)
python -m venv venv
.\venv\Scripts\Activate.ps1
```

### 2. Instalar las dependencias

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

### 3. Instalar ffmpeg

`ffmpeg` convierte el audio a MP3 y une las pistas de video y audio en el MP4.
Sin el, la aplicacion solo puede descargar los pocos videos que todavia ofrecen
un stream progresivo (video y audio en un mismo archivo), asi que en la practica
es un requisito.

| Sistema | Comando |
|---------|---------|
| Windows (winget) | `winget install Gyan.FFmpeg` |
| Windows (choco)  | `choco install ffmpeg` |
| macOS            | `brew install ffmpeg` |
| Debian / Ubuntu  | `sudo apt install ffmpeg` |
| Fedora           | `sudo dnf install ffmpeg` |

Comprueba la instalacion con `ffmpeg -version`.

#### ffmpeg instalado pero no detectado

`winget install Gyan.FFmpeg` instala el binario pero **no lo anade al
`PATH`**, asi que la aplicacion sigue avisando de que falta. Indica su ruta
en el `.env` apuntando a la **carpeta `bin`**, que contiene `ffmpeg.exe` y
`ffprobe.exe` (yt-dlp necesita los dos):

```env
FFMPEG_LOCATION=C:/Users/TU_USUARIO/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin
```

Para localizar esa carpeta en tu equipo:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe |
  Select-Object -First 1 -ExpandProperty FullName
```

Reinicia el servidor despues de editar el `.env`: la configuracion se lee al
arrancar. Verifica con `POST /api/health`, que debe devolver `"ffmpeg": true`.

### 4. Configurar las variables de entorno (opcional)

```bash
cp .env.example .env      # Linux / macOS
copy .env.example .env    # Windows
```

Todos los valores tienen un valor por defecto util para desarrollo local.

### 5. Arrancar el servidor

```bash
python app.py
```

### 6. Abrir la aplicacion

Ve a **http://localhost:5000**

---

## Estructura del proyecto

```text
youtube-downloader/
├── app.py               # Application factory y arranque del servidor
├── config.py            # Configuracion por entorno (development/production/testing)
├── requirements.txt     # Dependencias de Python
├── .env.example         # Plantilla de variables de entorno
├── .gitignore
├── README.md
├── backend/
│   ├── __init__.py      # Exporta el servicio y sus excepciones
│   ├── services.py      # DownloadService: logica de negocio (sin Flask)
│   └── routes.py        # Blueprints, contrato JSON y manejo de errores
├── templates/
│   └── index.html       # Interfaz de una sola pagina
├── static/
│   ├── style.css        # Tema oscuro, animaciones y responsive
│   ├── script.js        # Cliente de la API y logica de la interfaz
│   └── favicon.svg
└── downloads/           # Archivos descargados (se crea automaticamente)
```

La separacion es intencional: `services.py` no importa Flask, por lo que la
logica de descarga se puede probar o reutilizar desde una CLI, y `routes.py`
solo traduce HTTP <-> servicio.

---

## API REST

Base: `http://localhost:5000/api`

Todas las respuestas siguen el mismo contrato:

```jsonc
// Exito
{ "success": true, "data": { } }

// Error
{ "success": false, "error": { "message": "...", "code": "bad_request" } }
```

| Metodo | Endpoint | Descripcion |
|--------|----------|-------------|
| `GET` / `POST` | `/api/health` | Estado del servidor y de sus dependencias |
| `POST` | `/api/video-info` | Metadatos del video sin descargarlo |
| `POST` | `/api/download` | Descarga el video en MP3 o MP4 |
| `GET` | `/api/history` | Historial de descargas disponibles |
| `GET` | `/api/download-file/<filename>` | Envia el archivo al navegador |
| `DELETE` | `/api/delete/<filename>` | Elimina el archivo del disco |

### `POST /api/video-info`

```bash
curl -X POST http://localhost:5000/api/video-info \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=VIDEO_ID"}'
```

```jsonc
{
  "success": true,
  "data": {
    "id": "VIDEO_ID",
    "title": "Titulo del video",
    "author": "Nombre del canal",
    "duration": 213,
    "duration_formatted": "3:33",
    "thumbnail": "https://i.ytimg.com/...",
    "views": 1234567,
    "upload_date": "2024-01-15",
    "is_live": false
  }
}
```

### `POST /api/download`

```bash
curl -X POST http://localhost:5000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=VIDEO_ID", "format": "mp3"}'
```

Responde `201 Created` con la entrada del historial: `filename`, `title`,
`author`, `format`, `size`, `size_formatted`, `duration`, `source_url` y
`downloaded_at`.

`format` admite `mp3` (requiere ffmpeg) o `mp4`.

### Codigos de error

| Codigo | Situacion |
|--------|-----------|
| `400` | URL invalida, formato no soportado, video en directo o demasiado largo |
| `404` | El archivo pedido no existe en `downloads/` |
| `409` | El archivo esta bloqueado por otro programa y no se puede borrar |
| `500` | Error inesperado del servidor |
| `502` | YouTube rechazo la peticion (video privado, borrado, con edad, sin red) |

---

## Configuracion

Todas las variables se definen en el `.env` (ver `.env.example`).

| Variable | Por defecto | Descripcion |
|----------|-------------|-------------|
| `APP_ENV` | `development` | Entorno: `development`, `production` o `testing` |
| `SECRET_KEY` | clave de desarrollo | Clave de firma de Flask. Cambiala en produccion |
| `HOST` | `127.0.0.1` | Interfaz de escucha |
| `PORT` | `5000` | Puerto del servidor |
| `DOWNLOAD_FOLDER` | `downloads` | Carpeta destino de los archivos |
| `FFMPEG_LOCATION` | (vacio) | Ruta a ffmpeg si no esta en el `PATH` |
| `AUDIO_QUALITY` | `192` | Bitrate del MP3 en kbps |
| `MAX_DURATION_SECONDS` | `7200` | Duracion maxima por video (`0` = sin limite) |
| `SOCKET_TIMEOUT` | `30` | Timeout de red de yt-dlp |
| `HISTORY_LIMIT` | `100` | Entradas conservadas en el historial |
| `CORS_ORIGINS` | `*` | Origenes permitidos, separados por comas |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` o `ERROR` |
| `LOG_FILE` | (vacio) | Ruta de un log rotativo. Vacio = solo consola |

---

## Notas de seguridad

- Los nombres de archivo se sanitizan (caracteres ilegales, nombres reservados
  de Windows y longitud maxima) antes de escribir en disco.
- `download-file` y `delete` resuelven la ruta y verifican que el resultado
  este dentro de `downloads/`, lo que bloquea intentos de *path traversal*
  (`../../etc/passwd`).
- El historial (`downloads/.history.json`) se escribe de forma atomica.
- El servidor de desarrollo de Flask **no** es apto para produccion. Si lo
  expones, usa un servidor WSGI y restringe `CORS_ORIGINS`:

  ```bash
  gunicorn --workers 2 --timeout 600 "app:create_app('production')"
  ```

  El `timeout` alto es necesario: una descarga larga mantiene la peticion
  abierta hasta que termina.

---

## Solucion de problemas

| Sintoma | Causa y solucion |
|---------|------------------|
| Avisa de que falta ffmpeg **aunque ya lo instalaste** | Caso tipico de `winget`: no lo anade al `PATH`. Ver "ffmpeg instalado pero no detectado". |
| `HTTP Error 403: Forbidden` al descargar | yt-dlp esta desactualizado. `pip install -U yt-dlp` y reinicia el servidor. |
| "Este video no tiene ningun formato con video y audio en un mismo archivo" | Falta ffmpeg. Instalalo y reinicia el servidor. |
| `ERROR: Sign in to confirm you're not a bot` | YouTube esta limitando tu IP. Actualiza yt-dlp: `pip install -U yt-dlp`. |
| "El video no esta disponible" | Video privado, borrado, con restriccion de edad o regional. |
| Las descargas fallan de golpe tras semanas | YouTube cambio su API. yt-dlp se actualiza muy seguido: `pip install -U yt-dlp`. |
| El puerto 5000 esta ocupado | Cambia `PORT` en el `.env` (en macOS lo usa AirPlay Receiver). |
| El historial muestra archivos que borre a mano | Pulsa "Actualizar": el historial se reconcilia con el disco en cada consulta. |

---

## Flujo de una descarga

1. El navegador valida la URL con la misma expresion regular que el backend.
2. `POST /api/video-info` obtiene los metadatos sin descargar nada.
3. `POST /api/download` valida URL, formato, duracion y disponibilidad de
   ffmpeg; reserva un nombre de archivo unico; delega en yt-dlp; convierte con
   ffmpeg si hace falta y registra la entrada en el historial.
4. La respuesta devuelve el nombre final, el tamano y los metadatos.
5. El archivo queda en `downloads/` y puede volver a descargarse o borrarse
   desde el historial.

> La barra de progreso muestra una estimacion por fases: la API responde una
> sola vez, al terminar. Para un porcentaje real haria falta un canal de
> eventos (SSE/WebSocket) y un registro de tareas en segundo plano.

---

## Licencia

Proyecto de uso personal y educativo. Respeta los derechos de autor del
contenido que descargues y los Terminos de Servicio de YouTube.
