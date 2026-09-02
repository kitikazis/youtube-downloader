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

  var HELP_DEFAULT = "Admite enlaces de youtube.com, youtu.be y Shorts.";

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
    ffmpeg: true
  };

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

  function isValidUrl(value) {
    return YOUTUBE_RE.test(String(value || "").trim());
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

  function startProgress() {
    stopProgress();
    show(el.progressSection);
    paintProgress(0, PROGRESS_PHASES[0]);

    var percent = 0;
    state.progressTimer = window.setInterval(function () {
      // Avance decreciente: nunca alcanza el 100 % por su cuenta.
      percent += Math.max(0.4, (92 - percent) / 22);
      var phase = PROGRESS_PHASES.find(function (item) {
        return percent < item.until;
      });
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

  function loadVideoInfo() {
    var url = el.url.value.trim();

    if (!isValidUrl(url)) {
      setHelpText("Introduce un enlace valido de YouTube.");
      el.url.focus();
      return Promise.resolve(null);
    }

    setHelpText(null);
    hideMessage();
    el.infoBtn.disabled = true;
    el.infoBtn.textContent = "Buscando...";

    return request("/video-info", { method: "POST", body: { url: url } })
      .then(function (info) {
        renderVideoInfo(info);
        return info;
      })
      .catch(function (error) {
        clearVideoInfo();
        showMessage("error", error.message);
        return null;
      })
      .then(function (info) {
        el.infoBtn.disabled = false;
        el.infoBtn.textContent = "Ver info";
        return info;
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

    if (format === "mp3" && !state.ffmpeg) {
      showMessage(
        "error",
        "ffmpeg no esta instalado, asi que no se puede generar el MP3. " +
          "Instalalo y reinicia el servidor."
      );
      return;
    }

    setHelpText(null);
    hideMessage();
    setBusy(true);
    startProgress();

    request("/download", { method: "POST", body: { url: url, format: format } })
      .then(function (entry) {
        finishProgress(true);
        showMessage(
          "success",
          entry.title +
            " (" +
            entry.format.toUpperCase() +
            ", " +
            entry.size_formatted +
            ") se descargo correctamente."
        );
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

    // Al cambiar la URL, la informacion mostrada deja de ser valida.
    el.url.addEventListener("input", function () {
      setHelpText(null);
      clearVideoInfo();
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
