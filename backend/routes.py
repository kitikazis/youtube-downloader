"""Capa HTTP: blueprints de la API REST y de la pagina web.

Convenciones de respuesta:

    exito -> {"success": true,  "data": <payload>}
    error -> {"success": false, "error": {"message": str, "code": str}}
"""

from __future__ import annotations

import logging
from typing import Any

from flask import (
    Blueprint,
    Response,
    current_app,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from werkzeug.exceptions import HTTPException

from .services import DownloadService, ServiceError, ValidationError

logger = logging.getLogger(__name__)

api_bp = Blueprint("api", __name__, url_prefix="/api")
web_bp = Blueprint("web", __name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def get_service() -> DownloadService:
    """Servicio de descargas registrado por la factory de la aplicacion."""
    service = current_app.extensions.get("download_service")
    if service is None:  # pragma: no cover - error de configuracion
        raise RuntimeError("DownloadService no esta registrado en la aplicacion")
    return service


def ok(data: Any = None, status: int = 200) -> tuple[Response, int]:
    return jsonify({"success": True, "data": data}), status


def fail(message: str, status: int = 400, code: str | None = None) -> tuple[Response, int]:
    payload = {
        "success": False,
        "error": {"message": message, "code": code or _code_for(status)},
    }
    return jsonify(payload), status


#: Mensajes en espanol para los errores HTTP que genera Werkzeug.
HTTP_MESSAGES: dict[int, str] = {
    400: "La peticion no es valida",
    404: "El recurso solicitado no existe",
    405: "Metodo HTTP no permitido para esta ruta",
    409: "El recurso esta en uso",
    413: "El cuerpo de la peticion es demasiado grande",
    415: "Content-Type no soportado. Usa application/json",
}


def _code_for(status: int) -> str:
    return {
        400: "bad_request",
        404: "not_found",
        405: "method_not_allowed",
        409: "conflict",
        413: "payload_too_large",
        415: "unsupported_media_type",
        429: "too_many_requests",
        500: "internal_error",
        502: "upstream_error",
    }.get(status, "error")


def json_body() -> dict[str, Any]:
    """Cuerpo JSON de la peticion, validado."""
    body = request.get_json(silent=True)
    if body is None:
        raise ValidationError(
            "Se esperaba un cuerpo JSON con Content-Type: application/json"
        )
    if not isinstance(body, dict):
        raise ValidationError("El cuerpo JSON debe ser un objeto")
    return body


def required_string(body: dict[str, Any], field: str) -> str:
    value = body.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"El campo '{field}' es obligatorio")
    return value.strip()


# ---------------------------------------------------------------------------
# Pagina web
# ---------------------------------------------------------------------------
@web_bp.get("/")
def index() -> str:
    """Sirve la SPA de una sola pagina."""
    return render_template("index.html")


@web_bp.get("/favicon.ico")
def favicon() -> Response:
    return send_from_directory(
        current_app.static_folder, "favicon.svg", mimetype="image/svg+xml"
    )


# ---------------------------------------------------------------------------
# API REST
# ---------------------------------------------------------------------------
@api_bp.route("/health", methods=["GET", "POST"])
def health() -> tuple[Response, int]:
    """Verifica que el servidor y sus dependencias esten operativos."""
    return ok(get_service().health())


@api_bp.post("/video-info")
def video_info() -> tuple[Response, int]:
    """Devuelve titulo, duracion, autor y miniatura de un video."""
    body = json_body()
    url = required_string(body, "url")
    return ok(get_service().get_video_info(url))


@api_bp.post("/download")
def download() -> tuple[Response, int]:
    """Descarga el video en MP3 o MP4 y lo agrega al historial."""
    body = json_body()
    url = required_string(body, "url")
    format_type = (body.get("format") or "mp3").strip().lower()
    entry = get_service().download(url, format_type)
    return ok(entry, status=201)


@api_bp.post("/playlist-info")
def playlist_info() -> tuple[Response, int]:
    """Devuelve el contenido de una lista de reproduccion sin descargar nada."""
    body = json_body()
    url = required_string(body, "url")
    return ok(get_service().get_playlist_info(url))


@api_bp.post("/download-playlist")
def download_playlist() -> tuple[Response, int]:
    """Descarga en lote las pistas de una lista de reproduccion."""
    body = json_body()
    url = required_string(body, "url")
    format_type = (body.get("format") or "mp3").strip().lower()

    limit = body.get("limit")
    if limit is not None:
        if not isinstance(limit, int) or limit < 1:
            raise ValidationError("El campo 'limit' debe ser un entero positivo")

    result = get_service().download_playlist(url, format_type, limit)
    return ok(result, status=201)


@api_bp.post("/download-batch")
def download_batch() -> tuple[Response, int]:
    """Descarga una cola de enlaces elegidos por quien usa la aplicacion."""
    body = json_body()
    urls = body.get("urls")
    if not isinstance(urls, list) or not urls:
        raise ValidationError("El campo 'urls' debe ser una lista con al menos un enlace")

    format_type = (body.get("format") or "mp3").strip().lower()
    return ok(get_service().download_many(urls, format_type), status=201)


@api_bp.get("/history")
def history() -> tuple[Response, int]:
    """Lista las descargas disponibles en la carpeta local."""
    items = get_service().get_history()
    return ok({"items": items, "count": len(items)})


@api_bp.delete("/history")
def clear_history() -> tuple[Response, int]:
    """Vacia el historial y borra los archivos de la carpeta de descargas."""
    return ok(get_service().clear_history(delete_files=True))


@api_bp.get("/download-file/<path:filename>")
def download_file(filename: str) -> Response:
    """Envia al navegador un archivo ya descargado."""
    service = get_service()
    path = service.resolve_file(filename)
    logger.info("Sirviendo archivo %s", path.name)
    return send_from_directory(
        service.download_folder,
        path.name,
        as_attachment=True,
        download_name=path.name,
        conditional=True,
    )


@api_bp.delete("/delete/<path:filename>")
def delete_file(filename: str) -> tuple[Response, int]:
    """Elimina un archivo de la carpeta de descargas."""
    return ok(get_service().delete_file(filename))


# ---------------------------------------------------------------------------
# Registro en la aplicacion
# ---------------------------------------------------------------------------
def register_blueprints(app) -> None:
    """Monta los blueprints de la web y de la API."""
    app.register_blueprint(web_bp)
    app.register_blueprint(api_bp)


def register_error_handlers(app) -> None:
    """Traduce cualquier excepcion a una respuesta JSON coherente.

    Las rutas de la API siempre responden JSON; la web puede responder HTML.
    """

    @app.errorhandler(ServiceError)
    def _handle_service_error(error: ServiceError):
        log = logger.warning if error.status_code < 500 else logger.error
        log("ServiceError (%s): %s", error.status_code, error.message)
        return fail(error.message, error.status_code)

    @app.errorhandler(HTTPException)
    def _handle_http_exception(error: HTTPException):
        if not _wants_json():
            return error
        status = error.code or 500
        message = HTTP_MESSAGES.get(status) or error.description or error.name
        return fail(message, status)

    @app.errorhandler(Exception)
    def _handle_unexpected(error: Exception):  # pragma: no cover - red de seguridad
        logger.exception("Error no controlado: %s", error)
        if app.config.get("DEBUG"):
            return fail(f"{type(error).__name__}: {error}", 500)
        return fail("Ocurrio un error inesperado en el servidor", 500)

    def _wants_json() -> bool:
        return request.path.startswith("/api/") or request.accept_mimetypes.best in {
            "application/json",
            "text/json",
        }
