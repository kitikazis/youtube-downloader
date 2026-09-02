"""Punto de entrada de la aplicacion (application factory).

Uso:
    python app.py                 # servidor de desarrollo en http://localhost:5000
    APP_ENV=production python app.py
    gunicorn "app:create_app()"   # despliegue con WSGI
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

from flask import Flask
from flask_cors import CORS

from backend.routes import register_blueprints, register_error_handlers
from backend.services import DownloadService
from config import Config, get_config

LOG_FORMAT = "[%(asctime)s] %(levelname)-8s %(name)s: %(message)s"


def configure_logging(app: Flask) -> None:
    """Un unico handler de consola (y opcionalmente de archivo) para toda la app."""
    level = getattr(logging, app.config.get("LOG_LEVEL", "INFO"), logging.INFO)
    formatter = logging.Formatter(LOG_FORMAT, datefmt="%Y-%m-%d %H:%M:%S")

    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    root.addHandler(console)

    log_file = app.config.get("LOG_FILE")
    if log_file:
        file_handler = RotatingFileHandler(
            log_file, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

    # yt-dlp es muy verboso: solo nos interesan sus avisos.
    logging.getLogger("yt_dlp").setLevel(logging.WARNING)
    app.logger.setLevel(level)


def create_service(app: Flask) -> DownloadService:
    """Instancia el servicio de descargas con la configuracion de la app."""
    return DownloadService(
        app.config["DOWNLOAD_FOLDER"],
        ffmpeg_location=app.config.get("FFMPEG_LOCATION"),
        audio_quality=app.config.get("AUDIO_QUALITY", "192"),
        max_duration_seconds=app.config.get("MAX_DURATION_SECONDS", 0),
        history_limit=app.config.get("HISTORY_LIMIT", 100),
        max_filename_length=app.config.get("MAX_FILENAME_LENGTH", 120),
        socket_timeout=app.config.get("SOCKET_TIMEOUT", 30),
    )


def create_app(config_name: str | None = None) -> Flask:
    """Application factory: construye y configura la instancia de Flask."""
    app = Flask(__name__, template_folder="templates", static_folder="static")

    config_class: type[Config] = get_config(config_name)
    app.config.from_object(config_class)
    config_class.init_app(app)

    configure_logging(app)

    CORS(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=False,
    )

    app.extensions["download_service"] = create_service(app)

    register_blueprints(app)
    register_error_handlers(app)

    service = app.extensions["download_service"]
    app.logger.info("Entorno: %s", config_class.__name__)
    app.logger.info("Carpeta de descargas: %s", service.download_folder)
    if not service.has_ffmpeg():
        app.logger.warning(
            "ffmpeg no encontrado en el PATH: la conversion a MP3 no estara "
            "disponible y el MP4 se limitara a streams progresivos."
        )
    return app


app = create_app()


if __name__ == "__main__":
    host = app.config["HOST"]
    port = app.config["PORT"]
    app.logger.info("Servidor disponible en http://%s:%s", "localhost", port)
    app.run(host=host, port=port, debug=app.config.get("DEBUG", False))
