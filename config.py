"""Configuracion de la aplicacion.

Define un objeto de configuracion por entorno (development / production /
testing). Los valores se leen de variables de entorno y, si no existen, se
usa un valor por defecto seguro para desarrollo local.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent

# Carga el .env (si existe) antes de leer cualquier variable de entorno.
load_dotenv(BASE_DIR / ".env")


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "si"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _env_list(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


class Config:
    """Configuracion base compartida por todos los entornos."""

    # --- Flask ---------------------------------------------------------
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key-cambiar-en-produccion")
    JSON_SORT_KEYS = False
    JSONIFY_PRETTYPRINT_REGULAR = False
    # Tamano maximo del cuerpo de una peticion (las peticiones son JSON pequeno).
    MAX_CONTENT_LENGTH = 1 * 1024 * 1024

    # --- Servidor ------------------------------------------------------
    HOST = os.getenv("HOST", "127.0.0.1")
    PORT = _env_int("PORT", 5000)

    # --- Rutas ---------------------------------------------------------
    BASE_DIR = BASE_DIR
    DOWNLOAD_FOLDER = Path(
        os.getenv("DOWNLOAD_FOLDER", str(BASE_DIR / "downloads"))
    ).expanduser()

    # --- Descargas -----------------------------------------------------
    # Ruta al binario de ffmpeg. Si es None, yt-dlp lo busca en el PATH.
    FFMPEG_LOCATION = os.getenv("FFMPEG_LOCATION") or None
    # Calidad del audio MP3 en kbps.
    AUDIO_QUALITY = os.getenv("AUDIO_QUALITY", "192")
    # Duracion maxima permitida por video (segundos). 0 = sin limite.
    MAX_DURATION_SECONDS = _env_int("MAX_DURATION_SECONDS", 60 * 60 * 2)
    # Timeout de red para yt-dlp (segundos).
    SOCKET_TIMEOUT = _env_int("SOCKET_TIMEOUT", 30)
    # Numero maximo de entradas conservadas en el historial.
    HISTORY_LIMIT = _env_int("HISTORY_LIMIT", 100)
    # Pistas maximas que se descargan de una lista en una sola peticion.
    PLAYLIST_MAX_ITEMS = _env_int("PLAYLIST_MAX_ITEMS", 50)
    # Pistas maximas que se listan en la vista previa de una lista.
    PLAYLIST_PREVIEW_ITEMS = _env_int("PLAYLIST_PREVIEW_ITEMS", 200)
    # Longitud maxima del nombre de archivo generado (sin extension).
    MAX_FILENAME_LENGTH = _env_int("MAX_FILENAME_LENGTH", 120)

    # --- CORS ----------------------------------------------------------
    CORS_ORIGINS = _env_list("CORS_ORIGINS", "*")

    # --- Logging -------------------------------------------------------
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
    LOG_FILE = os.getenv("LOG_FILE") or None

    @classmethod
    def init_app(cls, app) -> None:
        """Hook de inicializacion especifico del entorno."""
        app.config["DOWNLOAD_FOLDER"].mkdir(parents=True, exist_ok=True)


class DevelopmentConfig(Config):
    """Entorno local: recarga automatica y logs verbosos."""

    DEBUG = True
    TESTING = False
    LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG").upper()
    TEMPLATES_AUTO_RELOAD = True
    SEND_FILE_MAX_AGE_DEFAULT = 0


class ProductionConfig(Config):
    """Entorno productivo: sin debug y con CORS restringido por defecto."""

    DEBUG = False
    TESTING = False
    CORS_ORIGINS = _env_list("CORS_ORIGINS", "http://localhost:5000")

    @classmethod
    def init_app(cls, app) -> None:
        super().init_app(app)
        if app.config["SECRET_KEY"] == "dev-secret-key-cambiar-en-produccion":
            app.logger.warning(
                "SECRET_KEY por defecto en produccion. Define SECRET_KEY en el .env."
            )


class TestingConfig(Config):
    """Entorno de pruebas automatizadas."""

    DEBUG = False
    TESTING = True
    DOWNLOAD_FOLDER = BASE_DIR / "downloads_test"
    MAX_DURATION_SECONDS = 0


config: dict[str, type[Config]] = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "testing": TestingConfig,
    "default": DevelopmentConfig,
}


def get_config(name: str | None = None) -> type[Config]:
    """Devuelve la clase de configuracion pedida (o la de FLASK_ENV/APP_ENV)."""
    key = (name or os.getenv("APP_ENV") or os.getenv("FLASK_ENV") or "default").lower()
    return config.get(key, config["default"])
