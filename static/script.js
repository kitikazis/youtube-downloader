/**
 * YouTube Downloader - logica del cliente.
 *
 * Sin dependencias externas. Todo el modulo vive en una IIFE para no
 * contaminar el ambito global.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Constantes                                                          */
  /* ------------------------------------------------------------------ */
  var API_BASE = "/api";

  // Debe reflejar la validacion del backend (DownloadService.YOUTUBE_URL_RE).
  var YOUTUBE_RE = new RegExp(
    "^(?:https?://)?(?:www\.|m\.|music\.)?" +
      "(?:youtube\.com/(?:watch\?(?:[^&\s]*&)*v=|embed/|shorts/|live/|v/)" +
      "|youtu\.be/)" +
      "([A-Za-z0-9_-]{11})",
    "i"
  );

  var HELP_DEFAULT = "Admite videos y listas de reproduccion de YouTube.";

  // Identificador de lista dentro de la URL (?list=...).
  var PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/i;

  // Pistas que se muestran en la vista previa antes de recortar.
  var TRACKS_PREVIEW = 30;

  /* ------------------------------------------------------------------ */
  /* Referencias al DOM                                                  */
  /* ------------------------------------------------------------------ */
  var el = {
    form: document.getElementById("downloadForm"),
    url: document.getElementById("urlInput"),
    helpText: document.getElementById("helpText"),
    infoBtn: document.getElementById("infoBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    videoInfo: document.getElementById("videoInfo"),
    videoTitle: document.getElementById("videoTitle"),
    videoAuthor: document.getElementById("videoAuthor"),
    videoDuration: document.getElementById("videoDuration"),
    videoThumb: document.getElementById("videoThumb"),
    playlistInfo: document.getElementById("playlistInfo"),
    playlistTitle: document.getElementById("playlistTitle"),
    playlistCount: document.getElementById("playlistCount"),
    playlistAuthors: document.getElementById("playlistAuthors"),
    playlistDuration: document.getElementById("playlistDuration"),
    playlistTracks: document.getElementById("playlistTracks"),
    playlistNote: document.getElementById("playlistNote"),
    clearHistoryBtn: document.getElementById("clearHistoryBtn"),
    progressSection: document.getElementById("progressSection"),
    progressLabel: document.getElementById("progressLabel"),
    progressValue: document.getElementById("progressValue"),
    progressFill: document.getElementById("progressFill"),
    progressStatus: document.getElementById("progressStatus"),
    message: document.getElementById("message"),
    messageIcon: document.getElementById("messageIcon"),
    messageText: document.getElementById("messageText"),
    historyList: document.getElementById("historyList"),
    historyEmpty: document.getElementById("historyEmpty"),
    template: document.getElementById("historyItemTemplate")
  };

  var state = {
    busy: false,
    progressTimer: null,
    ffmpeg: true,
    playlist: null
  };

  function playlistIdOf(url) {
    var match = PLAYLIST_RE.exec(String(url || ""));
    return match ? match[1] : null;
  }

  /* ------------------------------------------------------------------ */
  /* Utilidades de formato                                               */
  /* ------------------------------------------------------------------ */
  function formatDuration(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    var pad = function (value) {
      return String(value).padStart(2, "0");
    };
    return hours > 0
      ? hours + ":" + pad(minutes) + ":" + pad(secs)
      : minutes + ":" + pad(secs);
  }

  function formatSize(bytes) {
    var size = Number(bytes) || 0;
    if (size <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return size.toFixed(index === 0 ? 0 : 1) + " " + units[index];
  }

  function formatDate(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    return date.toLocaleString("es-ES", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function isVideoUrl(value) {
    return YOUTUBE_RE.test(String(value || "").trim());
  }

  function isValidUrl(value) {
    var url = String(value || "").trim();
    return isVideoUrl(url) || Boolean(playlistIdOf(url));
  }

  function show(node) {
    node.classList.remove("hidden");
  }

  function hide(node) {
    node.classList.add("hidden");
  }

  /* ------------------------------------------------------------------ */
  /* Cliente HTTP                                                        */
  /* ------------------------------------------------------------------ */
  /**
   * Envuelve fetch aplicando el contrato de la API:
   *   { success: true, data } | { success: false, error: { message } }
   */
  function request(path, options) {
    var config = options || {};
    var init = {
      method: config.method || "GET",
      headers: { Accept: "application/json" }
    };

    if (config.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(config.body);
    }

    return fetch(API_BASE + path, init).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (payload) {
          if (!response.ok || !payload || payload.success === false) {
            var message =
              (payload && payload.error && payload.error.message) ||
              "Error " + response.status + " del servidor";
            var error = new Error(message);
            error.status = response.status;
            throw error;
          }
          return payload.data;
        });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Mensajes y estados de la interfaz                                   */
  /* ------------------------------------------------------------------ */
  function showMessage(type, text) {
    el.message.className =
      "message " + (type === "success" ? "success-message" : "error-message");
    el.messageIcon.textContent = type === "success" ? "\u2713" : "\u26a0";
    el.messageText.textContent = text;
    show(el.message);
  }

  function hideMessage() {
    hide(el.message);
  }

  function setHelpText(text) {
    el.helpText.textContent = text || HELP_DEFAULT;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.url.disabled = busy;
    el.infoBtn.disabled = busy;
    el.downloadBtn.disabled = busy;
    el.downloadBtn.textContent = busy ? "Descargando..." : "Descargar";
  }

  /* ------------------------------------------------------------------ */
  /* Barra de progreso                                                   */
  /* ------------------------------------------------------------------ */
  /*
   * La API responde una sola vez, al terminar la descarga, asi que el
   * porcentaje se estima: avanza rapido al principio y se frena cerca del
   * 90 % hasta que llega la respuesta real del servidor.
   */
  var PROGRESS_PHASES = [
    { until: 20, label: "Consultando", status: "Obteniendo los datos del video..." },
    { until: 65, label: "Descargando", status: "Descargando desde YouTube..." },
    { until: 90, label: "Procesando", status: "Convirtiendo el archivo..." },
    { until: 101, label: "Guardando", status: "Guardando en la carpeta de descargas..." }
  ];

  function paintProgress(percent, phase) {
    var value = Math.min(100, Math.max(0, Math.round(percent)));
    el.progressFill.style.width = value + "%";
    el.progressValue.textContent = value + "%";
    if (phase) {
      el.progressLabel.textContent = phase.label;
      el.progressStatus.textContent = phase.status;
    }
  }

  function startProgress(tracks) {
    stopProgress();
    show(el.progressSection);
    paintProgress(0, PROGRESS_PHASES[0]);

    // Un lote tarda ~N veces mas que una pista suelta: la estimacion se frena
    // proporcionalmente para no plantarse en el 92 % desde el primer minuto.
    var lote = tracks > 1 ? tracks : 1;
    var freno = 22 * lote;
    var etiqueta = tracks > 1 ? " (" + tracks + " pistas)" : "";

    var percent = 0;
    state.progressTimer = window.setInterval(function () {
      // Avance decreciente: nunca alcanza el 100 % por su cuenta.
      percent += Math.max(0.4 / lote, (92 - percent) / freno);
      var phase = PROGRESS_PHASES.find(function (item) {
        return percent < item.until;
      });
      if (phase && etiqueta) {
        phase = { label: phase.label, status: phase.status + etiqueta };
      }
      paintProgress(percent, phase);
    }, 320);
  }

  function stopProgress() {
    if (state.progressTimer) {
      window.clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
  }

  function finishProgress(success) {
    stopProgress();
    if (!success) {
      hide(el.progressSection);
      return;
    }
    paintProgress(100, {
      label: "Completado",
      status: "El archivo ya esta en tu carpeta de descargas."
    });
    window.setTimeout(function () {
      hide(el.progressSection);
      paintProgress(0, PROGRESS_PHASES[0]);
    }, 2200);
  }

  /* ------------------------------------------------------------------ */
  /* Informacion del video                                               */
  /* ------------------------------------------------------------------ */
  function renderVideoInfo(info) {
    el.videoTitle.textContent = info.title || "Sin titulo";
    el.videoAuthor.textContent = info.author || "Desconocido";
    el.videoDuration.textContent =
      info.duration_formatted || formatDuration(info.duration);

    if (info.thumbnail) {
      el.videoThumb.src = info.thumbnail;
      el.videoThumb.alt = "Miniatura de " + (info.title || "el video");
      show(el.videoThumb);
    } else {
      el.videoThumb.removeAttribute("src");
      hide(el.videoThumb);
    }

    show(el.videoInfo);
  }

  function clearVideoInfo() {
    hide(el.videoInfo);
    el.videoThumb.removeAttribute("src");
  }

  /* ------------------------------------------------------------------ */
  /* Informacion de la lista                                             */
  /* ------------------------------------------------------------------ */
  function renderPlaylistInfo(info) {
    state.playlist = info;

    el.playlistTitle.textContent = info.title;
    el.playlistCount.textContent = String(info.count);
    el.playlistAuthors.textContent = String(info.authors);
    el.playlistDuration.textContent = info.total_duration_formatted;

    el.playlistTracks.innerHTML = "";
    var fragment = document.createDocumentFragment();
    info.entries.slice(0, TRACKS_PREVIEW).forEach(function (track) {
      var li = document.createElement("li");
      var pos = document.createElement("span");
      pos.textContent = track.position + ".";
      var title = document.createElement("span");
      title.textContent = track.title;
      title.title = track.title;
      var dur = document.createElement("span");
      dur.textContent = track.duration_formatted;
      li.append(pos, title, dur);
      fragment.appendChild(li);
    });
    if (info.count > TRACKS_PREVIEW) {
      var li = document.createElement("li");
      var resto = document.createElement("span");
      resto.textContent = "";
      var texto = document.createElement("span");
      texto.textContent = "y " + (info.count - TRACKS_PREVIEW) + " pistas mas";
      li.append(resto, texto);
      fragment.appendChild(li);
    }
    el.playlistTracks.appendChild(fragment);

    if (info.is_radio) {
      el.playlistNote.textContent =
        "Es una radio que YouTube genera automaticamente, no una lista publicada:" +
        " cambia en cada sesion y no se descarga en bloque. Puedes descargar el" +
        " video suelto quitando el resto del enlace.";
      show(el.playlistNote);
    } else if (info.count > info.max_items) {
      el.playlistNote.textContent =
        "Se descargaran las primeras " + info.max_items + " pistas. El limite se" +
        " ajusta con PLAYLIST_MAX_ITEMS en el .env.";
      show(el.playlistNote);
    } else {
      hide(el.playlistNote);
    }

    show(el.playlistInfo);
    updateDownloadButton();
  }

  function clearPlaylistInfo() {
    state.playlist = null;
    hide(el.playlistInfo);
    hide(el.playlistNote);
    el.playlistTracks.innerHTML = "";
    updateDownloadButton();
  }

  /** El boton principal refleja si se va a bajar un video o una lista. */
  function updateDownloadButton() {
    var lista = state.playlist;
    if (lista && lista.downloadable) {
      var total = Math.min(lista.count, lista.max_items);
      el.downloadBtn.textContent = "Descargar lista (" + total + ")";
    } else {
      el.downloadBtn.textContent = "Descargar";
    }
  }

  function loadVideoInfo() {
    var url = el.url.value.trim();

    if (!isValidUrl(url)) {
      setHelpText("Introduce un enlace valido de YouTube (video o lista).");
      el.url.focus();
      return Promise.resolve(null);
    }

    setHelpText(null);
    hideMessage();
    el.infoBtn.disabled = true;
    el.infoBtn.textContent = "Buscando...";

    var tareas = [];

    // Un enlace puede traer video y lista a la vez: se consultan los dos.
    tareas.push(
      isVideoUrl(url)
        ? request("/video-info", { method: "POST", body: { url: url } })
            .then(renderVideoInfo)
            .catch(function (error) {
              clearVideoInfo();
              throw error;
            })
        : Promise.resolve(clearVideoInfo())
    );

    tareas.push(
      playlistIdOf(url)
        ? request("/playlist-info", { method: "POST", body: { url: url } })
            .then(renderPlaylistInfo)
            .catch(function (error) {
              clearPlaylistInfo();
              // Una lista ilegible no impide descargar el video suelto.
              if (isVideoUrl(url)) {
                showMessage("error", "No se pudo leer la lista: " + error.message);
                return null;
              }
              throw error;
            })
        : Promise.resolve(clearPlaylistInfo())
    );

    return Promise.all(tareas)
      .catch(function (error) {
        showMessage("error", error.message);
      })
      .then(function () {
        el.infoBtn.disabled = false;
        el.infoBtn.textContent = "Ver info";
      });
  }

  /* ------------------------------------------------------------------ */
  /* Descarga                                                            */
  /* ------------------------------------------------------------------ */
  function selectedFormat() {
    var checked = el.form.querySelector('input[name="format"]:checked');
    return checked ? checked.value : "mp3";
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (state.busy) return;

    var url = el.url.value.trim();
    var format = selectedFormat();

    if (!isValidUrl(url)) {
      setHelpText("Introduce un enlace valido de YouTube.");
      el.url.focus();
      return;
    }

    if (!isVideoUrl(url) && !(state.playlist && state.playlist.downloadable)) {
      showMessage(
        "error",
        state.playlist && state.playlist.is_radio
          ? "Esa lista es una radio generada por YouTube y no se descarga en bloque."
          : "Pulsa \"Ver info\" para comprobar el contenido de la lista antes de descargar."
      );
      return;
    }

    if (format === "mp3" && !state.ffmpeg) {
      showMessage(
        "error",
        "ffmpeg no esta instalado, asi que no se puede generar el MP3. " +
          "Instalalo y reinicia el servidor."
      );
      return;
    }

    var lista = state.playlist;
    var enLote = Boolean(lista && lista.downloadable);

    setHelpText(null);
    hideMessage();
    setBusy(true);
    startProgress(enLote ? Math.min(lista.count, lista.max_items) : 0);

    var peticion = enLote
      ? request("/download-playlist", {
          method: "POST",
          body: { url: url, format: format }
        }).then(resumenDeLote)
      : request("/download", {
          method: "POST",
          body: { url: url, format: format }
        }).then(function (entry) {
          return {
            tipo: "success",
            texto:
              entry.title +
              " (" +
              entry.format.toUpperCase() +
              ", " +
              entry.size_formatted +
              ") se descargo correctamente."
          };
        });

    peticion
      .then(function (resultado) {
        finishProgress(true);
        showMessage(resultado.tipo, resultado.texto);
        return loadHistory();
      })
      .catch(function (error) {
        finishProgress(false);
        showMessage("error", error.message);
      })
      .then(function () {
        setBusy(false);
      });
  }

  /** Convierte el resumen del lote en un mensaje legible. */
  function resumenDeLote(data) {
    var partes = [data.downloaded.length + " descargada(s)"];
    if (data.skipped.length) partes.push(data.skipped.length + " ya estaban");
    if (data.failed.length) partes.push(data.failed.length + " fallaron");

    var texto =
      '"' + data.playlist.title + '": ' + partes.join(", ") + ".";

    if (data.truncated) {
      texto +=
        " La lista tiene " + data.playlist.count + " pistas y el limite por" +
        " descarga es " + data.limit + ": vuelve a pulsar para continuar.";
    }
    if (data.failed.length) {
      texto += " Primer fallo: " + data.failed[0].reason;
    }

    return {
      tipo: data.downloaded.length ? "success" : "error",
      texto: texto
    };
  }

  /* ------------------------------------------------------------------ */
  /* Vaciar el historial                                                 */
  /* ------------------------------------------------------------------ */
  function clearHistory() {
    var confirmado = window.confirm(
      "Se eliminaran del disco TODOS los archivos descargados. " +
        "Esta accion no se puede deshacer."
    );
    if (!confirmado) return;

    el.clearHistoryBtn.disabled = true;
    request("/history", { method: "DELETE" })
      .then(function (data) {
        var texto = data.count + " archivo(s) eliminado(s).";
        if (data.failed.length) {
          texto += " " + data.failed.length + " no se pudieron borrar: " +
            data.failed[0].reason;
        }
        showMessage(data.failed.length ? "error" : "success", texto);
        return loadHistory();
      })
      .catch(function (error) {
        showMessage("error", error.message);
      })
      .then(function () {
        el.clearHistoryBtn.disabled = false;
      });
  }

  /* ------------------------------------------------------------------ */
  /* Historial                                                           */
  /* ------------------------------------------------------------------ */
  function buildHistoryItem(entry) {
    var node = el.template.content.firstElementChild.cloneNode(true);
    var pick = function (role) {
      return node.querySelector('[data-role="' + role + '"]');
    };

    node.dataset.filename = entry.filename;
    pick("filename").textContent = entry.filename;

    var meta = [(entry.format || "").toUpperCase(), entry.size_formatted];
    if (entry.duration_formatted) meta.push(entry.duration_formatted);
    var date = formatDate(entry.downloaded_at);
    if (date) meta.push(date);
    pick("meta").textContent = meta.filter(Boolean).join(" \u00b7 ");

    var link = pick("download");
    link.href = API_BASE + "/download-file/" + encodeURIComponent(entry.filename);
    link.setAttribute("download", entry.filename);

    return node;
  }

  function renderHistory(items) {
    el.historyList.innerHTML = "";

    if (items.length === 0) {
      show(el.historyEmpty);
      return;
    }
    hide(el.historyEmpty);

    var fragment = document.createDocumentFragment();
    items.forEach(function (entry) {
      fragment.appendChild(buildHistoryItem(entry));
    });
    el.historyList.appendChild(fragment);
  }

  function loadHistory() {
    return request("/history")
      .then(function (data) {
        renderHistory(data.items || []);
      })
      .catch(function (error) {
        showMessage("error", "No se pudo cargar el historial: " + error.message);
      });
  }

  function deleteEntry(filename, item) {
    var confirmed = window.confirm(
      'Se eliminara "' + filename + '" del disco. Esta accion no se puede deshacer.'
    );
    if (!confirmed) return;

    request("/delete/" + encodeURIComponent(filename), { method: "DELETE" })
      .then(function () {
        hideMessage();
        return loadHistory();
      })
      .catch(function (error) {
        showMessage("error", error.message);
      });
  }

  function handleHistoryClick(event) {
    var button = event.target.closest('[data-role="delete"]');
    if (!button) return;
    var item = button.closest(".history-item");
    if (!item) return;
    deleteEntry(item.dataset.filename, item);
  }

  /* ------------------------------------------------------------------ */
  /* Estado del servidor                                                 */
  /* ------------------------------------------------------------------ */
  function checkHealth() {
    return request("/health", { method: "POST" })
      .then(function (data) {
        state.ffmpeg = Boolean(data.ffmpeg);
        if (!state.ffmpeg) {
          showMessage(
            "error",
            "ffmpeg no esta instalado. YouTube entrega el video y el audio por " +
              "separado, asi que hace falta para el MP3 y para la mayoria de los " +
              "MP4. Consulta el README para instalarlo y reinicia el servidor."
          );
        }
      })
      .catch(function (error) {
        showMessage("error", "No hay conexion con el servidor: " + error.message);
      });
  }

  /* ------------------------------------------------------------------ */
  /* Arranque                                                            */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    el.form.addEventListener("submit", handleSubmit);
    el.infoBtn.addEventListener("click", loadVideoInfo);
    el.historyList.addEventListener("click", handleHistoryClick);
    el.clearHistoryBtn.addEventListener("click", clearHistory);

    // Al cambiar la URL, la informacion mostrada deja de ser valida.
    el.url.addEventListener("input", function () {
      setHelpText(null);
      clearVideoInfo();
      clearPlaylistInfo();
    });

    // Enter en el campo de URL consulta la informacion en vez de enviar.
    el.url.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      loadVideoInfo();
    });

    // Al pegar un enlace valido, se consulta la informacion automaticamente.
    el.url.addEventListener("paste", function (event) {
      var pasted = (event.clipboardData || window.clipboardData).getData("text");
      if (!isValidUrl(pasted)) return;
      window.setTimeout(function () {
        if (!state.busy) loadVideoInfo();
      }, 60);
    });

    // Evita cerrar la pestana en mitad de una descarga.
    window.addEventListener("beforeunload", function (event) {
      if (!state.busy) return undefined;
      event.preventDefault();
      event.returnValue = "";
      return "";
    });
  }

  function init() {
    bindEvents();
    checkHealth();
    loadHistory();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
