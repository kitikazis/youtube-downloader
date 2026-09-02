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

  var PLACEHOLDER_THUMB =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">' +
        '<rect width="160" height="90" fill="#282828"/>' +
        '<path d="M68 32v26l22-13z" fill="#ff0000"/></svg>'
    );

  /* ------------------------------------------------------------------ */
  /* Referencias al DOM                                                  */
  /* ------------------------------------------------------------------ */
  var el = {
    form: document.getElementById("downloadForm"),
    url: document.getElementById("urlInput"),
    urlGroup: document.querySelector(".input-group"),
    urlHint: document.getElementById("urlHint"),
    infoBtn: document.getElementById("infoBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    videoInfo: document.getElementById("videoInfo"),
    videoThumb: document.getElementById("videoThumb"),
    videoTitle: document.getElementById("videoTitle"),
    videoAuthor: document.getElementById("videoAuthor"),
    videoDuration: document.getElementById("videoDuration"),
    videoChips: document.getElementById("videoChips"),
    progress: document.getElementById("progress"),
    progressBar: document.getElementById("progressBar"),
    progressTrack: document.getElementById("progressTrack"),
    progressLabel: document.getElementById("progressLabel"),
    progressValue: document.getElementById("progressValue"),
    alert: document.getElementById("alert"),
    alertIcon: document.querySelector(".alert__icon"),
    alertTitle: document.getElementById("alertTitle"),
    alertText: document.getElementById("alertText"),
    alertClose: document.getElementById("alertClose"),
    historyList: document.getElementById("historyList"),
    historyEmpty: document.getElementById("historyEmpty"),
    historyCount: document.getElementById("historyCount"),
    refreshBtn: document.getElementById("refreshHistoryBtn"),
    serverStatus: document.getElementById("serverStatus"),
    template: document.getElementById("historyItemTemplate")
  };

  var state = {
    videoInfo: null,
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

  function formatNumber(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return null;
    return number.toLocaleString("es-ES");
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
  /* Mensajes y estados de UI                                            */
  /* ------------------------------------------------------------------ */
  var ALERT_ICONS = { success: "\u2713", error: "!", info: "i" };

  function showAlert(type, title, text) {
    el.alert.className = "alert alert--" + type;
    el.alertIcon.textContent = ALERT_ICONS[type] || "i";
    el.alertTitle.textContent = title;
    el.alertText.textContent = text || "";
    el.alert.hidden = false;
  }

  function hideAlert() {
    el.alert.hidden = true;
  }

  function setButtonLoading(button, loading) {
    button.classList.toggle("is-loading", loading);
    button.disabled = loading;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.url.disabled = busy;
    el.infoBtn.disabled = busy;
    setButtonLoading(el.downloadBtn, busy);
  }

  function setFieldError(message) {
    el.urlHint.textContent =
      message || "Admite enlaces de youtube.com, youtu.be y Shorts.";
    el.urlHint.classList.toggle("field__hint--error", Boolean(message));
    el.urlGroup.classList.toggle("input-group--error", Boolean(message));
  }

  function setServerStatus(variant, text, title) {
    el.serverStatus.className = "status-pill status-pill--" + variant;
    el.serverStatus.querySelector(".status-pill__text").textContent = text;
    el.serverStatus.title = title || text;
  }

  /* ------------------------------------------------------------------ */
  /* Barra de progreso                                                   */
  /* ------------------------------------------------------------------ */
  /*
   * La API responde una sola vez al terminar la descarga, asi que el
   * porcentaje se estima: avanza rapido al principio y se frena cerca del
   * 90 % hasta que llega la respuesta real del servidor.
   */
  var PROGRESS_PHASES = [
    { until: 20, label: "Consultando el video..." },
    { until: 65, label: "Descargando desde YouTube..." },
    { until: 90, label: "Procesando y convirtiendo..." },
    { until: 100, label: "Guardando archivo..." }
  ];

  function paintProgress(percent, label) {
    var value = Math.min(100, Math.max(0, Math.round(percent)));
    el.progressBar.style.width = value + "%";
    el.progressValue.textContent = value + "%";
    el.progressTrack.setAttribute("aria-valuenow", String(value));
    if (label) el.progressLabel.textContent = label;
  }

  function startProgress() {
    stopProgress();
    el.progress.hidden = false;
    el.progress.classList.remove("is-done");
    paintProgress(0, PROGRESS_PHASES[0].label);

    var percent = 0;
    state.progressTimer = window.setInterval(function () {
      // Avance decreciente: nunca alcanza el 100 % por su cuenta.
      percent += Math.max(0.4, (92 - percent) / 22);
      var phase = PROGRESS_PHASES.find(function (item) {
        return percent < item.until;
      });
      paintProgress(percent, phase ? phase.label : null);
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
      el.progress.hidden = true;
      return;
    }
    el.progress.classList.add("is-done");
    paintProgress(100, "Descarga completada");
    window.setTimeout(function () {
      el.progress.hidden = true;
      el.progress.classList.remove("is-done");
      paintProgress(0, PROGRESS_PHASES[0].label);
    }, 2200);
  }

  /* ------------------------------------------------------------------ */
  /* Informacion del video                                               */
  /* ------------------------------------------------------------------ */
  function renderVideoInfo(info) {
    state.videoInfo = info;

    el.videoThumb.src = info.thumbnail || PLACEHOLDER_THUMB;
    el.videoThumb.alt = "Miniatura de " + (info.title || "el video");
    el.videoTitle.textContent = info.title || "Sin titulo";
    el.videoAuthor.textContent = info.author || "Desconocido";
    el.videoDuration.textContent =
      info.duration_formatted || formatDuration(info.duration);

    var chips = [];
    var views = formatNumber(info.views);
    if (views) chips.push(views + " visitas");
    if (info.upload_date) chips.push("Publicado el " + info.upload_date);
    if (info.is_live) chips.push("En directo");

    el.videoChips.innerHTML = "";
    chips.forEach(function (text) {
      var item = document.createElement("li");
      item.textContent = text;
      el.videoChips.appendChild(item);
    });

    el.videoInfo.hidden = false;
  }

  function clearVideoInfo() {
    state.videoInfo = null;
    el.videoInfo.hidden = true;
    el.videoThumb.removeAttribute("src");
    el.videoChips.innerHTML = "";
  }

  function loadVideoInfo() {
    var url = el.url.value.trim();

    if (!isValidUrl(url)) {
      setFieldError("Introduce un enlace valido de YouTube.");
      el.url.focus();
      return Promise.resolve(null);
    }

    setFieldError(null);
    hideAlert();
    setButtonLoading(el.infoBtn, true);

    return request("/video-info", { method: "POST", body: { url: url } })
      .then(function (info) {
        renderVideoInfo(info);
        return info;
      })
      .catch(function (error) {
        clearVideoInfo();
        showAlert("error", "No se pudo obtener la informacion", error.message);
        return null;
      })
      .then(function (info) {
        setButtonLoading(el.infoBtn, false);
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
      setFieldError("Introduce un enlace valido de YouTube.");
      el.url.focus();
      return;
    }

    if (format === "mp3" && !state.ffmpeg) {
      showAlert(
        "error",
        "ffmpeg no esta disponible",
        "Instala ffmpeg y reinicia el servidor para convertir a MP3, o elige MP4."
      );
      return;
    }

    setFieldError(null);
    hideAlert();
    setBusy(true);
    startProgress();

    request("/download", { method: "POST", body: { url: url, format: format } })
      .then(function (entry) {
        finishProgress(true);
        showAlert(
          "success",
          "Descarga completada",
          entry.title +
            " (" +
            entry.format.toUpperCase() +
            ", " +
            entry.size_formatted +
            ") ya esta en tu carpeta de descargas."
        );
        return loadHistory();
      })
      .catch(function (error) {
        finishProgress(false);
        showAlert("error", "No se pudo descargar", error.message);
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

    var thumb = pick("thumb");
    thumb.src = entry.thumbnail || PLACEHOLDER_THUMB;
    thumb.alt = "";

    pick("format").textContent = (entry.format || "").toUpperCase();
    pick("title").textContent = entry.title || entry.filename;
    pick("title").title = entry.filename;

    var meta = [entry.size_formatted];
    if (entry.duration_formatted) meta.push(entry.duration_formatted);
    if (entry.author && entry.author !== "Desconocido") meta.push(entry.author);
    var date = formatDate(entry.downloaded_at);
    if (date) meta.push(date);
    pick("meta").textContent = meta.filter(Boolean).join("  \u00b7  ");

    var link = pick("download");
    link.href = API_BASE + "/download-file/" + encodeURIComponent(entry.filename);
    link.setAttribute("download", entry.filename);

    return node;
  }

  function renderHistory(items) {
    el.historyList.innerHTML = "";
    el.historyCount.textContent = String(items.length);
    el.historyEmpty.hidden = items.length > 0;

    var fragment = document.createDocumentFragment();
    items.forEach(function (entry) {
      fragment.appendChild(buildHistoryItem(entry));
    });
    el.historyList.appendChild(fragment);
  }

  function loadHistory() {
    setButtonLoading(el.refreshBtn, true);
    return request("/history")
      .then(function (data) {
        renderHistory(data.items || []);
      })
      .catch(function (error) {
        showAlert("error", "No se pudo cargar el historial", error.message);
      })
      .then(function () {
        setButtonLoading(el.refreshBtn, false);
      });
  }

  function deleteEntry(filename, item) {
    var confirmed = window.confirm(
      'Se eliminara "' + filename + '" del disco. Esta accion no se puede deshacer.'
    );
    if (!confirmed) return;

    item.classList.add("is-removing");

    request("/delete/" + encodeURIComponent(filename), { method: "DELETE" })
      .then(function () {
        showAlert("info", "Archivo eliminado", filename);
        return loadHistory();
      })
      .catch(function (error) {
        item.classList.remove("is-removing");
        showAlert("error", "No se pudo eliminar", error.message);
      });
  }

  function handleHistoryClick(event) {
    var button = event.target.closest('[data-role="delete"]');
    if (!button) return;
    var item = button.closest(".history__item");
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
        if (state.ffmpeg) {
          setServerStatus(
            "ok",
            "Servidor listo",
            "yt-dlp " + (data.yt_dlp || "") + " | ffmpeg disponible"
          );
        } else {
          setServerStatus(
            "warn",
            "Sin ffmpeg",
            "ffmpeg no esta instalado: MP3 no disponible"
          );
          showAlert(
            "info",
            "ffmpeg no esta instalado",
            "YouTube entrega el video y el audio por separado, asi que ffmpeg es" +
              " necesario para el MP3 y para la mayoria de los MP4. Consulta el" +
              " README para instalarlo y reinicia el servidor."
          );
        }
      })
      .catch(function (error) {
        setServerStatus("error", "Sin conexion", error.message);
      });
  }

  /* ------------------------------------------------------------------ */
  /* Arranque                                                            */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    el.form.addEventListener("submit", handleSubmit);
    el.infoBtn.addEventListener("click", loadVideoInfo);
    el.refreshBtn.addEventListener("click", loadHistory);
    el.alertClose.addEventListener("click", hideAlert);
    el.historyList.addEventListener("click", handleHistoryClick);

    // Al cambiar la URL, la informacion mostrada deja de ser valida.
    el.url.addEventListener("input", function () {
      setFieldError(null);
      if (state.videoInfo) clearVideoInfo();
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
