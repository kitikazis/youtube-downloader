"""Capa de servicio: toda la logica de negocio de la descarga.

Esta capa no conoce Flask: recibe datos simples, devuelve diccionarios y
lanza excepciones tipadas que la capa HTTP traduce a codigos de estado.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:  # yt-dlp es una dependencia obligatoria, pero no rompemos el import.
    import yt_dlp
    from yt_dlp.utils import DownloadError as YtDlpDownloadError
except ImportError:  # pragma: no cover - solo ocurre si falta la dependencia
    yt_dlp = None

    class YtDlpDownloadError(Exception):  # type: ignore[no-redef]
        """Sustituto usado cuando yt-dlp no esta instalado."""


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Excepciones de dominio
# ---------------------------------------------------------------------------
class ServiceError(Exception):
    """Error base del servicio. `status_code` lo consume la capa HTTP."""

    status_code = 500
    default_message = "Error interno del servidor"

    def __init__(self, message: str | None = None, *, details: Any = None):
        super().__init__(message or self.default_message)
        self.message = message or self.default_message
        self.details = details


class ValidationError(ServiceError):
    """Datos de entrada invalidos (URL mal formada, formato no soportado...)."""

    status_code = 400
    default_message = "Datos de entrada invalidos"


class FileNotFoundInLibraryError(ServiceError):
    """El archivo solicitado no existe dentro de la carpeta de descargas."""

    status_code = 404
    default_message = "El archivo no existe"


class FileInUseError(ServiceError):
    """El archivo esta bloqueado por otro proceso y no se puede eliminar."""

    status_code = 409
    default_message = "El archivo esta en uso por otro programa"


class DownloadError(ServiceError):
    """Fallo al obtener informacion o al descargar desde YouTube."""

    status_code = 502
    default_message = "No se pudo completar la descarga"


# ---------------------------------------------------------------------------
# Modelo interno
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DownloadFormat:
    """Describe un formato de salida soportado."""

    key: str
    extension: str
    label: str
    requires_ffmpeg: bool


FORMATS: dict[str, DownloadFormat] = {
    "mp3": DownloadFormat("mp3", "mp3", "Audio MP3", requires_ffmpeg=True),
    "mp4": DownloadFormat("mp4", "mp4", "Video MP4", requires_ffmpeg=False),
}


def glob_escape(value: str) -> str:
    """Escapa los metacaracteres de glob presentes en un nombre de archivo."""
    return re.sub(r"([\[\]*?])", r"[\1]", value)


class DownloadService:
    """Descarga videos de YouTube y administra la biblioteca local."""

    #: Acepta youtube.com/watch, youtu.be, shorts, embed, live y music.youtube.
    YOUTUBE_URL_RE = re.compile(
        r"^(?:https?://)?(?:www\.|m\.|music\.)?"
        r"(?:youtube\.com/(?:watch\?(?:[^&\s]*&)*v=|embed/|shorts/|live/|v/)"
        r"|youtu\.be/)"
        r"(?P<id>[A-Za-z0-9_-]{11})",
        re.IGNORECASE,
    )

    #: Caracteres no admitidos en Windows/Linux/macOS para nombres de archivo.
    _ILLEGAL_CHARS_RE = re.compile(r'[<>:"/\|?*%\x00-\x1f]')
    _WHITESPACE_RE = re.compile(r"\s+")

    #: Nombres reservados por Windows.
    _RESERVED_NAMES = {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }

    HISTORY_FILENAME = ".history.json"

    def __init__(
        self,
        download_folder: str | os.PathLike[str],
        *,
        ffmpeg_location: str | None = None,
        audio_quality: str = "192",
        max_duration_seconds: int = 0,
        history_limit: int = 100,
        max_filename_length: int = 120,
        socket_timeout: int = 30,
    ) -> None:
        self.download_folder = Path(download_folder).expanduser().resolve()
        self.download_folder.mkdir(parents=True, exist_ok=True)
        self.ffmpeg_location = ffmpeg_location
        self.audio_quality = str(audio_quality)
        self.max_duration_seconds = max(0, int(max_duration_seconds))
        self.history_limit = max(1, int(history_limit))
        self.max_filename_length = max(16, int(max_filename_length))
        self.socket_timeout = max(5, int(socket_timeout))
        self._history_path = self.download_folder / self.HISTORY_FILENAME
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # Validacion de URLs
    # ------------------------------------------------------------------
    def extract_video_id(self, url: str) -> str | None:
        """Devuelve el ID de 11 caracteres del video, o None si no es valida."""
        if not url or not isinstance(url, str):
            return None
        match = self.YOUTUBE_URL_RE.match(url.strip())
        return match.group("id") if match else None

    def is_valid_url(self, url: str) -> bool:
        """True si la URL apunta a un video de YouTube."""
        return self.extract_video_id(url) is not None

    def validate_url(self, url: str) -> str:
        """Normaliza la URL a su forma canonica o lanza `ValidationError`."""
        video_id = self.extract_video_id(url)
        if not video_id:
            raise ValidationError(
                "La URL no es un enlace valido de YouTube. "
                "Ejemplo: https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            )
        return f"https://www.youtube.com/watch?v={video_id}"

    @staticmethod
    def validate_format(fmt: str) -> DownloadFormat:
        """Valida el formato pedido y devuelve su descriptor."""
        key = (fmt or "").strip().lower()
        if key not in FORMATS:
            raise ValidationError(
                f"Formato '{fmt}' no soportado. Usa uno de: {', '.join(FORMATS)}"
            )
        return FORMATS[key]

    # ------------------------------------------------------------------
    # Nombres de archivo
    # ------------------------------------------------------------------
    def sanitize_filename(self, name: str) -> str:
        """Convierte un titulo arbitrario en un nombre de archivo seguro."""
        if not name:
            return "descarga"

        normalized = unicodedata.normalize("NFKC", str(name))
        cleaned = self._ILLEGAL_CHARS_RE.sub(" ", normalized)
        cleaned = self._WHITESPACE_RE.sub(" ", cleaned).strip(" .")

        if len(cleaned) > self.max_filename_length:
            cleaned = cleaned[: self.max_filename_length].rstrip(" .")

        if not cleaned:
            return "descarga"

        if cleaned.split(".")[0].upper() in self._RESERVED_NAMES:
            cleaned = f"_{cleaned}"

        return cleaned

    def _unique_stem(self, stem: str, extension: str) -> str:
        """Evita sobrescribir: agrega un sufijo numerico si el archivo existe."""
        candidate = stem
        counter = 1
        while (self.download_folder / f"{candidate}.{extension}").exists():
            counter += 1
            suffix = f" ({counter})"
            base = stem[: self.max_filename_length - len(suffix)].rstrip(" .")
            candidate = f"{base}{suffix}"
        return candidate

    def resolve_file(self, filename: str) -> Path:
        """Resuelve un nombre de archivo dentro de la carpeta de descargas.

        Protege contra path traversal (`../`, rutas absolutas, symlinks).
        """
        if not filename or not isinstance(filename, str):
            raise ValidationError("Nombre de archivo requerido")

        candidate_name = Path(filename).name
        if candidate_name != filename.strip() or candidate_name in {"", ".", ".."}:
            raise ValidationError("Nombre de archivo invalido")
        if candidate_name == self.HISTORY_FILENAME:
            raise ValidationError("Nombre de archivo invalido")

        target = (self.download_folder / candidate_name).resolve()
        if target.parent != self.download_folder:
            raise ValidationError("Nombre de archivo invalido")
        if not target.is_file():
            raise FileNotFoundInLibraryError(f"El archivo '{candidate_name}' no existe")
        return target

    # ------------------------------------------------------------------
    # Integracion con yt-dlp
    # ------------------------------------------------------------------
    @staticmethod
    def _require_yt_dlp() -> None:
        if yt_dlp is None:  # pragma: no cover
            raise ServiceError(
                "yt-dlp no esta instalado. Ejecuta: pip install -r requirements.txt"
            )

    def ffmpeg_path(self) -> str | None:
        """Ruta al binario (o carpeta) de ffmpeg, o None si no esta disponible."""
        if self.ffmpeg_location:
            location = Path(self.ffmpeg_location).expanduser()
            if location.exists():
                return str(location)
        return shutil.which("ffmpeg")

    def has_ffmpeg(self) -> bool:
        return self.ffmpeg_path() is not None

    def _base_options(self) -> dict[str, Any]:
        options: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "socket_timeout": self.socket_timeout,
            "retries": 3,
            "ignoreerrors": False,
            "logger": logging.getLogger("yt_dlp"),
        }
        ffmpeg = self.ffmpeg_path()
        if ffmpeg:
            options["ffmpeg_location"] = ffmpeg
        return options

    def _extract(self, url: str, *, download: bool, options: dict[str, Any]) -> dict:
        """Ejecuta yt-dlp traduciendo sus errores a excepciones de dominio."""
        self._require_yt_dlp()
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=download)
        except YtDlpDownloadError as exc:
            raise DownloadError(self._humanize_yt_dlp_error(str(exc))) from exc
        except Exception as exc:  # pragma: no cover - fallo inesperado de red/IO
            logger.exception("Fallo inesperado de yt-dlp para %s", url)
            raise DownloadError(f"Error inesperado al procesar el video: {exc}") from exc

        if not info:
            raise DownloadError("YouTube no devolvio informacion para esa URL")

        if info.get("_type") == "playlist":
            entries = [entry for entry in (info.get("entries") or []) if entry]
            if not entries:
                raise DownloadError("La lista de reproduccion no contiene videos")
            info = entries[0]

        return info

    def _humanize_yt_dlp_error(self, raw: str) -> str:
        """Convierte el error tecnico de yt-dlp en un mensaje para el usuario."""
        message = raw.replace("ERROR: ", "").strip()
        lowered = message.lower()

        # Caso frecuente: YouTube entrega video y audio por separado y no hay
        # ffmpeg para unirlos, asi que ningun formato del selector encaja.
        if "requested format is not available" in lowered and not self.has_ffmpeg():
            return (
                "Este video no tiene ningun formato con video y audio en un mismo "
                "archivo. Instala ffmpeg para poder unirlos y vuelve a intentarlo."
            )

        table = [
            ("private video", "El video es privado y no se puede descargar."),
            ("video unavailable", "El video no esta disponible."),
            ("removed by the uploader", "El video fue eliminado por su autor."),
            ("confirm your age", "El video tiene restriccion de edad."),
            ("sign in to confirm", "YouTube requiere iniciar sesion para este video."),
            ("members-only", "El video es exclusivo para miembros del canal."),
            ("not available in your country", "El video no esta disponible en tu pais."),
            ("unable to download webpage", "No hay conexion con YouTube. Revisa tu red."),
            ("ffmpeg", "ffmpeg no esta disponible o fallo la conversion."),
            ("live event will begin", "La transmision en vivo aun no ha comenzado."),
            ("incomplete data received", "YouTube devolvio datos incompletos. Reintenta."),
            ("requested format is not available", "YouTube no ofrece un formato descargable para este video."),
        ]
        for needle, friendly in table:
            if needle in lowered:
                return friendly
        return message or "No se pudo procesar el video"

    # ------------------------------------------------------------------
    # API publica: informacion y descarga
    # ------------------------------------------------------------------
    def get_video_info(self, url: str) -> dict[str, Any]:
        """Devuelve los metadatos del video sin descargarlo."""
        canonical_url = self.validate_url(url)
        logger.info("Consultando informacion de %s", canonical_url)

        options = {**self._base_options(), "skip_download": True}
        info = self._extract(canonical_url, download=False, options=options)
        return self._serialize_info(info, canonical_url)

    def _serialize_info(self, info: dict, canonical_url: str) -> dict[str, Any]:
        duration = int(info.get("duration") or 0)
        return {
            "id": info.get("id"),
            "url": info.get("webpage_url") or canonical_url,
            "title": info.get("title") or "Sin titulo",
            "author": info.get("uploader") or info.get("channel") or "Desconocido",
            "channel_url": info.get("uploader_url") or info.get("channel_url"),
            "duration": duration,
            "duration_formatted": self.format_duration(duration),
            "thumbnail": info.get("thumbnail"),
            "views": info.get("view_count"),
            "upload_date": self._format_upload_date(info.get("upload_date")),
            "is_live": bool(info.get("is_live")),
            "description": (info.get("description") or "")[:280],
        }

    def download(self, url: str, format_type: str = "mp3") -> dict[str, Any]:
        """Descarga el video en el formato pedido y registra el historial."""
        canonical_url = self.validate_url(url)
        fmt = self.validate_format(format_type)

        if fmt.requires_ffmpeg and not self.has_ffmpeg():
            raise ValidationError(
                "ffmpeg es necesario para generar MP3. Instalalo y vuelve a intentar "
                "(o define FFMPEG_LOCATION en el .env)."
            )

        info = self._extract(
            canonical_url,
            download=False,
            options={**self._base_options(), "skip_download": True},
        )
        metadata = self._serialize_info(info, canonical_url)

        if metadata["is_live"]:
            raise ValidationError("No se pueden descargar transmisiones en vivo.")

        duration = metadata["duration"]
        if self.max_duration_seconds and duration > self.max_duration_seconds:
            raise ValidationError(
                f"El video dura {self.format_duration(duration)} y el limite es "
                f"{self.format_duration(self.max_duration_seconds)}."
            )

        with self._lock:
            stem = self._unique_stem(
                self.sanitize_filename(metadata["title"]), fmt.extension
            )
            # Reserva el nombre creando un archivo vacio: evita que dos descargas
            # concurrentes elijan el mismo destino. yt-dlp lo sobrescribe.
            placeholder = self.download_folder / f"{stem}.{fmt.extension}"
            placeholder.touch(exist_ok=True)

        options = self._download_options(stem, fmt)
        logger.info("Descargando '%s' como %s", metadata["title"], fmt.key)

        try:
            result = self._extract(canonical_url, download=True, options=options)
            final_path = self._locate_output(result, stem, fmt)
        except ServiceError:
            self._safe_unlink(placeholder)
            raise

        if final_path != placeholder:
            self._safe_unlink(placeholder)

        size = final_path.stat().st_size
        entry = {
            "filename": final_path.name,
            "title": metadata["title"],
            "author": metadata["author"],
            "thumbnail": metadata["thumbnail"],
            "duration": duration,
            "duration_formatted": metadata["duration_formatted"],
            "format": fmt.key,
            "size": size,
            "size_formatted": self.format_size(size),
            "source_url": metadata["url"],
            "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        self._append_history(entry)
        logger.info(
            "Descarga completada: %s (%s)", entry["filename"], entry["size_formatted"]
        )
        return entry

    def _download_options(self, stem: str, fmt: DownloadFormat) -> dict[str, Any]:
        """Construye las opciones de yt-dlp para el formato pedido."""
        options = self._base_options()
        options.update(
            {
                "outtmpl": str(self.download_folder / f"{stem}.%(ext)s"),
                "overwrites": True,
                "progress_hooks": [self._progress_hook],
                "windowsfilenames": True,
            }
        )

        if fmt.key == "mp3":
            options.update(
                {
                    "format": "bestaudio/best",
                    "postprocessors": [
                        {
                            "key": "FFmpegExtractAudio",
                            "preferredcodec": "mp3",
                            "preferredquality": self.audio_quality,
                        },
                        {"key": "FFmpegMetadata"},
                    ],
                }
            )
        elif self.has_ffmpeg():
            options.update(
                {
                    "format": (
                        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
                        "bestvideo+bestaudio/best[ext=mp4]/best"
                    ),
                    "merge_output_format": "mp4",
                }
            )
        else:
            # Sin ffmpeg solo sirven los streams progresivos (video + audio en un
            # mismo archivo). YouTube ya casi no los ofrece: de ahi el aviso.
            options["format"] = (
                "best[ext=mp4][acodec!=none][vcodec!=none]/"
                "best[acodec!=none][vcodec!=none]/best"
            )
        return options

    @staticmethod
    def _progress_hook(status: dict) -> None:
        state = status.get("status")
        if state == "finished":
            logger.debug("Descarga en bruto finalizada: %s", status.get("filename"))
        elif state == "error":  # pragma: no cover
            logger.warning("yt-dlp reporto un error en %s", status.get("filename"))

    def _locate_output(self, result: dict, stem: str, fmt: DownloadFormat) -> Path:
        """Determina la ruta real del archivo generado por yt-dlp."""
        expected = self.download_folder / f"{stem}.{fmt.extension}"
        if expected.is_file() and expected.stat().st_size > 0:
            return expected

        # yt-dlp >= 2023 expone la ruta final en requested_downloads.
        for download in result.get("requested_downloads") or []:
            for key in ("filepath", "_filename", "filename"):
                value = download.get(key)
                if value and Path(value).is_file():
                    return Path(value).resolve()

        # Ultimo recurso: cualquier archivo generado con ese nombre base.
        candidates = [
            path
            for path in self.download_folder.glob(f"{glob_escape(stem)}.*")
            if path.is_file() and path.stat().st_size > 0
        ]
        if candidates:
            return max(candidates, key=lambda path: path.stat().st_mtime)

        raise DownloadError(
            "La descarga finalizo pero no se encontro el archivo generado."
        )

    # ------------------------------------------------------------------
    # Historial y biblioteca
    # ------------------------------------------------------------------
    def get_history(self) -> list[dict[str, Any]]:
        """Historial reconciliado con lo que realmente existe en disco."""
        with self._lock:
            known: dict[str, dict[str, Any]] = {}

            for entry in self._read_history():
                filename = entry.get("filename")
                if not filename:
                    continue
                path = self.download_folder / filename
                if not path.is_file():
                    continue  # el archivo fue borrado fuera de la aplicacion
                size = path.stat().st_size
                entry["size"] = size
                entry["size_formatted"] = self.format_size(size)
                known[filename] = entry

            # Archivos presentes en disco pero sin registro (copiados a mano).
            for path in self._library_files():
                if path.name in known:
                    continue
                stat = path.stat()
                known[path.name] = {
                    "filename": path.name,
                    "title": path.stem,
                    "author": "Desconocido",
                    "thumbnail": None,
                    "duration": None,
                    "duration_formatted": None,
                    "format": path.suffix.lstrip(".").lower(),
                    "size": stat.st_size,
                    "size_formatted": self.format_size(stat.st_size),
                    "source_url": None,
                    "downloaded_at": datetime.fromtimestamp(
                        stat.st_mtime, timezone.utc
                    ).isoformat(timespec="seconds"),
                }

            history = sorted(
                known.values(),
                key=lambda item: item.get("downloaded_at") or "",
                reverse=True,
            )[: self.history_limit]
            self._write_history(history)
            return history

    def delete_file(self, filename: str) -> dict[str, Any]:
        """Elimina un archivo de la biblioteca y su entrada del historial."""
        target = self.resolve_file(filename)
        with self._lock:
            self._unlink_locked_file(target)

            history = [
                entry
                for entry in self._read_history()
                if entry.get("filename") != target.name
            ]
            self._write_history(history)

        logger.info("Archivo eliminado: %s", target.name)
        return {"filename": target.name, "deleted": True}

    @staticmethod
    def _unlink_locked_file(path: Path, attempts: int = 5, delay: float = 0.15) -> None:
        """Borra un archivo reintentando si el sistema lo tiene bloqueado.

        En Windows, un archivo recien servido puede seguir abierto unos
        milisegundos (WinError 32). Un backoff corto resuelve esa carrera sin
        dejar al usuario con un error incomprensible.
        """
        for attempt in range(attempts):
            try:
                path.unlink()
                return
            except PermissionError:
                if attempt == attempts - 1:
                    raise FileInUseError(
                        f"'{path.name}' esta abierto en otro programa. "
                        "Cierralo y vuelve a intentarlo."
                    )
                time.sleep(delay)
            except OSError as exc:
                raise ServiceError(f"No se pudo eliminar el archivo: {exc}") from exc

    def _library_files(self) -> Iterable[Path]:
        extensions = {f".{fmt.extension}" for fmt in FORMATS.values()}
        for path in self.download_folder.iterdir():
            if path.is_file() and path.suffix.lower() in extensions:
                yield path

    def _append_history(self, entry: dict[str, Any]) -> None:
        with self._lock:
            history = [
                item
                for item in self._read_history()
                if item.get("filename") != entry["filename"]
            ]
            history.insert(0, entry)
            self._write_history(history[: self.history_limit])

    def _read_history(self) -> list[dict[str, Any]]:
        if not self._history_path.is_file():
            return []
        try:
            with self._history_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Historial ilegible (%s). Se reconstruye desde disco.", exc)
            return []
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    def _write_history(self, history: list[dict[str, Any]]) -> None:
        """Escritura atomica: primero a un temporal y luego un replace."""
        temp_path = self._history_path.with_name(self._history_path.name + ".tmp")
        try:
            with temp_path.open("w", encoding="utf-8") as handle:
                json.dump(history, handle, ensure_ascii=False, indent=2)
            temp_path.replace(self._history_path)
        except OSError as exc:  # pragma: no cover - disco lleno / permisos
            logger.error("No se pudo guardar el historial: %s", exc)
            self._safe_unlink(temp_path)

    @staticmethod
    def _safe_unlink(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:  # pragma: no cover
            logger.debug("No se pudo eliminar %s", path)

    # ------------------------------------------------------------------
    # Diagnostico y formateo
    # ------------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        """Estado del servicio: dependencias y carpeta de descargas."""
        ffmpeg = self.ffmpeg_path()
        version = None
        if yt_dlp is not None:
            version = getattr(getattr(yt_dlp, "version", None), "__version__", None)
        return {
            "status": "ok",
            "yt_dlp": version,
            "ffmpeg": bool(ffmpeg),
            "ffmpeg_path": ffmpeg,
            "download_folder": str(self.download_folder),
            "download_folder_writable": os.access(self.download_folder, os.W_OK),
            "formats": [
                {"key": fmt.key, "label": fmt.label, "extension": fmt.extension}
                for fmt in FORMATS.values()
            ],
            "server_time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

    @staticmethod
    def format_duration(seconds: int | float | None) -> str:
        """Segundos -> 'H:MM:SS' o 'M:SS'."""
        if not seconds or seconds < 0:
            return "0:00"
        hours, remainder = divmod(int(seconds), 3600)
        minutes, secs = divmod(remainder, 60)
        if hours:
            return f"{hours}:{minutes:02d}:{secs:02d}"
        return f"{minutes}:{secs:02d}"

    @staticmethod
    def format_size(num_bytes: int | float | None) -> str:
        """Bytes -> texto legible (KB, MB, GB)."""
        if not num_bytes or num_bytes < 0:
            return "0 B"
        size = float(num_bytes)
        for unit in ("B", "KB", "MB", "GB", "TB"):
            if size < 1024 or unit == "TB":
                precision = 0 if unit == "B" else 1
                return f"{size:.{precision}f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"  # pragma: no cover

    @staticmethod
    def _format_upload_date(raw: str | None) -> str | None:
        """'20240115' -> '2024-01-15'."""
        if not raw or len(raw) != 8 or not raw.isdigit():
            return None
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
